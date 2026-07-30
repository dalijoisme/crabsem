// scripts/createUser.js - internal account provisioning for local
// testing. Calls the exact same register() the public POST
// /auth/register route calls (Auth + Onboarding sprint), so this is
// never a second, divergent code path. Accounts created this way
// still land unverified (email_verified=0) like any real registration -
// use the devVerificationLink this prints, or call
// userAuthService.verifyEmail() directly, to unblock gated actions.
//
// Usage: node src/scripts/createUser.js <email> <password> [fullName]

const userAuthService = require("../services/userAuthService");

const [, , email, password, fullName] = process.argv;

if(!email || !password){
    console.error("Usage: node src/scripts/createUser.js <email> <password> [fullName]");
    process.exit(1);
}

const result = userAuthService.register(fullName || null, email, password);

if(!result.ok){
    console.error(`Failed: ${result.error} - ${result.details}`);
    process.exit(1);
}

console.log(`User created: id=${result.userId} email=${email}`);
if(result.devVerificationLink) console.log(`Verification link: ${result.devVerificationLink}`);
