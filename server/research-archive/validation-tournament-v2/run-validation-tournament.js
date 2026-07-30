// VALIDATION TOURNAMENT — Production_V1 vs Momentum Hunter (3 exit variants)
// Purpose: validate whether Momentum Hunter deserves promotion to
// Production_V2. Read-only, shadow trading, no real transactions, no
// changes to Production. This script and every log it produces is a
// PERMANENT ARCHIVE — do not delete after use.
//
// REAL CAPITAL MODEL (fixes the structural flaw found in the previous
// Engine League audit): every portfolio behaves like ONE real account.
// Position size = 20% of CURRENT AVAILABLE CASH (not total equity).
// Opening a position deducts cash immediately (position notional + buy
// fee). Closing a position returns net proceeds (after sell fee) to
// cash. A BUY signal is SKIPPED (not opened, not queued) if available
// cash cannot cover the position + buy fee. No leverage, no averaging
// down, one entry per token ever.

const path = require('path');
const fs = require('fs');

const gmgnTokenRepository = require('../../src/repositories/gmgnTokenRepository');
const intelligenceEngine = require('../../src/services/intelligenceEngine');
const factory = require('../../src/services/researchEngineFactory');
const tradePlanService = require('../../src/services/tradePlanService');

const ARCHIVE_DIR = __dirname;
const OUT_PATH = path.join(ARCHIVE_DIR, 'validation-log.json');
const LOG_PATH = path.join(ARCHIVE_DIR, 'validation-progress.log');
const SNAPSHOT_DIR = path.join(ARCHIVE_DIR, 'snapshots');
if(!fs.existsSync(SNAPSHOT_DIR)) fs.mkdirSync(SNAPSHOT_DIR, { recursive: true });

const RUN_MS = 60 * 60 * 1000; // exactly 1 hour
const CYCLE_MS = 60 * 1000;

const INITIAL_CASH = 100;
const POSITION_PCT_OF_CASH = 0.20;
const BUY_FEE_PCT = 0.01;
const SELL_FEE_PCT = 0.01;
const TIME_EXIT_MINUTES = 15; // unused here (no Time Exit variant in this validation set) but kept for shared evaluateExit()

const startTime = Date.now();
const startIso = new Date(startTime).toISOString();

function log(msg){ fs.appendFileSync(LOG_PATH, `[${new Date().toISOString()}] ${msg}\n`); }

// =====================================
// PORTFOLIO — real-capital model
// =====================================

function makePortfolio(key, name, hypothesis){
    return {
        key, name, hypothesis,
        cash: INITIAL_CASH,
        openPositions: new Map(),
        closedTrades: [],
        skippedSignals: [], // {tokenAddress, symbol, timestamp, wantedSize, availableCash, reason}
        everOpenedAddresses: new Set(),
        totalBuyFeesPaid: 0,
        totalSellFeesPaid: 0
    };
}

function marketValueOfOpenPositions(portfolio, priceByAddr){
    let total = 0;
    for(const pos of portfolio.openPositions.values()){
        const price = priceByAddr.get(pos.tokenAddress) ?? pos.lastPrice;
        total += pos.notional * (price / pos.entryPrice);
    }
    return total;
}

function tryOpenPosition(portfolio, token, signal, exitPlan, nowIso){
    if(portfolio.everOpenedAddresses.has(token.token_address)) return; // one entry per token, ever - no averaging down, no re-entry

    const notional = portfolio.cash * POSITION_PCT_OF_CASH;
    const buyFee = notional * BUY_FEE_PCT;
    const totalCost = notional + buyFee;

    if(totalCost > portfolio.cash){
        portfolio.skippedSignals.push({
            tokenAddress: token.token_address, symbol: token.symbol, timestamp: nowIso,
            wantedNotional: notional, wantedTotalCost: totalCost, availableCash: portfolio.cash,
            reason: 'insufficient_cash'
        });
        return;
    }

    portfolio.everOpenedAddresses.add(token.token_address);
    portfolio.cash -= totalCost;
    portfolio.totalBuyFeesPaid += buyFee;

    portfolio.openPositions.set(token.token_address, {
        tokenAddress: token.token_address, symbol: token.symbol, openedAt: nowIso,
        entryPrice: Number(token.price), notional, buyFee,
        action: signal.action, confidence: signal.confidence, participantScore: signal.participantScore,
        exitPlan, mfePct: 0, maePct: 0, lastPrice: Number(token.price), lastCheckedAt: nowIso
    });
}

