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
        launchTimestamp: numberOrNull(token.open_timestamp),

        rawJson: JSON.stringify(token)

    };

}

function transformTokens(tokens){

    return tokens.map(transformToken);

}

module.exports = { transformToken, transformTokens };
