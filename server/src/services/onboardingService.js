// services/onboardingService.js - CRAB User Journey v1 (locked).
// Derived, never a stored state machine - every step is computed live
// from the tables that already represent truth, same convention as
// this codebase's other "single source of truth" derivations (e.g.
// tradingBotEngine.js's token_last_decision). Powers the Start Bot
// completion gate (services/tradingBotService.js) today; the
// GET /onboarding/status route and frontend routing are the remaining
// Phase 4 pieces built on top of this same function.

const userRepository = require("../repositories/userRepository");
const userWalletRepository = require("../repositories/userWalletRepository");
const tradingWalletRepository = require("../repositories/tradingWalletRepository");
const tradingBotRepository = require("../repositories/tradingBotRepository");
// Named envConfig - getOnboardingStatus() below already uses `config`
// as the local variable name for trading_bot_config.
const envConfig = require("../config/env");

const STEPS = [
    { key: "emailVerified", label: "Email verified" },
    { key: "ownerWalletVerified", label: "Owner Wallet verified" },
    { key: "tradingWalletGenerated", label: "Trading Wallet generated" },
    { key: "depositCompleted", label: "Deposit completed" },
    { key: "allocationConfigured", label: "Trading Allocation configured" },
    { key: "strategySelected", label: "Strategy selected" }
];

function getOnboardingStatus(userId){

    const user = userRepository.findById(userId);
    const ownerWallet = userWalletRepository.findByUserId(userId);
    const tradingWallet = tradingWalletRepository.findByUserId(userId);
    const config = tradingBotRepository.getConfig(userId);

    // Owner Wallet normally proves account ownership via a real external
    // signature (services/walletService.js's verifyOwnership) - the ONE
    // exception is the account whose Trading Wallet already IS the real,
    // GMGN-bound Founder wallet (config.FOUNDER_WALLET_PUBLIC_KEY),
    // independently verified live against GMGN's own GET /v1/user/info
    // (see the Founder First Trade readiness report). For that specific
    // account, identity is already cryptographically anchored on GMGN's
    // side - a second, unrelated wallet signature proves nothing new.
    // Every other account still needs the real signature.
    const isVerifiedFounderWallet = Boolean(
        tradingWallet && envConfig.FOUNDER_WALLET_PUBLIC_KEY && tradingWallet.public_key === envConfig.FOUNDER_WALLET_PUBLIC_KEY
    );

    const checks = {
        emailVerified: Boolean(user && user.email_verified),
        ownerWalletVerified: isVerifiedFounderWallet || Boolean(ownerWallet && ownerWallet.verified_at),
        tradingWalletGenerated: Boolean(tradingWallet),
        depositCompleted: Boolean(tradingWallet && tradingWallet.deposited_balance_usd > 0),
        // Product decision: no step may be silently satisfied by a
        // default value. allocation_pct defaults to 100 and
        // strategy_profile defaults to STABLE, so both checks use a
        // dedicated timestamp - non-null only once the user actually
        // called the corresponding action (services/tradingBotService.js's
        // setAllocation()/updateConfig() - see
        // repositories/tradingBotRepository.js's setAllocationStmt/
        // markStrategySelected for exactly where each is stamped, and
        // updateInitialCapital for why a deposit/withdraw-triggered
        // recompute does NOT count as re-confirming allocation.
        allocationConfigured: Boolean(config && config.allocation_set_at),
        strategySelected: Boolean(config && config.strategy_selected_at)
    };

    const steps = STEPS.map(s => ({ key: s.key, label: s.label, done: checks[s.key] }));
    const missing = steps.filter(s => !s.done).map(s => s.label);

    return {
        steps,
        // Listed for future display only, never enforced as a hard
        // gate - no real executor exists yet (SIMULATION is this
        // codebase's only mode), so requiring it would make Start Bot
        // permanently unstartable.
        executorConnected: false,
        readyToTrade: missing.length === 0,
        missing
    };

}

module.exports = { getOnboardingStatus };
