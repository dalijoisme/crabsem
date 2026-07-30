const fs = require('fs');
const path = require('path');

const data = JSON.parse(fs.readFileSync(path.join(__dirname, 'validation-log.json'), 'utf8'));
const portfolios = data.portfolios;

function avg(arr){ const f = arr.filter(v=>v!=null && !Number.isNaN(v)); return f.length ? f.reduce((a,b)=>a+b,0)/f.length : null; }
function median(arr){ const f = arr.filter(v=>v!=null).sort((a,b)=>a-b); if(!f.length) return null; const m = Math.floor(f.length/2); return f.length%2 ? f[m] : (f[m-1]+f[m])/2; }
function stdev(arr){ const f = arr.filter(v=>v!=null); if(f.length<2) return null; const m = avg(f); return Math.sqrt(f.reduce((s,v)=>s+(v-m)**2,0)/(f.length-1)); }
function sum(arr){ return arr.reduce((a,b)=>a+b,0); }

const INITIAL_CASH = 100;

function analyzePortfolio(p){
    const closed = p.closedTrades;
    const wins = closed.filter(t => t.netPnl > 0);
    const losses = closed.filter(t => t.netPnl <= 0);

    const grossPnlTotal = sum(closed.map(t=>t.grossPnl));
    const netPnlTotal = sum(closed.map(t=>t.netPnl));
    const totalFees = sum(closed.map(t=>t.buyFee + t.sellFee));

    // equity curve (net, chronological) for drawdown
    const sorted = [...closed].sort((a,b) => new Date(a.closedAt) - new Date(b.closedAt));
    let equity = INITIAL_CASH, peak = INITIAL_CASH, maxDD = 0;
    for(const t of sorted){
        equity += t.netPnl;
        if(equity > peak) peak = equity;
        const dd = (peak-equity)/peak*100;
        if(dd > maxDD) maxDD = dd;
    }

    const holdingMinutes = closed.map(t => t.holdingSeconds/60);
    const returns = closed.map(t => t.netPnl); // per-trade dollar return, used for a dispersion-based risk score

    const unrealizedPnl = p.equity - INITIAL_CASH - netPnlTotal; // equity - initial - realized = unrealized
    const roiBeforeFees = ((INITIAL_CASH + grossPnlTotal + unrealizedPnl) / INITIAL_CASH - 1) * 100;
    const roiAfterFees = ((p.equity / INITIAL_CASH) - 1) * 100;

    return {
        key: p.key, name: p.name,
        finalEquity: p.equity, cash: p.cash, marketValueOpen: p.marketValueOpenPositions,
        realizedPnl: netPnlTotal, unrealizedPnl,
        roiAfterFees, roiBeforeFees,
        finalEquityBeforeFees: INITIAL_CASH + grossPnlTotal + unrealizedPnl,
        totalBuyFees: p.totalBuyFeesPaid, totalSellFees: p.totalSellFeesPaid, totalFees,
        pctProfitLostToFees: (grossPnlTotal !== 0) ? (totalFees / Math.abs(grossPnlTotal) * 100) : null,
        closedCount: closed.length, openCount: p.openCount, totalEntries: closed.length + p.openCount,
        winCount: wins.length, lossCount: losses.length,
        winRate: closed.length ? wins.length/closed.length*100 : null,
        profitFactor: sum(losses.map(t=>Math.abs(t.netPnl))) > 0 ? sum(wins.map(t=>t.netPnl))/sum(losses.map(t=>Math.abs(t.netPnl))) : (wins.length ? Infinity : null),
        avgWin: avg(wins.map(t=>t.netPnl)), avgLoss: avg(losses.map(t=>t.netPnl)),
        largestWin: wins.length ? Math.max(...wins.map(t=>t.netPnl)) : null,
        largestLoss: losses.length ? Math.min(...losses.map(t=>t.netPnl)) : null,
        avgRoiWinner: avg(wins.map(t=>t.roiPct)), avgRoiLoser: avg(losses.map(t=>t.roiPct)),
        expectancy: closed.length ? netPnlTotal/closed.length : null,
        maxDrawdownPct: maxDD,
        sharpeLike: stdev(returns) ? avg(returns)/stdev(returns) : null,
        avgHoldingMinutes: avg(holdingMinutes), medianHoldingMinutes: median(holdingMinutes),
        longestHoldingMinutes: holdingMinutes.length ? Math.max(...holdingMinutes) : null,
        shortestHoldingMinutes: holdingMinutes.length ? Math.min(...holdingMinutes) : null,
        skippedCount: p.skippedSignals.length,
        skippedUniqueTokens: new Set(p.skippedSignals.map(s=>s.tokenAddress)).size,
        exitReasons: (() => {
            const r = {};
            for(const t of closed) r[t.exitReason] = (r[t.exitReason]||0)+1;
            return r;
        })(),
        avgFeePerTrade: closed.length ? totalFees/closed.length : null,
        openPositions: p.openPositionsSnapshot
    };
}

