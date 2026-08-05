// services/heldPositionRefreshMode.test.js - RATE_LIMIT_BANNED
// investigation, isolation test. Proves config.HELD_POSITION_REFRESH_MODE
// actually switches services/tradingBotEngine.js's real
// manageOpenPositions() behavior between the two real, documented modes -
// not just that the flag exists in config.
//
// config.HELD_POSITION_REFRESH_MODE is read inside manageOpenPositions()
// at CALL time (not module-load time) from tradingBotEngine.js's own
// closure-captured `config` reference - so exercising a different mode
// requires clearing require.cache for BOTH config/env.js and
// tradingBotEngine.js (so tradingBotEngine.js re-requires a config/env.js
// module instance) and re-requiring tradingBotEngine.js fresh under the
// new process.env value BEFORE calling manageOpenPositions - same
// require-cache-reset convention already used by middleware/adminAuth.test.js
// for the same class of "frozen config read once, per env var" problem.
// Run with `node --test`.

const test = require("node:test");
const assert = require("node:assert/strict");

const CONFIG_PATH = require.resolve("../config/env");
const ENGINE_PATH = require.resolve("./tradingBotEngine");

function freshEngineWithMode(mode){

    const originalEnv = process.env.HELD_POSITION_REFRESH_MODE;

    if(mode === undefined) delete process.env.HELD_POSITION_REFRESH_MODE;
    else process.env.HELD_POSITION_REFRESH_MODE = mode;

    delete require.cache[CONFIG_PATH];
    delete require.cache[ENGINE_PATH];

    const config = require("../config/env");
    const engine = require("./tradingBotEngine");

    return {

        config, engine,

        restore(){
            if(originalEnv === undefined) delete process.env.HELD_POSITION_REFRESH_MODE;
            else process.env.HELD_POSITION_REFRESH_MODE = originalEnv;
            delete require.cache[CONFIG_PATH];
            delete require.cache[ENGINE_PATH];
        }

    };

}

function stub(obj, method, fn){
    const original = obj[method];
    obj[method] = fn;
    return () => { obj[method] = original; };
}

const nowIso = () => new Date().toISOString().slice(0, 19).replace("T", " ");

test("config.HELD_POSITION_REFRESH_MODE defaults to ALL_POSITIONS when unset - the flag's mere existence never changes production behavior", () => {

    const mods = freshEngineWithMode(undefined);
    try{
        assert.equal(mods.config.HELD_POSITION_REFRESH_MODE, "ALL_POSITIONS");
    }
    finally{
        mods.restore();
    }

});

test("ALL_POSITIONS mode: a losing, still-fresh position IS realtime-refreshed - current production behavior", async () => {

    const mods = freshEngineWithMode("ALL_POSITIONS");

    const tradingBotRepository = require("../repositories/tradingBotRepository");
    const restoreRepo = stub(tradingBotRepository, "findOpenPositions", () => [
        { id: 1, token_address: "LosingToken111", token_symbol: "LOSING1", entry_price: 1.0 }
    ]);

    try{

        let fetchCalls = 0;
        const ondemandService = {
            getTokenPoolInfo: async () => { fetchCalls++; return { data: { liquidity: "500" } }; },
            getTokenKline: async () => ({ data: { list: [{ close: "0.70" }] } }) // -30%, clearly losing
        };

        const tokensByAddress = new Map([
            ["LosingToken111", {
                token_address: "LosingToken111", symbol: "LOSING1", price: 0.70,
                price_change_5m: -4, volume_1h: 1000, market_cap: 1000,
                updated_at: nowIso(), last_seen: nowIso()
            }]
        ]);

        const fakeTradeManager = { closeIfDue: async () => ({ closed: false }) };

        await mods.engine.manageOpenPositions(1, fakeTradeManager, {}, tokensByAddress, ondemandService);

        assert.equal(fetchCalls, 1, "ALL_POSITIONS mode must refresh a losing position on demand, same as production today");

    }
    finally{
        restoreRepo();
        mods.restore();
    }

});

test("PROFIT_ONLY mode: a losing, still-fresh position is NOT realtime-refreshed - restores Arjuna a0a8759's own original scope", async () => {

    const mods = freshEngineWithMode("PROFIT_ONLY");

    const tradingBotRepository = require("../repositories/tradingBotRepository");
    const restoreRepo = stub(tradingBotRepository, "findOpenPositions", () => [
        { id: 1, token_address: "LosingToken111", token_symbol: "LOSING1", entry_price: 1.0 }
    ]);

    try{

        let fetchCalls = 0;
        const ondemandService = {
            getTokenPoolInfo: async () => { fetchCalls++; return { data: { liquidity: "500" } }; },
            getTokenKline: async () => ({ data: { list: [{ close: "0.70" }] } })
        };

        const tokensByAddress = new Map([
            ["LosingToken111", {
                token_address: "LosingToken111", symbol: "LOSING1", price: 0.70,
                price_change_5m: -4, volume_1h: 1000, market_cap: 1000,
                updated_at: nowIso(), last_seen: nowIso()
            }]
        ]);

        const fakeTradeManager = { closeIfDue: async () => ({ closed: false }) };

        await mods.engine.manageOpenPositions(1, fakeTradeManager, {}, tokensByAddress, ondemandService);

        assert.equal(fetchCalls, 0, "PROFIT_ONLY mode must NOT realtime-refresh a losing position - it falls back to the slower 90s `stale` path instead, exactly like Arjuna a0a8759");

    }
    finally{
        restoreRepo();
        mods.restore();
    }

});

test("PROFIT_ONLY mode: a position genuinely in profit-protection territory IS still realtime-refreshed", async () => {

    const mods = freshEngineWithMode("PROFIT_ONLY");

    const tradingBotRepository = require("../repositories/tradingBotRepository");
    const restoreRepo = stub(tradingBotRepository, "findOpenPositions", () => [
        { id: 1, token_address: "ProfitToken222", token_symbol: "PROFIT2", entry_price: 1.0 }
    ]);

    try{

        let fetchCalls = 0;
        const ondemandService = {
            getTokenPoolInfo: async () => { fetchCalls++; return { data: { liquidity: "500" } }; },
            getTokenKline: async () => ({ data: { list: [{ close: "1.35" }] } }) // +35%, past a 25% floor
        };

        const tokensByAddress = new Map([
            ["ProfitToken222", {
                token_address: "ProfitToken222", symbol: "PROFIT2", price: 1.30,
                price_change_5m: 5, volume_1h: 1000, market_cap: 1000,
                updated_at: nowIso(), last_seen: nowIso()
            }]
        ]);

        const fakeTradeManager = { closeIfDue: async () => ({ closed: false }) };

        await mods.engine.manageOpenPositions(1, fakeTradeManager, {}, tokensByAddress, ondemandService);

        assert.equal(fetchCalls, 1, "PROFIT_ONLY mode must still refresh a genuinely in-profit position - this is Arjuna's own original, intended behavior, not disabled entirely");

    }
    finally{
        restoreRepo();
        mods.restore();
    }

});
