// config/strategyProfileConfig.js - CRAB Trading Bot Constitution v1.0,
// Final Specification section 02; extended by the Profile-Aware
// Production V2 refactor (approved architecture:
// C:\Users\HARY\.claude\plans\floating-sauteeing-swan.md). Pure data,
// no logic - same pattern as scoringConfig.js.
//
// UPDATED CONSTRAINT (supersedes this file's original note): Strategy
// Profile now DOES reach into Production V2's own filtering, via the
// engine's already-generic philosophy-override mechanism
// (researchEngineFactory.analyzeTokenWithPhilosophy) - see `weights`/
// `tiers`/`min_liquidity_usd`/`min_volume_usd`/`flatten_earliness`/
// `sm_bonus` below. scoringConfig.js itself (safetyVeto/
// structuralValidation - the true hard-reject, honeypot/near-zero-
// liquidity/etc.) is still never touched by any profile - only the
// engine's pre-existing, already-proven per-call override slots are
// used. Production V2 stays ONE implementation; profiles change HOW it
// filters, not which engine runs.
//
// Each bundle is written onto trading_bot_config (nested fields
// serialized to the *_json columns by repositories/tradingBotRepository.js -
// see services/strategyProfileTranslator.js for how they're read back
// out). opportunity_priority_enabled / emi_enabled remain part of the
// bundle, not independently user-settable (Final Spec section 01) -
// switching profile is the only way any profile-owned field moves.
//
// weights/tiers/quality_gate_overrides/stop_loss_overrides are PARTIAL
// objects - any field they omit falls back to Production V2's own
// default (see strategyProfileTranslator.js/researchEngineFactory.js).
// STABLE is deliberately all-default (weights:{}, tiers:{}, etc.) -
// "trust Production V2/momentumHunter exactly as already validated."

