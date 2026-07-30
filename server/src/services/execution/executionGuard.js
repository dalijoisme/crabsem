// services/execution/executionGuard.js - safety checks that can only
// run AFTER a real, priced, routed GMGN quote comes back. Price
// impact, actual slippage, and route complexity are facts about ONE
// specific swap attempt at this exact moment, not facts about the
// token in general - that's why they live here, in the execution
// layer, rather than in Production V2 (see the Sprint 2 plan for the
// full reasoning).
//
// Never overrides Production V2's decision and never touches
// safetyVeto/structuralValidation - this can only REJECT a trade
// Production V2 already decided to attempt, the same "veto, never
// promote" shape scoringConfig.js's own market-health veto already
// uses. Pure function, no I/O, easy to test with a fake quote object.

const DEFAULT_MAX_PRICE_IMPACT_PCT = 5;   // reject if the quote itself reports more than this
const DEFAULT_MAX_SLIPPAGE_PCT = 15;      // reject if the requested slippage tolerance is unreasonably wide
const DEFAULT_MAX_ROUTE_HOPS = 3;         // reject an overly complex/fragile route

/**
 * @typedef {object} ExecutionGuardLimits
 * @property {number} [maxPriceImpactPct]
 * @property {number} [maxSlippagePct]
 * @property {number} [maxRouteHops]
 */

/**
 * @param {object} quoteResponse - the real GMGN GET /v1/trade/quote response body
 * @param {ExecutionGuardLimits} [limits]
 * @returns {{ priceImpactPct: number, requestedSlippagePct: number, routeHops: number }}
 * @throws {Error} a specific, descriptive reason the moment any check fails
 */
function assertQuoteIsSafeToExecute(quoteResponse, limits = {}){

    const maxPriceImpactPct = limits.maxPriceImpactPct ?? DEFAULT_MAX_PRICE_IMPACT_PCT;
    const maxSlippagePct = limits.maxSlippagePct ?? DEFAULT_MAX_SLIPPAGE_PCT;
    const maxRouteHops = limits.maxRouteHops ?? DEFAULT_MAX_ROUTE_HOPS;

    const priceImpactPct = Number(quoteResponse?.tx?.quote?.priceImpactPct ?? 0);
    if(priceImpactPct > maxPriceImpactPct){
        throw new Error(`executionGuard: price impact ${priceImpactPct}% exceeds the ${maxPriceImpactPct}% limit - route too thin for this size.`);
    }

    const requestedSlippagePct = Number(quoteResponse?.slippage ?? 0);
    if(requestedSlippagePct > maxSlippagePct){
        throw new Error(`executionGuard: slippage ${requestedSlippagePct}% exceeds the ${maxSlippagePct}% limit.`);
    }

    const routePlan = quoteResponse?.tx?.quote?.routePlan ?? [];
    if(routePlan.length === 0){
        throw new Error("executionGuard: quote returned no route - nothing to execute.");
    }
    if(routePlan.length > maxRouteHops){
        throw new Error(`executionGuard: route has ${routePlan.length} hops, exceeding the ${maxRouteHops}-hop limit - too fragile/complex.`);
    }

    const outputAmount = Number(quoteResponse?.output_amount ?? 0);
    const minOutputAmount = Number(quoteResponse?.min_output_amount ?? 0);
    if(outputAmount <= 0 || minOutputAmount <= 0){
        throw new Error("executionGuard: quote returned a non-positive output amount - refusing to execute.");
    }

    return { priceImpactPct, requestedSlippagePct, routeHops: routePlan.length };

}

module.exports = { assertQuoteIsSafeToExecute, DEFAULT_MAX_PRICE_IMPACT_PCT, DEFAULT_MAX_SLIPPAGE_PCT, DEFAULT_MAX_ROUTE_HOPS };
