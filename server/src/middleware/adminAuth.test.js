// middleware/adminAuth.test.js - admin-auth bug fix: proves the actual
// reported failure mode (a real, correct ADMIN_PASSWORD in server/.env
// still rejected as "Incorrect password"/401) is fixed by trimming
// incidental whitespace at the one canonical config read point
// (config/env.js) and at both comparison sites (this middleware and
// services/adminAuthService.js's login()), without weakening the
// "must be an exact match otherwise" contract.
//
// config/env.js/adminAuth.js/adminAuthService.js are required fresh
// (require.cache cleared) for each test that needs a specific
// process.env.ADMIN_PASSWORD - config.js reads process.env once, at
// require time, into a frozen object, so this is the only way to test
// different ADMIN_PASSWORD values without a live process.env available
// for every test file's own overlapping needs.
// Run with `node --test`.

const test = require("node:test");
const assert = require("node:assert/strict");

const CONFIG_PATH = require.resolve("../config/env");
const ADMIN_AUTH_PATH = require.resolve("./adminAuth");
const ADMIN_AUTH_SERVICE_PATH = require.resolve("../services/adminAuthService");

function freshModulesWithAdminPassword(envValue){

    const originalEnv = process.env.ADMIN_PASSWORD;

    // "" (never a real delete) represents "unset" here on purpose: this
    // repo's own real server/.env (this exact checkout) has a real
    // ADMIN_PASSWORD in it, and re-requiring config/env.js re-runs
    // dotenv.config() - which, per dotenv's own override:false default,
    // only SKIPS a key already present in process.env. A deleted key is
    // "not present" and would be silently reloaded from that real file,
    // making an actual "unset" state impossible to construct that way in
    // this environment. Setting "" keeps the key present (so dotenv's
    // populate() leaves it alone) while still trimming/falling through to
    // null via config.js's own ADMIN_PASSWORD line - the exact "unset"
    // behavior this helper needs.
    process.env.ADMIN_PASSWORD = envValue === undefined ? "" : envValue;

    delete require.cache[CONFIG_PATH];
    delete require.cache[ADMIN_AUTH_PATH];
    delete require.cache[ADMIN_AUTH_SERVICE_PATH];

    const config = require("../config/env");
    const adminAuth = require("./adminAuth");
    const adminAuthService = require("../services/adminAuthService");

    return {

        config, adminAuth, adminAuthService,

        restore(){

            if(originalEnv === undefined) delete process.env.ADMIN_PASSWORD;
            else process.env.ADMIN_PASSWORD = originalEnv;

            delete require.cache[CONFIG_PATH];
            delete require.cache[ADMIN_AUTH_PATH];
            delete require.cache[ADMIN_AUTH_SERVICE_PATH];

        }

    };

}

function fakeReqRes(headerValue){

    const req = { headers: headerValue === undefined ? {} : { "x-admin-key": headerValue } };
    const state = { statusCode: null, body: null, nextCalled: false };

    const res = {
        status(code){ state.statusCode = code; return this; },
        json(payload){ state.body = payload; return this; }
    };

    const next = () => { state.nextCalled = true; };

    return { req, res, next, state };

}

test("config.ADMIN_PASSWORD is trimmed of surrounding whitespace/newlines at the one canonical read point", () => {

    const mods = freshModulesWithAdminPassword("  real-secret-value  \n");

    try{
        assert.equal(mods.config.ADMIN_PASSWORD, "real-secret-value");
    }
    finally{
        mods.restore();
    }

});

test("config.ADMIN_PASSWORD is null (not empty string) when the env var is only whitespace - never a fabricated 'configured' state", () => {

    const mods = freshModulesWithAdminPassword("   \n");

    try{
        assert.equal(mods.config.ADMIN_PASSWORD, null);
    }
    finally{
        mods.restore();
    }

});

test("REPRODUCES THE REPORTED BUG then proves the fix: server/.env has a trailing newline on ADMIN_PASSWORD (byte-identical to a real, common .env-editing artifact) - login with the exact visible password must still succeed, not fail with 'Incorrect password'", () => {

    const mods = freshModulesWithAdminPassword("correct-horse-battery-staple\n");

    try{

        const result = mods.adminAuthService.login("correct-horse-battery-staple");
        assert.equal(result.ok, true, "a real, correctly-typed password must succeed even when the .env line it came from had a trailing newline artifact");
        assert.ok(result.token);

    }
    finally{
        mods.restore();
    }

});

