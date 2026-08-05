// services/marketDataGateway.js - Held-Position Refresh Architecture,
// Phase 1. The ONE and ONLY door to GMGN market-data (read-only)
// endpoints. Every module that needs trending/trenches/hot-searches/
// activity-feed/gas-price/launchpad-stats, or a per-token/per-wallet
// on-demand lookup (pool_info, kline, security, top_holders/traders,
// wallet_*, created_tokens, user_info) calls a function here instead of
// requiring collectors/gmgn/authClient.js directly. This is what makes
// cross-cutting concerns (request coalescing today; rate limiting/
// circuit-breaker/diagnostics if ever needed later) a single place to
// add, instead of N call sites each needing its own copy.
//
// Deliberately scoped to MARKET DATA only. Trade execution
// (getSwapQuote/submitSwap) is NOT here and never will be routed
// through this gateway - that is services/execution/index.js's own,
// separate GMGN client instance. Two reasons, both hard constraints of
// the sprint that created this file:
//   1. "Only the GMGN data-fetching architecture changes" - execution is
//      trading logic, not data fetching.
//   2. Request coalescing (see below) must never touch execution: two
//      positions submitting byte-identical swap params moments apart
//      must each produce their own real, independent trade, never be
//      silently merged into one.
//
// Single shared client instance, built lazily (first real call, not at
// require time) so requiring this file never crashes when GMGN isn't
// configured yet - same convention services/execution/index.js already
// follows for its own client. coalesceRequests: true is what actually
// turns on authClient.js's in-flight dedup (off by default there) - this
// is the only client instance in the whole codebase that enables it.
const config = require("../config/env");
const { createGmgnClient } = require("../collectors/gmgn/authClient");

let client = null;

function getClient(){

    if(!config.GMGN_API_KEY){

        throw Object.assign(new Error("GMGN_API_KEY is not set in server/.env."), { status: 503 });

    }

    if(!client){

        client = createGmgnClient({

            apiKey: config.GMGN_API_KEY,

            privateKeyPem: config.GMGN_PRIVATE_KEY,

            host: config.GMGN_HOST,

            coalesceRequests: true

        });

    }

    return client;

}

// ---- Market-wide / batch collectors (scheduler/gmgnTrendingScheduler.js) ----

function getTrendingSwaps(chain, interval, extra = {}){
    return getClient().getTrendingSwaps(chain, interval, extra);
}

function getTrenches(chain, body){
    return getClient().getTrenches(chain, body);
}

function getHotSearches(params){
    return getClient().getHotSearches(params);
}

function getKolActivity(chain, limit){
    return getClient().getKolActivity(chain, limit);
}

function getSmartMoneyActivity(chain, limit){
    return getClient().getSmartMoneyActivity(chain, limit);
}

function getGasPrice(chain){
    return getClient().getGasPrice(chain);
}

function getCookingStatistics(){
    return getClient().getCookingStatistics();
}

// ---- Token (on-demand, per-token - services/gmgnOndemandService.js) ----

function getTokenSecurity(chain, address){
    return getClient().getTokenSecurity(chain, address);
}

function getTokenPoolInfo(chain, address){
    return getClient().getTokenPoolInfo(chain, address);
}

function getTokenTopHolders(chain, address, extra = {}){
    return getClient().getTokenTopHolders(chain, address, extra);
}

function getTokenTopTraders(chain, address, extra = {}){
    return getClient().getTokenTopTraders(chain, address, extra);
}

function getTokenKline(chain, address, resolution, from, to){
    return getClient().getTokenKline(chain, address, resolution, from, to);
}

// ---- Wallet (on-demand, per-wallet - services/gmgnOndemandService.js) ----

function getWalletActivity(chain, walletAddress, extra = {}){
    return getClient().getWalletActivity(chain, walletAddress, extra);
}

function getWalletStats(chain, walletAddresses, period = "7d"){
    return getClient().getWalletStats(chain, walletAddresses, period);
}

function getWalletTokenBalance(chain, walletAddress, tokenAddress){
    return getClient().getWalletTokenBalance(chain, walletAddress, tokenAddress);
}

function getCreatedTokens(chain, walletAddress, extra = {}){
    return getClient().getCreatedTokens(chain, walletAddress, extra);
}

function getWalletHoldings(chain, walletAddress, extra = {}){
    return getClient().getWalletHoldings(chain, walletAddress, extra);
}

function getUserInfo(){
    return getClient().getUserInfo();
}

// Test-only seam - lets a test inject a fake client without touching
// config/env or real GMGN credentials, and lets a test reset the
// singleton between runs. Mirrors the reset-hook convention already
// used by services/realtimePulseBufferService.js's clear().
function _setClientForTest(fakeClient){
    client = fakeClient;
}

function _resetForTest(){
    client = null;
}

module.exports = {
    getTrendingSwaps, getTrenches, getHotSearches, getKolActivity, getSmartMoneyActivity,
    getGasPrice, getCookingStatistics,
    getTokenSecurity, getTokenPoolInfo, getTokenTopHolders, getTokenTopTraders, getTokenKline,
    getWalletActivity, getWalletStats, getWalletTokenBalance, getCreatedTokens, getWalletHoldings,
    getUserInfo,
    _setClientForTest, _resetForTest
};