const PROFILES = {

    BASELINE: {
        min_confidence: 60,
        min_decay_fraction: 0.90,
        position_size_pct: 20,
        max_position_size: 100,
        max_open_positions: 5,
        cooldown_win_minutes: 5,
        cooldown_loss_minutes: 30,
        cooldown_reversal_minutes: 15,
        cooldown_default_minutes: 10,
        opportunity_priority_enabled: 0,
        emi_enabled: 0,
        // "Make sure this coin is really good" - strictest, highest-
        // precision layer. Up-weights quality/safety modules, raises
        // liquidity/volume floors, patient exits.
        weights: { developer: 1.3, sniperQuality: 1.2, bundleQuality: 1.2, insiderQuality: 1.2, liquidity: 1.5, security: 1.5, accumulation: 0.8, smartMoney: 0.8, kol: 0.8 },
        tiers: { buy: 72, strongBuy: 88 },
        min_liquidity_usd: 5000,
        min_volume_usd: 3000,
        flatten_earliness: 0,
        sm_bonus: 0,
        // NOTE on minSerialCreatorCount/maxSerialCreatorOpenRatio direction:
        // qualityGateService rejects when creator_created_count > minSerialCreatorCount
        // AND creator_created_open_ratio < maxSerialCreatorOpenRatio - so a
        // LOWER minSerialCreatorCount and a HIGHER maxSerialCreatorOpenRatio
        // both make the check EASIER to trigger (stricter, catches more) -
        // opposite of maxRugRatio/maxTop10HolderRate's "lower = stricter"
        // pattern. BASELINE (strictest) uses a low count floor + high ratio
        // ceiling on purpose.
        quality_gate_overrides: { maxRugRatio: 0.50, maxTop10HolderRate: 0.45, maxBundlerMhrWithLowLiquidity: 0.85, minSerialCreatorCount: 300, maxSerialCreatorOpenRatio: 0.08 },
        fixed_tp_pct: 20,
        stop_loss_overrides: { baseStopPct: 10, highRiskStopPct: 6, maxStopPct: 30 },
        momentum_weakening_buyer_dominance_ratio: 0.45,
        // "Is this coin already proven to be good?" - a static-quality
        // question, not a rate-of-change one. Baseline never asks about
        // acceleration, so this stays null (translator no-ops on null).
        acceleration_overrides: null
    },

    STABLE: {
        min_confidence: 65,
        min_decay_fraction: 0.90,
        position_size_pct: 10,
        max_position_size: 100,
        max_open_positions: 5,
        cooldown_win_minutes: 10,
        cooldown_loss_minutes: 45,
        cooldown_reversal_minutes: 20,
        cooldown_default_minutes: 15,
        opportunity_priority_enabled: 0,
        emi_enabled: 0,
        // "This coin is probably good" - trust Production V2/
        // momentumHunter's own already-validated numbers as-is.
        weights: {}, tiers: {}, min_liquidity_usd: null, min_volume_usd: null,
        flatten_earliness: 1, sm_bonus: 0, quality_gate_overrides: {},
        fixed_tp_pct: 15, stop_loss_overrides: null, momentum_weakening_buyer_dominance_ratio: 0.5,
        // "This coin is probably good" is still a static-quality question -
        // Stable doesn't hunt acceleration either.
        acceleration_overrides: null
    },

    BALANCED: {
        min_confidence: 60,
        min_decay_fraction: 0.90,
        position_size_pct: 15,
        max_position_size: 150,
        max_open_positions: 7,
        cooldown_win_minutes: 7,
        cooldown_loss_minutes: 30,
        cooldown_reversal_minutes: 15,
        cooldown_default_minutes: 10,
        opportunity_priority_enabled: 1,
        emi_enabled: 0,
        // "This coin is interesting enough" - modest widen across the board.
        weights: { accumulation: 1.15, smartMoney: 1.15, kol: 1.1, liquidity: 0.9, security: 0.9 },
        tiers: { buy: 55, strongBuy: 75 },
        min_liquidity_usd: 1500,
        min_volume_usd: 800,
        flatten_earliness: 1,
        sm_bonus: 0,
        quality_gate_overrides: { maxRugRatio: 0.72, maxTop10HolderRate: 0.62, maxBundlerMhrWithLowLiquidity: 0.96, minSerialCreatorCount: 550, maxSerialCreatorOpenRatio: 0.04 },
        fixed_tp_pct: 13,
        stop_loss_overrides: { baseStopPct: 10, highRiskStopPct: 6, maxStopPct: 30 },
        momentum_weakening_buyer_dominance_ratio: 0.55,
        // "This coin is interesting enough" still asks about the coin's
        // current state, not its rate of change - Balanced sits between
        // Baseline's confirmation and Aggressive's acceleration hunt.
        acceleration_overrides: null
    },

    AGGRESSIVE: {
        // Production trading-quality audit (2026-08-06, live VPS):
        // raised from 45 - real backtest against this account's own 243
        // real trades (official ROI = COALESCE(realized_roi_pct, roi_pct),
        // fee-inclusive PnL) proved confidence<50 was 39.5% of all real
        // volume at avgROI=-7.43%/winRate=31.7%, while every confidence
        // floor from 55 up produced positive total PnL - floor=45 (today's
        // value, i.e. no floor beyond what already applies) backtested to
        // -41.48 total; floor=55 backtested to +6.40; floor=58 to +13.23
        // (smaller n=52, held out as a less robust, single-point choice).
        // 55 sits at the start of the broad, non-overfit positive zone
        // rather than the small-sample tail peak.
        min_confidence: 55,
        min_decay_fraction: 0.85,
        position_size_pct: 15,
        max_position_size: 150,
        max_open_positions: 10,
        cooldown_win_minutes: 5,
        cooldown_loss_minutes: 20,
        cooldown_reversal_minutes: 10,
        cooldown_default_minutes: 7,
        opportunity_priority_enabled: 1,
        emi_enabled: 1,
        // "This coin BERPOTENSI menjadi bagus" - Early Opportunity
        // Hunter: reweights composition from confirmation (priceStability/
        // volume/holderDistribution) toward early-probability signals
        // (accumulation/smartMoney/whale/kol), not just looser bars.
        //
        // walletQuality: 0.5 added (production trading-quality audit,
        // 2026-08-06) - Pearson correlation against this account's own
        // 243 real trades' official ROI was r=-0.638 (n=124), the
        // strongest single-module signal found in either direction -
        // tokens where involved wallets were classified "experienced"
        // (traded 20+ tokens before, see
        // intelligence/participant/walletQuality.js's own scoring)
        // measurably underperformed. Plausible real mechanism: in this
        // asset class, "traded many tokens before" more often marks
        // serial flippers/early-exit chasers than genuine informed
        // conviction. Down-weighted (not zeroed/inverted) at the same
        // 0.5-0.7x scale this profile already applies to
        // developer/sniperQuality/bundleQuality/insiderQuality below,
        // pending more real volume to validate further.
        weights: { accumulation: 1.6, smartMoney: 1.8, kol: 1.4, whale: 1.5, developer: 0.8, sniperQuality: 0.7, bundleQuality: 0.7, insiderQuality: 0.7, walletQuality: 0.5, holderDistribution: 0.5, volume: 0.5, priceStability: 0.4 },
        tiers: { buy: 55, strongBuy: 75 },
        min_liquidity_usd: 1200,
        min_volume_usd: null, // deliberate - never gate on volume not yet built up
        flatten_earliness: 1,
        sm_bonus: 1,
        // minSerialCreatorCount high + maxSerialCreatorOpenRatio low =
        // most lenient on this axis (see BASELINE's note above for why).
        quality_gate_overrides: { maxRugRatio: 0.75, maxTop10HolderRate: 0.65, maxBundlerMhrWithLowLiquidity: 0.97, minSerialCreatorCount: 800, maxSerialCreatorOpenRatio: 0.02 },
        fixed_tp_pct: 12,
        stop_loss_overrides: { baseStopPct: 15, highRiskStopPct: 10, maxStopPct: 40 },
        momentum_weakening_buyer_dominance_ratio: 0.55,
        // "Is this coin showing the earliest signs it is ABOUT TO become
        // good?" - a genuinely different question from every other
        // profile's, not just a looser bar on the same one. Rewards
        // RATE OF CHANGE (researchEngineFactory.computeAccelerationSignal):
        // price pace (5m annualized vs 1h), smart-money/KOL buy-flow rate
        // (recent window vs prior window, from real gmgn_activity_feed
        // timestamps), and liquidity growth (current vs recentWindowMinutes
        // ago, from real token_price_history snapshots) - never a fabricated
        // "acceleration score", only real already-collected time series.
        // requireGateForEntry: true means a BUY/STRONG BUY tier alone is
        // no longer sufficient for Aggressive - real acceleration evidence
        // (price pace or flow pace) must ALSO be present, or the action is
        // downgraded to HOLD. This is the literal "enters BEFORE
        // confirmation, not just with a lower bar" mechanism.
        acceleration_overrides: {
            recentWindowMinutes: 15,
            priorWindowMinutes: 60,
            maxBonusFraction: 0.15,
            requireGateForEntry: true
        }
    }

};

const PROFILE_NAMES = Object.keys(PROFILES);

// Returns a frozen copy of the named bundle, or undefined for an
// unknown name - callers (tradingBotService.js) are responsible for
// validating the name and rejecting the request before this is ever
// called with something outside PROFILE_NAMES.
function resolveProfile(name){
    const bundle = PROFILES[name];
    return bundle ? Object.freeze({ ...bundle }) : undefined;
}

module.exports = { PROFILES, PROFILE_NAMES, resolveProfile };
