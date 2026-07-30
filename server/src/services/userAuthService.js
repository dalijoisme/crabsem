// services/userAuthService.js - Sprint A, Goal 2 (auth/multi-tenancy
// foundation). A real, separate account system for the trading bot
// domain - modeled on services/adminAuthService.js's own token-issuing
// pattern (crypto.randomBytes(32).toString("hex")), but DB-persisted
// (repositories/userSessionRepository.js) instead of an in-memory Map,
// and with real password hashing instead of one shared operational
// password. Fully independent of adminAuthService.js/ADMIN_PASSWORD -
// no cross-references either direction.
//
// Password hashing: Node's built-in crypto.scrypt (OWASP-approved KDF),
// not bcrypt/argon2 - this codebase has zero auth dependencies today
// and scrypt needs no native module to add. Stored as "saltHex:keyHex"
// so verification never needs a separate salt column.
//
// register() is deliberately a clean, directly-callable function (not
// wired to any public route yet - see routes/v1/auth.js) so that
// exposing self-service registration later is a routing change only,
// not a redesign, matching the explicit CTO decision for Sprint A
// (admin-provisioned accounts only, forward-compatible).

const crypto = require("crypto");
const userRepository = require("../repositories/userRepository");
const userSessionRepository = require("../repositories/userSessionRepository");
const tradingBotRepository = require("../repositories/tradingBotRepository");
const emailVerificationTokenRepository = require("../repositories/emailVerificationTokenRepository");
const passwordResetTokenRepository = require("../repositories/passwordResetTokenRepository");
const emailService = require("./emailService");
const config = require("../config/env");

const SCRYPT_KEYLEN = 64;
const SESSION_TTL_MS = 30 * 24 * 60 * 60 * 1000; // 30 days - see file header for why this differs from admin's 24h
const EMAIL_VERIFICATION_TTL_MS = 24 * 60 * 60 * 1000; // 24 hours
const PASSWORD_RESET_TTL_MS = 60 * 60 * 1000; // 1 hour - shorter than verification, this grants account takeover if leaked

function toSqliteTimestamp(date){
    return date.toISOString().slice(0, 19).replace("T", " ");
}

// Builds an absolute link when FRONTEND_URL is configured, otherwise a
// relative path + raw token - see config/env.js's FRONTEND_URL comment
// for why an unset origin is a real, honest state here, not an error.
function buildFrontendLink(path, token){
    const query = `?token=${token}`;
    return config.FRONTEND_URL ? `${config.FRONTEND_URL}${path}${query}` : `${path}${query}`;
}

function hashPassword(password){
    const salt = crypto.randomBytes(16).toString("hex");
    const derivedKey = crypto.scryptSync(password, salt, SCRYPT_KEYLEN);
    return `${salt}:${derivedKey.toString("hex")}`;
}

function verifyPassword(password, storedHash){
    const [salt, keyHex] = storedHash.split(":");
    const derivedKey = crypto.scryptSync(password, salt, SCRYPT_KEYLEN);
    const storedKey = Buffer.from(keyHex, "hex");
    // timingSafeEqual requires equal-length buffers - a length mismatch
    // is simply "not a match", never a crash or a timing leak.
    if(derivedKey.length !== storedKey.length) return false;
    return crypto.timingSafeEqual(derivedKey, storedKey);
}

function issueEmailVerificationLink(userId, email){
    const token = crypto.randomBytes(32).toString("hex");
    const expiresAt = toSqliteTimestamp(new Date(Date.now() + EMAIL_VERIFICATION_TTL_MS));
    emailVerificationTokenRepository.insertToken({ token, userId, expiresAt });
    const link = buildFrontendLink("/verify-email.html", token);
    emailService.sendVerificationEmail(email, link);
    return link;
}

// name is optional at the service layer (Profile just shows "-" if
// absent) - the frontend Register form requires it, but this function
// stays usable for any future admin-provisioned account creation the
// same way it always has.
function register(name, email, password){

    if(!email || !password) return { ok: false, status: 400, error: "Bad request", details: "email and password are required." };
    if(password.length < 8) return { ok: false, status: 400, error: "Bad request", details: "password must be at least 8 characters." };

    if(userRepository.findByEmail(email)){
        return { ok: false, status: 409, error: "Conflict", details: "An account with this email already exists." };
    }

    const passwordHash = hashPassword(password);
    const userId = userRepository.insertUser({ email, passwordHash, fullName: name || null });
    tradingBotRepository.ensureBotForUser(userId); // every user has exactly one bot row from day one

    const devVerificationLink = issueEmailVerificationLink(userId, email);

    return {
        ok: true,
        userId,
        // Only present outside production - see emailService.js's
        // header for why this is the whole point of the dev-mode stub.
        devVerificationLink: config.NODE_ENV !== "production" ? devVerificationLink : undefined
    };

}

