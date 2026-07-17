// services/hotSearchesTransformer.js - converts a raw GMGN
// hot_searches response group into rows for gmgnHotSearchesRepository.
// Response shape (verified live): array of
// { interval, chain, version, tokens: [...] } groups.

function numberOrNull(value){

    return (value === undefined || value === null) ? null : Number(value);

}

function transformGroup(group){

    const tokens = Array.isArray(group.tokens) ? group.tokens : [];

    return tokens.map((token, index) => ({

        tokenAddress: token.address,

        symbol: token.symbol ?? null,

        name: token.name ?? null,

        chain: group.chain,

        interval: group.interval,

        rankPosition: index + 1,

        price: numberOrNull(token.price),

        marketCap: numberOrNull(token.market_cap),

        liquidity: numberOrNull(token.liquidity),

        volume: numberOrNull(token.volume),

        priceChangePercent: numberOrNull(token.price_change_percent),

        holders: numberOrNull(token.holder_count),

        rawJson: JSON.stringify(token)

    }));

}

function transformResponse(responseData){

    const groups = Array.isArray(responseData) ? responseData : [];

    return groups.flatMap(transformGroup);

}

module.exports = { transformGroup, transformResponse };
