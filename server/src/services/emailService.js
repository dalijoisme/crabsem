// services/emailService.js - Auth + Onboarding sprint. Dev-mode stub,
// per explicit product decision: this codebase has zero email
// infrastructure today (no SMTP/provider configured), so no real
// email is sent. Every link is logged here with a clear prefix, and
// the calling service (userAuthService.js) also returns it directly
// in the API response outside production - the whole verify/reset
// flow is clickable today without picking a mail provider. Swapping
// in a real one later means rewriting the two send* functions below
// to actually call that provider's API - nothing else in this
// codebase needs to change, since callers only ever see
// sendVerificationEmail/sendPasswordResetEmail, never a transport
// detail.

function sendVerificationEmail(email, link){
    console.log(`[DEV EMAIL STUB] Verification email for ${email}: ${link}`);
}

function sendPasswordResetEmail(email, link){
    console.log(`[DEV EMAIL STUB] Password reset email for ${email}: ${link}`);
}

module.exports = { sendVerificationEmail, sendPasswordResetEmail };
