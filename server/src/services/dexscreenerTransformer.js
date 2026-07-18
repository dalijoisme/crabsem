// services/dexscreenerTransformer.js - converts one real DexScreener
// "pair" object (already filtered to chainId === "solana" and picked
// as the highest-liquidity pair for its base token - see
// globalSearchService.js) into the exact same plain-JS shape
// tokenTransformer.js produces from a GMGN row, so it can go through
// the identical gmgnTokenRepository.upsertToken() write path. Pure
// data mapping only.
//
// Field provenance - every field is either a real DexScreener field
// or explicitly null (never guessed):
// - holders: DexScreener's public API does not return a holder
//   count at all - left null, exactly like any other module that
//   lacks real data (see intelligenceEngine.js's hasData:false
//   convention). It is NOT estimated from liquidity/volume.
// - priceChange24h/volume5m/volume24h/buys5m/sells5m: real, DexScreener
//   returns all of h24/h6/h1/m5 buckets (unlike GMGN's rank response,
//   which only returns the single requested interval) - a strictly
//   richer real dataset for these fields than the GMGN collector path.

function numberOrNull(value){

    return (value === undefined || value === null) ? null : Number(value);

}

function transformPair(pair){

    const base = pair.baseToken || {};

    return {

        tokenAddress: base.address,

        symbol: base.symbol ?? null,

        name: base.name ?? null,

        chain: "sol",

        logo: pair.info?.imageUrl ?? null,

        marketCap: numberOrNull(pair.marketCap ?? pair.fdv),

        liquidity: numberOrNull(pair.liquidity?.usd),

        price: numberOrNull(pair.priceUsd),

        priceChange5m: numberOrNull(pair.priceChange?.m5),

        priceChange1h: numberOrNull(pair.priceChange?.h1),

        priceChange24h: numberOrNull(pair.priceChange?.h24),

        volume5m: numberOrNull(pair.volume?.m5),

        volume1h: numberOrNull(pair.volume?.h1),

        volume24h: numberOrNull(pair.volume?.h24),

        buys5m: numberOrNull(pair.txns?.m5?.buys),

        sells5m: numberOrNull(pair.txns?.m5?.sells),

        holders: null,

        fdv: numberOrNull(pair.fdv),

        launchTimestamp: pair.pairCreatedAt != null ? Math.floor(Number(pair.pairCreatedAt) / 1000) : null,

        rawJson: JSON.stringify(pair)

    };

}

module.exports = { transformPair };