function verifyEmail(token){

    if(!token) return { ok: false, status: 400, error: "Bad request", details: "token is required." };

    const row = emailVerificationTokenRepository.findValidToken(token);
    if(!row) return { ok: false, status: 400, error: "Bad request", details: "This verification link is invalid or has expired." };

    userRepository.markEmailVerified(row.user_id);
    emailVerificationTokenRepository.deleteAllForUser(row.user_id); // consume every outstanding link for this user, not just this one

    return { ok: true, userId: row.user_id };

}

function resendVerification(userId){

    const user = userRepository.findById(userId);
    if(!user) return { ok: false, status: 404, error: "Not found", details: "No such account." };
    if(user.email_verified) return { ok: false, status: 400, error: "Bad request", details: "Email is already verified." };

    emailVerificationTokenRepository.deleteAllForUser(userId); // one live link at a time
    const devVerificationLink = issueEmailVerificationLink(userId, user.email);

    return { ok: true, devVerificationLink: config.NODE_ENV !== "production" ? devVerificationLink : undefined };

}

// Always returns ok:true even when the account doesn't exist - no
// user-enumeration leak via response shape. The link is only actually
// issued/logged when the account is real.
function requestPasswordReset(email){

    if(!email) return { ok: false, status: 400, error: "Bad request", details: "email is required." };

    const user = userRepository.findByEmail(email);
    let devResetLink;

    if(user){
        const token = crypto.randomBytes(32).toString("hex");
        const expiresAt = toSqliteTimestamp(new Date(Date.now() + PASSWORD_RESET_TTL_MS));
        passwordResetTokenRepository.insertToken({ token, userId: user.id, expiresAt });
        const link = buildFrontendLink("/reset-password.html", token);
        emailService.sendPasswordResetEmail(email, link);
        devResetLink = link;
    }

    return { ok: true, devResetLink: (user && config.NODE_ENV !== "production") ? devResetLink : undefined };

}

function resetPassword(token, newPassword){

    if(!token || !newPassword) return { ok: false, status: 400, error: "Bad request", details: "token and newPassword are required." };
    if(newPassword.length < 8) return { ok: false, status: 400, error: "Bad request", details: "password must be at least 8 characters." };

    const row = passwordResetTokenRepository.findValidToken(token);
    if(!row) return { ok: false, status: 400, error: "Bad request", details: "This reset link is invalid, expired, or already used." };

    userRepository.updatePasswordHash(row.user_id, hashPassword(newPassword));
    passwordResetTokenRepository.markUsed(token);

    // Force re-login everywhere - a leaked/guessed old session token
    // must not survive a password reset (real security hygiene even
    // with dev-stub email delivery).
    userSessionRepository.deleteAllForUser(row.user_id);

    return { ok: true, userId: row.user_id };

}

function login(email, password){

    if(!email || !password) return { ok: false, status: 400, error: "Bad request", details: "email and password are required." };

    const user = userRepository.findByEmail(email);
    if(!user || !user.is_active || !verifyPassword(password, user.password_hash)){
        return { ok: false, status: 401, error: "Unauthorized", details: "Incorrect email or password." };
    }

    const token = crypto.randomBytes(32).toString("hex");
    const expiresAt = new Date(Date.now() + SESSION_TTL_MS).toISOString().slice(0, 19).replace("T", " ");
    userSessionRepository.insertSession({ token, userId: user.id, expiresAt });

    return { ok: true, token, userId: user.id };

}

function logout(token){
    userSessionRepository.deleteSession(token);
    return { ok: true };
}

// Mirrors adminAuthService.isValidToken's shape exactly, but DB-backed
// and returning the userId on success (adminAuthService's tokens prove
// only "someone knew the shared password" - these prove a specific
// tenant's identity, which middleware/userAuth.js attaches to req.user).
function validateSession(token){
    if(!token) return null;
    const session = userSessionRepository.findValidSession(token);
    return session ? session.user_id : null;
}

module.exports = { register, login, logout, validateSession, verifyEmail, resendVerification, requestPasswordReset, resetPassword };