const results = Object.values(portfolios).map(analyzePortfolio);

console.log('=== SECTION 1: PERFORMANCE ===');
for(const r of results){
    console.log(`\n--- ${r.name} ---`);
    console.log(`Final Equity: $${r.finalEquity.toFixed(2)} | ROI: ${((r.finalEquity/100-1)*100).toFixed(2)}%`);
    console.log(`Cash: $${r.cash.toFixed(2)} | Market Value Open: $${r.marketValueOpen.toFixed(2)}`);
    console.log(`Realized PnL (net): $${r.realizedPnl.toFixed(2)} | Unrealized PnL: $${r.unrealizedPnl.toFixed(2)}`);
    console.log(`Win Rate: ${r.winRate?.toFixed(1)}% | Profit Factor: ${r.profitFactor?.toFixed(2)}`);
    console.log(`Avg Win: $${r.avgWin?.toFixed(3)} | Avg Loss: $${r.avgLoss?.toFixed(3)} | Expectancy: $${r.expectancy?.toFixed(4)}`);
    console.log(`Max Drawdown: ${r.maxDrawdownPct.toFixed(2)}% | Sharpe-like: ${r.sharpeLike?.toFixed(3)}`);
}

console.log('\n=== SECTION 2: TRADE STATISTICS ===');
for(const r of results){
    console.log(`\n--- ${r.name} ---`);
    console.log(`Total signals seen: ${r.totalEntries + r.skippedCount} | Executed: ${r.totalEntries} | Skipped (events): ${r.skippedCount} | Skipped (unique tokens): ${r.skippedUniqueTokens}`);
    console.log(`Closed: ${r.closedCount} | Open: ${r.openCount}`);
    console.log(`Avg Holding: ${r.avgHoldingMinutes?.toFixed(1)}min | Median: ${r.medianHoldingMinutes?.toFixed(1)}min | Longest: ${r.longestHoldingMinutes?.toFixed(1)}min | Shortest: ${r.shortestHoldingMinutes?.toFixed(2)}min`);
}

console.log('\n=== SECTION 4: EXIT ANALYSIS ===');
for(const r of results){
    console.log(`\n--- ${r.name} ---`);
    console.log(JSON.stringify(r.exitReasons));
    console.log(`Avg ROI winner: ${r.avgRoiWinner?.toFixed(2)}% | Avg ROI loser: ${r.avgRoiLoser?.toFixed(2)}%`);
    console.log(`Largest winner: $${r.largestWin?.toFixed(3)} | Largest loser: $${r.largestLoss?.toFixed(3)}`);
}

console.log('\n=== FEE IMPACT ===');
for(const r of results){
    console.log(`\n--- ${r.name} ---`);
    console.log(`ROI before fees: ${r.roiBeforeFees.toFixed(2)}% | ROI after fees: ${r.roiAfterFees.toFixed(2)}%`);
    console.log(`Equity before fees: $${r.finalEquityBeforeFees.toFixed(2)} | Equity after fees: $${r.finalEquity.toFixed(2)}`);
    console.log(`Total Buy Fees: $${r.totalBuyFees.toFixed(3)} | Total Sell Fees: $${r.totalSellFees.toFixed(3)} | Total Fees: $${r.totalFees.toFixed(3)}`);
    console.log(`Avg Fee/Trade: $${r.avgFeePerTrade?.toFixed(4)} | % Profit Lost to Fees: ${r.pctProfitLostToFees?.toFixed(1)}%`);
}

console.log('\n=== SKIPPED SIGNAL EXAMPLE (insufficient cash) ===');
for(const p of Object.values(portfolios)){
    if(p.skippedSignals.length){
        const s = p.skippedSignals[0];
        console.log(`${p.name}: token=${s.symbol} wanted=$${s.wantedTotalCost.toFixed(2)} available=$${s.availableCash.toFixed(2)} at ${s.timestamp}`);
    }
}

console.log('\n=== OPEN POSITION ANALYSIS ===');
for(const r of results){
    const open = r.openPositions;
    const unrealizedRois = open.map(o => ((o.lastPrice/o.entryPrice)-1)*100);
    console.log(`\n--- ${r.name} ---`);
    console.log(`Open count: ${open.length} | Avg unrealized ROI: ${avg(unrealizedRois)?.toFixed(2)}%`);
    console.log(`Largest unrealized gain: ${open.length?Math.max(...unrealizedRois).toFixed(2):null}% | Largest unrealized loss: ${open.length?Math.min(...unrealizedRois).toFixed(2):null}%`);
}

fs.writeFileSync(path.join(__dirname, 'validation-analysis-full.json'), JSON.stringify(results, null, 2));
console.log('\nWritten full analysis to validation-analysis-full.json (archived permanently)');
