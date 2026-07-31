// services/tokenTransformer.js - converts a single raw GMGN token
// object (from GET /v1/market/rank) into the plain JS shape the
// gmgn_tokens repository persists. Pure data mapping only - no SQL,
// no fetch calls, no collector logic.
//
// Field provenance (verified against a real stored response, not
// guessed):
// - Directly mapped fields (symbol, name, chain, logo, market_cap,
//   liquidity, price, price_change_percent5m/1h, volume, holder_count,
//   open_timestamp) are real GMGN fields.
// - price_change_24h, volume_5m, volume_24h, buys_5m, sells_5m are
//   left null: GET /v1/market/rank only returns figures for the
//   single interval that was requested (this project always requests
//   interval=1h), plus fixed 1m/5m/1h price-change windows - there is
//   no real 24h volume/price-change or 5m buy/sell count in that
//   response to put in those columns. Populating them would mean
//   mislabeling 1h data as 5m/24h data, which is not real data for
//   those columns.
// - fdv is not returned directly; it is derived from two real fields
//   using the standard fully-diluted-valuation formula
//   (price * total_supply), not fabricated.

function numberOrNull(value){

    return (value === undefined || value === null) ? null : Number(value);

}

// False Positive Reduction V4 (data-integrity fix, not a threshold):
// verified against a direct query of the real local dataset that GMGN's
// own `open_timestamp` field is a literal 0 - not null, not undefined,
// a real "0" - for 8,722 of 12,387 tokens (70.4%) in this database.
// numberOrNull(0) previously passed that 0 straight through, which the
// repository then converts to a real SQL datetime: 1970-01-01 00:00:00.
// Every downstream reader of gmgn_tokens.launch_time (emiService.js's
// resolveTokenAgeMinutes, walletIntelligenceService.js's sniper-timing
// check) does a plain truthy check (`if(token.launch_time)`) - a non-
// empty 1970 datetime STRING is truthy, so both readers took it as a
// real, ~55-year-old token age instead of "unknown," and - critically -
// emiService.js's own already-existing fallback to
// gmgn_trenches.created_timestamp (verified real for 1,701 of a 2,000-
// row sample of these exact epoch-zero tokens, including all 7 of this
// account's own real BUYs) was never reached, because the truthy check
// short-circuited first. This is the same "never fabricate, honest null
// over a wrong value" convention already used everywhere else in this
// file (see numberOrNull above) - GMGN's 0 sentinel is not real launch
// data and must not be treated as if it were.
function realLaunchTimestampOrNull(value){

    const n = numberOrNull(value);

    return (n == null || n <= 0) ? null : n;

}

function transformToken(token){

    return {

        tokenAddress: token.address,

        symbol: token.symbol ?? null,

        name: token.name ?? null,

        chain: token.chain ?? null,

        logo: token.logo ?? null,

        marketCap: numberOrNull(token.market_cap),

        liquidity: numberOrNull(token.liquidity),

        price: numberOrNull(token.price),

        priceChange5m: numberOrNull(token.price_change_percent5m),

        priceChange1h: numberOrNull(token.price_change_percent1h),

        priceChange24h: null,

        volume5m: null,

        volume1h: numberOrNull(token.volume),

        volume24h: null,

        buys5m: null,

        sells5m: null,

        holders: numberOrNull(token.holder_count),

        fdv: (token.price != null && token.total_supply != null)
            ? Number(token.price) * Number(token.total_supply)
            : null,

        // Unix seconds; the repository converts this to the DB's
        // datetime format so this service stays database-agnostic.
        launchTimestamp: realLaunchTimestampOrNull(token.open_timestamp),

        rawJson: JSON.stringify(token)

    };

}

function transformTokens(tokens){

    return tokens.map(transformToken);

}

module.exports = { transformToken, transformTokens };
