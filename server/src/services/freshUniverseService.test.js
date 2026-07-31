// services/freshUniverseService.test.js - Fresh BUY Universe RFC
// (approved architecture: misty-floating-quasar.md). Proves
// getBuyCandidateUniverse() (1) defaults to entryGateService's own
// MAX_MARKET_DATA_AGE_SECONDS - never a second, driftable copy of that
// threshold - and DEFAULT_MIN_MARKET_CAP; (2) honors overrides when
// given; (3) passes collector/fresh counts through from the repository
// untouched. Monkey-patches gmgnTokenRepository's exports in
// beforeEach/afterEach, same convention entryGateService.test.js already
// established for a direct (non-injected) repository dependency. Run
// with `node --test`.

const test = require("node:test");
const assert = require("node:assert/strict");

const gmgnTokenRepository = require("../repositories/gmgnTokenRepository");
const { MAX_MARKET_DATA_AGE_SECONDS } = require("./entryGateService");
const { getBuyCandidateUniverse, DEFAULT_MIN_MARKET_CAP } = require("./freshUniverseService");

let originalGetFreshTokens, originalCountTokens;
let lastGetFreshTokensArgs;

test.beforeEach(() => {
    originalGetFreshTokens = gmgnTokenRepository.getFreshTokens;
    originalCountTokens = gmgnTokenRepository.countTokens;
    lastGetFreshTokensArgs = null;
    gmgnTokenRepository.getFreshTokens = (args) => {
        lastGetFreshTokensArgs = args;
        return [{ token_address: "A" }, { token_address: "B" }];
    };
    gmgnTokenRepository.countTokens = () => 14023;
});
test.afterEach(() => {
    gmgnTokenRepository.getFreshTokens = originalGetFreshTokens;
    gmgnTokenRepository.countTokens = originalCountTokens;
});

test("getBuyCandidateUniverse defaults maxAgeSeconds to entryGateService.MAX_MARKET_DATA_AGE_SECONDS", () => {
    getBuyCandidateUniverse();
    assert.equal(lastGetFreshTokensArgs.maxAgeSeconds, MAX_MARKET_DATA_AGE_SECONDS);
});

test("getBuyCandidateUniverse defaults minMarketCap to DEFAULT_MIN_MARKET_CAP (0)", () => {
    getBuyCandidateUniverse();
    assert.equal(lastGetFreshTokensArgs.minMarketCap, DEFAULT_MIN_MARKET_CAP);
    assert.equal(DEFAULT_MIN_MARKET_CAP, 0);
});

test("getBuyCandidateUniverse passes overrides through to the repository", () => {
    getBuyCandidateUniverse({ maxAgeSeconds: 60, minMarketCap: 5000 });
    assert.equal(lastGetFreshTokensArgs.maxAgeSeconds, 60);
    assert.equal(lastGetFreshTokensArgs.minMarketCap, 5000);
});

test("getBuyCandidateUniverse returns collectorTotalCount/freshUniverseCount straight from the repository", () => {
    const result = getBuyCandidateUniverse();
    assert.equal(result.collectorTotalCount, 14023);
    assert.equal(result.freshUniverseCount, 2);
    assert.deepEqual(result.tokens, [{ token_address: "A" }, { token_address: "B" }]);
});
