// services/activityFeedTransformer.js - converts a raw GMGN KOL /
// smart-money feed item (from GET /v1/user/kol or
// /v1/user/smartmoney - both are real trade-activity feeds, verified
// live, not wallet directories) into rows for
// gmgnActivityFeedRepository.

function numberOrNull(value){

    return (value === undefined || value === null) ? null : Number(value);

}

function transformEntry(feedType, item){

    return {

        feedType,

        transactionHash: item.transaction_hash,

        chain: "sol",

        makerAddress: item.maker ?? null,

        makerTags: JSON.stringify(item.maker_info?.tags || []),

        makerTwitter: item.maker_info?.twitter_username || null,

        side: item.side ?? null,

        tokenAddress: item.base_address ?? null,

        tokenSymbol: item.base_token?.symbol ?? null,

        amountUsd: numberOrNull(item.amount_usd),

        priceUsd: numberOrNull(item.price_usd),

        txTimestamp: numberOrNull(item.timestamp),

        rawJson: JSON.stringify(item)

    };

}

function transformResponse(feedType, responseData){

    const list = Array.isArray(responseData?.list) ? responseData.list : [];

    return list

        .filter(item => item.transaction_hash)

        .map(item => transformEntry(feedType, item));

}

module.exports = { transformEntry, transformResponse };
