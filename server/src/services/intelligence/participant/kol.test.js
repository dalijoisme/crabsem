// services/intelligence/participant/kol.test.js - engine-quality audit
// (2026-08-07): proves the final-score clamp fix (this module previously
// had no [0, MAX_SCORE] contract, unlike its otherwise-identical sibling
// smartMoney.js). Not currently reachable with today's real config values
// (earlinessCurve's own factors never exceed 1.00), so this is a
// defensive contract test, not a bug-reproduction test. No dedicated
// test file existed for this module before this fix. Run with
// `node --test`.

const test = require("node:test");
const assert = require("node:assert/strict");

const kol = require("./kol");
const config = require("../../../config/scoringConfig");

const MAX_SCORE = config.participant.weights.kol;
const MIN_VOLUME = config.participant.minSignificantVolumeUsd.kol;

function activity(side, amountUsd, makerAddress){
    return { side, amount_usd: amountUsd, maker_address: makerAddress };
}

test("no activity: hasData false, neutral score - unchanged by this fix", () => {
    const result = kol.score([], 5);
    assert.equal(result.hasData, false);
    assert.equal(result.score, Math.round(MAX_SCORE * config.participant.neutralFraction));
});

test("score never exceeds MAX_SCORE, even for the most favorable real input (100% buy volume, many distinct wallets, no price move yet)", () => {

    const activities = Array.from({ length: 10 }, (_, i) => activity("buy", MIN_VOLUME, `W${i}`));
    const result = kol.score(activities, 0);

    assert.ok(result.score <= MAX_SCORE, `score ${result.score} must never exceed MAX_SCORE ${MAX_SCORE}`);
    assert.equal(result.score, MAX_SCORE, "this input (full buy ratio, ample volume, zero earliness discount) is the real ceiling case and should land exactly at it");

});

test("score never goes below 0, even for the least favorable real input (100% sell volume, one wallet, an extreme price move already happened)", () => {

    const activities = [activity("sell", MIN_VOLUME * 5, "SELLER_0")];
    const result = kol.score(activities, 500); // far past the earlinessCurve's own worst bucket

    assert.ok(result.score >= 0, `score ${result.score} must never be negative`);

});

test("accumulation still scores higher than distribution, same real dollar magnitude - this fix only adds a clamp, the direction logic itself is untouched", () => {

    const accumulating = kol.score(Array.from({ length: 5 }, (_, i) => activity("buy", MIN_VOLUME, `W${i}`)), 5);
    const distributing = kol.score([activity("sell", MIN_VOLUME * 5, "SELLER_0")], 5);

    assert.ok(accumulating.score > distributing.score);

});

test("reasons/riskReasons messaging is unchanged by the clamp fix", () => {

    const accumulating = kol.score(Array.from({ length: 5 }, (_, i) => activity("buy", MIN_VOLUME, `W${i}`)), 5);
    assert.ok(accumulating.reasons.some(r => r.includes("accumulation")));

});