function closePosition(portfolio, position, exitPrice, exitReason, nowIso, sizeOverride){
    const notionalToClose = sizeOverride ?? position.notional;
    const grossExitValue = notionalToClose * (exitPrice / position.entryPrice);
    const sellFee = grossExitValue * SELL_FEE_PCT;
    const netProceeds = grossExitValue - sellFee;

    const costBasis = notionalToClose * (1 + BUY_FEE_PCT); // proportional share of the original buy fee
    const grossPnl = grossExitValue - notionalToClose; // before any fees
    const netPnl = netProceeds - costBasis; // after both buy and sell fees

    portfolio.cash += netProceeds;
    portfolio.totalSellFeesPaid += sellFee;

    const roiPct = ((exitPrice / position.entryPrice) - 1) * 100;
    portfolio.closedTrades.push({
        tokenAddress: position.tokenAddress, symbol: position.symbol,
        openedAt: position.openedAt, closedAt: nowIso,
        entryPrice: position.entryPrice, exitPrice, notional: notionalToClose,
        roiPct, grossPnl, buyFee: notionalToClose * BUY_FEE_PCT, sellFee, netPnl,
        exitReason, holdingSeconds: (new Date(nowIso) - new Date(position.openedAt)) / 1000,
        mfePct: position.mfePct, maePct: position.maePct,
        confidence: position.confidence, participantScore: position.participantScore
    });

    if(sizeOverride == null){
        portfolio.openPositions.delete(position.tokenAddress);
    } else {
        position.notional -= sizeOverride;
    }
}

function applyPartial(portfolio, position, price, nowIso){
    const halfNotional = position.notional / 2;
    closePosition(portfolio, position, price, 'PARTIAL_TP', nowIso, halfNotional);
    position.exitPlan.partialDone = true;
    position.exitPlan.highWaterPct = ((price / position.entryPrice) - 1) * 100;
}

function evaluateExit(portfolio, position, price, nowIso){
    const roiPct = ((price / position.entryPrice) - 1) * 100;
    if(roiPct > position.mfePct) position.mfePct = roiPct;
    if(roiPct < position.maePct) position.maePct = roiPct;
    position.lastPrice = price;
    position.lastCheckedAt = nowIso;

    const plan = position.exitPlan;

    if(plan.type === 'FIXED'){
        if(roiPct >= plan.tpPct){ closePosition(portfolio, position, price, 'TP_HIT', nowIso); return; }
        if(roiPct <= -plan.slPct){ closePosition(portfolio, position, price, 'SL_HIT', nowIso); return; }
        return;
    }
    if(plan.type === 'PARTIAL'){
        if(!plan.partialDone){
            if(roiPct <= -plan.slPct){ closePosition(portfolio, position, price, 'SL_HIT', nowIso); return; }
            if(roiPct >= plan.tpPct){ applyPartial(portfolio, position, price, nowIso); return; }
            return;
        }
        if(!plan.trailActivated && roiPct >= plan.highWaterPct + plan.postTrailActivationPct){ plan.trailActivated = true; plan.postHighWater = roiPct; }
        else if(plan.trailActivated && roiPct > plan.postHighWater){ plan.postHighWater = roiPct; }
        if(roiPct <= -plan.slPct){ closePosition(portfolio, position, price, 'SL_HIT', nowIso); return; }
        if(plan.trailActivated && roiPct <= plan.postHighWater - plan.postTrailDistancePct){ closePosition(portfolio, position, price, 'TRAILING_EXIT_REMAINDER', nowIso); }
        return;
    }
}