test("login() also trims the SUBMITTED password - a copy/paste with incidental leading/trailing whitespace still succeeds", () => {

    const mods = freshModulesWithAdminPassword("correct-horse-battery-staple");

    try{

        const result = mods.adminAuthService.login("  correct-horse-battery-staple  ");
        assert.equal(result.ok, true);

    }
    finally{
        mods.restore();
    }

});

test("login() still rejects a genuinely wrong password - trimming never widens the match to a near-miss", () => {

    const mods = freshModulesWithAdminPassword("correct-horse-battery-staple");

    try{

        const result = mods.adminAuthService.login("wrong-password");
        assert.equal(result.ok, false);
        assert.equal(result.status, 401);
        assert.equal(result.details, "Incorrect password");

    }
    finally{
        mods.restore();
    }

});

test("login() fails closed (503) when ADMIN_PASSWORD is genuinely unset - unchanged by this fix", () => {

    const mods = freshModulesWithAdminPassword(undefined);

    try{

        const result = mods.adminAuthService.login("anything");
        assert.equal(result.ok, false);
        assert.equal(result.status, 503);

    }
    finally{
        mods.restore();
    }

});

test("adminAuth middleware: X-Admin-Key with the raw password (including a trailing-newline .env artifact) is accepted", () => {

    const mods = freshModulesWithAdminPassword("correct-horse-battery-staple\n");

    try{

        const { req, res, next, state } = fakeReqRes("correct-horse-battery-staple");
        mods.adminAuth(req, res, next);

        assert.equal(state.nextCalled, true, "a correct raw password must call next(), never be rejected");
        assert.equal(state.statusCode, null);

    }
    finally{
        mods.restore();
    }

});

test("adminAuth middleware: an incidental leading/trailing space on the HEADER value is also tolerated", () => {

    const mods = freshModulesWithAdminPassword("correct-horse-battery-staple");

    try{

        const { req, res, next, state } = fakeReqRes("  correct-horse-battery-staple  ");
        mods.adminAuth(req, res, next);

        assert.equal(state.nextCalled, true);

    }
    finally{
        mods.restore();
    }

});

test("adminAuth middleware: a genuinely wrong X-Admin-Key is still rejected with 401", () => {

    const mods = freshModulesWithAdminPassword("correct-horse-battery-staple");

    try{

        const { req, res, next, state } = fakeReqRes("totally-wrong");
        mods.adminAuth(req, res, next);

        assert.equal(state.nextCalled, false);
        assert.equal(state.statusCode, 401);
        assert.equal(state.body.error, "Unauthorized");

    }
    finally{
        mods.restore();
    }

});

test("adminAuth middleware: a missing X-Admin-Key header is rejected with 401, never treated as an empty-but-valid match", () => {

    const mods = freshModulesWithAdminPassword("correct-horse-battery-staple");

    try{

        const { req, res, next, state } = fakeReqRes(undefined);
        mods.adminAuth(req, res, next);

        assert.equal(state.nextCalled, false);
        assert.equal(state.statusCode, 401);

    }
    finally{
        mods.restore();
    }

});

test("adminAuth middleware: a valid session token (from login()) is still accepted, unaffected by the trim fix", () => {

    const mods = freshModulesWithAdminPassword("correct-horse-battery-staple");

    try{

        const loginResult = mods.adminAuthService.login("correct-horse-battery-staple");
        assert.equal(loginResult.ok, true);

        const { req, res, next, state } = fakeReqRes(loginResult.token);
        mods.adminAuth(req, res, next);

        assert.equal(state.nextCalled, true);

    }
    finally{
        mods.restore();
    }

});

test("adminAuth middleware: fails closed (503) when ADMIN_PASSWORD is genuinely unset - unchanged by this fix", () => {

    const mods = freshModulesWithAdminPassword(undefined);

    try{

        const { req, res, next, state } = fakeReqRes("anything");
        mods.adminAuth(req, res, next);

        assert.equal(state.nextCalled, false);
        assert.equal(state.statusCode, 503);

    }
    finally{
        mods.restore();
    }

});
