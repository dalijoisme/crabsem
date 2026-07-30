// controllers/authController.js - thin HTTP layer for user
// authentication (Sprint A, Goal 2 + Auth & Onboarding sprint). POST
// /auth/login, /auth/register, /auth/verify-email, and
// /auth/forgot-password/reset-password are NOT gated by
// middleware/userAuth.js (see routes/v1/auth.js) - you need one of
// these to get a token in the first place, same pattern as
// controllers/adminController.js's own login handler.

const userAuthService = require("../services/userAuthService");
const { sendSuccess, sendError } = require("../utils/apiResponse");

async function register(req, res, next){

    try{

        const { name, email, password } = req.body || {};
        const result = userAuthService.register(name, email, password);

        if(!result.ok) return sendError(res, result.status, result.error, result.details);

        sendSuccess(res, { userId: result.userId, devVerificationLink: result.devVerificationLink });

    }
    catch(err){ next(err); }

}

async function login(req, res, next){

    try{

        const { email, password } = req.body || {};
        const result = userAuthService.login(email, password);

        if(!result.ok) return sendError(res, result.status, result.error, result.details);

        sendSuccess(res, { token: result.token });

    }
    catch(err){ next(err); }

}

async function logout(req, res, next){

    try{

        const token = req.headers["x-auth-token"];
        userAuthService.logout(token);
        sendSuccess(res, { loggedOut: true });

    }
    catch(err){ next(err); }

}

async function verifyEmail(req, res, next){

    try{

        const { token } = req.body || {};
        const result = userAuthService.verifyEmail(token);

        if(!result.ok) return sendError(res, result.status, result.error, result.details);

        sendSuccess(res, { verified: true });

    }
    catch(err){ next(err); }

}

// Authed - req.user.id comes from middleware/userAuth.js.
async function resendVerification(req, res, next){

    try{

        const result = userAuthService.resendVerification(req.user.id);

        if(!result.ok) return sendError(res, result.status, result.error, result.details);

        sendSuccess(res, { sent: true, devVerificationLink: result.devVerificationLink });

    }
    catch(err){ next(err); }

}

async function forgotPassword(req, res, next){

    try{

        const { email } = req.body || {};
        const result = userAuthService.requestPasswordReset(email);

        if(!result.ok) return sendError(res, result.status, result.error, result.details);

        sendSuccess(res, { sent: true, devResetLink: result.devResetLink });

    }
    catch(err){ next(err); }

}

async function resetPassword(req, res, next){

    try{

        const { token, newPassword } = req.body || {};
        const result = userAuthService.resetPassword(token, newPassword);

        if(!result.ok) return sendError(res, result.status, result.error, result.details);

        sendSuccess(res, { reset: true });

    }
    catch(err){ next(err); }

}

module.exports = { register, login, logout, verifyEmail, resendVerification, forgotPassword, resetPassword };