// =====================================
// PORTFOLIO DEFINITIONS - exactly 4, no new engines
// =====================================

const portfolios = new Map();
portfolios.set('production', makePortfolio('production', 'Production_V1', 'Benchmark - real, unmodified intelligenceEngine.js with its own native dynamic TP/SL.'));
portfolios.set('mh_tp10', makePortfolio('mh_tp10', 'Momentum Hunter + Fixed TP 10%', 'Momentum Hunter entries (earliness discount removed), fixed +10% take profit, native dynamic stop-loss.'));
portfolios.set('mh_tp15', makePortfolio('mh_tp15', 'Momentum Hunter + Fixed TP 15%', 'Momentum Hunter entries, fixed +15% take profit, native dynamic stop-loss.'));
portfolios.set('mh_partial', makePortfolio('mh_partial', 'Momentum Hunter + Partial TP', 'Momentum Hunter entries, 50% closed at +10%, remainder trailed (5% activation / 5% trail), native dynamic stop-loss as floor.'));

const engines = factory.buildEngines();
const momentumHunterEngine = engines.find(e => e.key === 'momentumHunter');

let cycleCount = 0;

function cycle(){
    try{
        const t0 = Date.now();
        const tokens = gmgnTokenRepository.getAllTokens().filter(t => t.market_cap != null && t.market_cap > 0);
        const nowIso = new Date().toISOString();
        const priceByAddr = new Map(tokens.map(t => [t.token_address, Number(t.price) || null]));

        const ctx = factory.preloadContext(tokens);
        const productionSignals = intelligenceEngine.analyzeTokens(tokens); // real, unmodified production engine
        const momentumSignals = momentumHunterEngine.analyzeTokens(tokens, ctx);

        // ---- Production_V1 portfolio: native dynamic TP/SL from its own real signal ----
        const prodPortfolio = portfolios.get('production');
        for(let i = 0; i < tokens.length; i++){
            const signal = productionSignals[i];
            if(signal.action !== 'BUY' && signal.action !== 'STRONG BUY') continue;
            const token = tokens[i];
            if(prodPortfolio.everOpenedAddresses.has(token.token_address)) continue;
            const riskBands = tradePlanService.buildRiskBands(token, signal);
            if(!riskBands) continue;
            const exitPlan = { type: 'FIXED', tpPct: riskBands.target.expectedMovePct, slPct: riskBands.stopLoss.distancePct };
            tryOpenPosition(prodPortfolio, token, signal, exitPlan, nowIso);
        }

        // ---- Momentum Hunter portfolios: shared entries, 3 different exits ----
        for(let i = 0; i < tokens.length; i++){
            const signal = momentumSignals[i];
            if(signal.action !== 'BUY' && signal.action !== 'STRONG BUY') continue;
            const token = tokens[i];

            const riskBands = tradePlanService.buildRiskBands(token, signal);
            if(!riskBands) continue;
            const nativeSlPct = riskBands.stopLoss.distancePct;

            const tp10Portfolio = portfolios.get('mh_tp10');
            if(!tp10Portfolio.everOpenedAddresses.has(token.token_address)){
                tryOpenPosition(tp10Portfolio, token, signal, { type: 'FIXED', tpPct: 10, slPct: nativeSlPct }, nowIso);
            }
            const tp15Portfolio = portfolios.get('mh_tp15');
            if(!tp15Portfolio.everOpenedAddresses.has(token.token_address)){
                tryOpenPosition(tp15Portfolio, token, signal, { type: 'FIXED', tpPct: 15, slPct: nativeSlPct }, nowIso);
            }
            const partialPortfolio = portfolios.get('mh_partial');
            if(!partialPortfolio.everOpenedAddresses.has(token.token_address)){
                tryOpenPosition(partialPortfolio, token, signal, {
                    type: 'PARTIAL', tpPct: 10, slPct: nativeSlPct, partialDone: false,
                    postTrailActivationPct: 5, postTrailDistancePct: 5, trailActivated: false, highWaterPct: 0, postHighWater: 0
                }, nowIso);
            }
        }

        // ---- update all open positions ----
        for(const portfolio of portfolios.values()){
            for(const position of [...portfolio.openPositions.values()]){
                const price = priceByAddr.get(position.tokenAddress);
                if(price == null) continue;
                evaluateExit(portfolio, position, price, nowIso);
            }
        }

        cycleCount++;
        const elapsedMs = Date.now() - t0;

        // sanity check the mandatory equation: cash + market_value(open) = equity
        let equationCheck = '';
        for(const [key, portfolio] of portfolios){
            const mv = marketValueOfOpenPositions(portfolio, priceByAddr);
            const equity = portfolio.cash + mv;
            equationCheck += ` ${key}: cash=${portfolio.cash.toFixed(2)} mv=${mv.toFixed(2)} equity=${equity.toFixed(2)} |`;
        }
        log(`cycle ${cycleCount} ok - universe=${tokens.length} cycle_ms=${elapsedMs} |${equationCheck}`);

        // full snapshot every cycle (1-hour run, small portfolio count - affordable and required for auditability)
        writeSnapshot(nowIso, priceByAddr);

    } catch(err){
        log(`cycle ERROR: ${err.stack || err.message}`);
    }
}

