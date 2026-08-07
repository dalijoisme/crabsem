// services/intelligence/participant/smartMoney.test.js - engine-quality
// audit (2026-08-07): proves the continuous buy-ratio direction mapping
// (correctness fix, replacing the old discrete accumulating/distributing/
// neutral bucket that a real historical replay showed destroyed
// predictive signal at exactly the 1.3x threshold boundary - see
// scoringConfig.js's own participant.weights.smartMoney comment history
// for the full evidence trail). No dedicated test file existed for this
// module before this fix. Run with `node --test`.

const test = require("node:test");
const assert = require("node:assert/strict");

const smartMoney = require("./smartMoney");
const config = require("../../../config/scoringConfig");

const MAX_SCORE = config.participant.weights.smartMoney;
const MIN_VOLUME = config.participant.minSignificantVolumeUsd.smartMoney;

function activity(side, amountUsd, makerAddress){
    return { side, amount_usd: amountUsd, maker_address: makerAddress };
}

// Large enough total volume that volumeConfidence saturates at 1 -
// isolates the direction-mapping math itself from the volume-significance
// blend for tests that need that.
function fullVolumeActivities(buyUsd, sellUsd, buyerCount = 10){
    const activities = [];
    const perBuyer = buyUsd / buyerCount;
    for(let i = 0; i < buyerCount; i++) activities.push(activity("buy", perBuyer, `BUYER_${i}`));
    if(sellUsd > 0) activities.push(activity("sell", sellUsd, "SELLER_0"));
    return activities;
}

test("no activity: hasData false, neutral score - unchanged by this fix", () => {
    const result = smartMoney.score([], 5, []);
    assert.equal(result.hasData, false);
    assert.equal(result.score, Math.round(MAX_SCORE * config.participant.neutralFraction));
});

test("directionScore is now continuous - a 51%/49% buy split and a 60%/40% split score differently, not identical", () => {

    const near50 = smartMoney.score(fullVolumeActivities(MIN_VOLUME * 3 * 0.51, MIN_VOLUME * 3 * 0.49), 5, []);
    const sixty40 = smartMoney.score(fullVolumeActivities(MIN_VOLUME * 3 * 0.60, MIN_VOLUME * 3 * 0.40), 5, []);

    assert.notEqual(near50.score, sixty40.score, "the old discrete bucket scored both of these identically (both 'neutral', 0.5x) - the continuous mapping must not");
    assert.ok(sixty40.score > near50.score, "a higher real buy ratio must score higher, monotonically");

});

test("no discontinuity at the old 1.3x threshold - a 129%/100% split and a 131%/100% split score nearly identically now", () => {

    const justBelow = smartMoney.score(fullVolumeActivities(129, 100), 5, []);
    const justAbove = smartMoney.score(fullVolumeActivities(131, 100), 5, []);

    // Old behavior: justBelow landed in the "neutral" 0.5x bucket while
    // justAbove jumped straight to the 1.0x "accumulating" bucket - a
    // huge score jump for a 2-point difference in raw dollars. The
    // continuous mapping must keep these close together.
    assert.ok(Math.abs(justBelow.score - justAbove.score) <= 2, `expected near-identical scores across the old threshold boundary, got ${justBelow.score} vs ${justAbove.score}`);

});

test("100% buy volume (no sells at all) scores at the maximum, same as the old 'accumulating' bucket's ceiling", () => {
    const result = smartMoney.score(fullVolumeActivities(MIN_VOLUME * 3, 0), 5, []);
    assert.equal(result.score, MAX_SCORE);
});

test("100% sell volume (no buys) scores at the floor - direction mapping still respects real distribution", () => {
    // fullVolumeActivities always includes at least one buyer for the
    // diversity calc to have real buys to inspect - use a dedicated
    // all-sell activity set instead.
    const activities = [activity("sell", MIN_VOLUME * 3, "SELLER_0")];
    const result = smartMoney.score(activities, 5, []);
    assert.equal(result.score, 0);
});

test("volume-confidence blending toward neutral is unchanged - a thin sample still pulls the continuous score toward 0.5x, not just the old buckets", () => {

    const thin = smartMoney.score([activity("buy", 10, "A")], 5, []); // $10, far below MIN_VOLUME - should sit close to neutral regardless of the (100%) buy ratio
    const neutralPoint = MAX_SCORE * 0.5;

    assert.ok(Math.abs(thin.score - neutralPoint) < MAX_SCORE * 0.15, `a real but thin sample must stay close to neutral (${neutralPoint}), got ${thin.score}`);

});

test("score always stays within [0, MAX_SCORE], same clamp contract as before this fix", () => {

    const extreme = smartMoney.score(fullVolumeActivities(MIN_VOLUME * 10, 0, 1), 300, []); // single wallet, huge extreme move
    assert.ok(extreme.score >= 0 && extreme.score <= MAX_SCORE);

});

test("reasons/riskReasons messaging still reflects real accumulation/distribution language - only the numeric score computation changed, not the observability text", () => {

    const accumulating = smartMoney.score(fullVolumeActivities(MIN_VOLUME * 3, 0), 5, []);
    assert.ok(accumulating.reasons.some(r => r.includes("accumulation")), "accumulation-tier buy activity must still say so in reasons");

    const distributing = smartMoney.score([activity("sell", MIN_VOLUME * 3, "SELLER_0")], 5, []);
    assert.ok(distributing.riskReasons.some(r => r.includes("distribution")), "distribution-tier sell activity must still flag a risk reason");

});

test("wallet diversity discount still applies on top of the continuous direction score - one wallet repeating every buy still scores lower than many distinct wallets, same total dollars", () => {

    const oneWallet = smartMoney.score([
        activity("buy", MIN_VOLUME, "SAME_WALLET"),
        activity("buy", MIN_VOLUME, "SAME_WALLET"),
        activity("buy", MIN_VOLUME, "SAME_WALLET")
    ], 5, []);

    const manyWallets = smartMoney.score([
        activity("buy", MIN_VOLUME, "W1"),
        activity("buy", MIN_VOLUME, "W2"),
        activity("buy", MIN_VOLUME, "W3")
    ], 5, []);

    assert.ok(manyWallets.score > oneWallet.score, "broad participation must still outscore one repeating wallet, same total dollars");

});