function serializePortfolio(portfolio, priceByAddr){
    const mv = marketValueOfOpenPositions(portfolio, priceByAddr);
    return {
        key: portfolio.key, name: portfolio.name, hypothesis: portfolio.hypothesis,
        cash: portfolio.cash, marketValueOpenPositions: mv, equity: portfolio.cash + mv,
        totalBuyFeesPaid: portfolio.totalBuyFeesPaid, totalSellFeesPaid: portfolio.totalSellFeesPaid,
        openCount: portfolio.openPositions.size,
        closedTrades: portfolio.closedTrades,
        skippedSignals: portfolio.skippedSignals,
        openPositionsSnapshot: [...portfolio.openPositions.values()].map(pos => ({
            tokenAddress: pos.tokenAddress, symbol: pos.symbol, openedAt: pos.openedAt,
            entryPrice: pos.entryPrice, notional: pos.notional, mfePct: pos.mfePct, maePct: pos.maePct,
            lastPrice: pos.lastPrice, confidence: pos.confidence, participantScore: pos.participantScore
        }))
    };
}

function writeSnapshot(nowIso, priceByAddr){
    const snapshot = {
        startedAt: startIso, lastUpdate: nowIso, elapsedMinutes: (Date.now() - startTime) / 60000, cycleCount,
        feeModel: { buyFeePct: BUY_FEE_PCT, sellFeePct: SELL_FEE_PCT },
        positionModel: { initialCash: INITIAL_CASH, positionPctOfCash: POSITION_PCT_OF_CASH, leverage: false, averagingDown: false },
        portfolios: Object.fromEntries([...portfolios.entries()].map(([k,p]) => [k, serializePortfolio(p, priceByAddr)]))
    };
    fs.writeFileSync(OUT_PATH, JSON.stringify(snapshot, null, 2));
    // also keep a per-cycle numbered snapshot for full auditability (small file, 4 portfolios only)
    fs.writeFileSync(path.join(SNAPSHOT_DIR, `cycle-${String(cycleCount).padStart(4,'0')}.json`), JSON.stringify(snapshot, null, 2));
}

log('VALIDATION TOURNAMENT STARTED. 4 portfolios: Production_V1, Momentum Hunter + TP10/TP15/PartialTP. Real capital model (cash-constrained, 20% sizing, 1% buy/sell fees, no leverage, no averaging down). Read-only, no writes, no real trades. Running for exactly 1 hour.');
cycle();
const interval = setInterval(cycle, CYCLE_MS);

setTimeout(() => {
    clearInterval(interval);
    cycle();
    log('VALIDATION TOURNAMENT FINISHED (1 hour elapsed). Final snapshot written. Archive is permanent - do not delete.');
    process.exit(0);
}, RUN_MS);
