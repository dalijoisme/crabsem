// services/trenchesTransformer.js - converts a raw GMGN trenches
// item into the plain JS shape gmgnTrenchesRepository persists. Pure
// mapping only.

function numberOrNull(value){

    return (value === undefined || value === null) ? null : Number(value);

}

function transformEntry(section, item){

    return {

        section,

        tokenAddress: item.address,

        symbol: item.symbol ?? null,

        name: item.name ?? null,

        chain: item.chain ?? null,

        marketCap: numberOrNull(item.market_cap),

        liquidity: numberOrNull(item.liquidity),

        holders: numberOrNull(item.holder_count),

        progress: numberOrNull(item.progress),

        status: item.status != null ? String(item.status) : null,

        swaps24h: numberOrNull(item.swaps_24h),

        buys24h: numberOrNull(item.buys_24h),

        sells24h: numberOrNull(item.sells_24h),

        netBuy24h: numberOrNull(item.net_buy_24h),

        rugRatio: numberOrNull(item.rug_ratio),

        top10HolderRate: numberOrNull(item.top_10_holder_rate),

        isHoneypot: item.is_honeypot != null ? Number(item.is_honeypot) : null,

        renouncedMint: item.renounced_mint != null ? Number(item.renounced_mint) : null,

        renouncedFreezeAccount: item.renounced_freeze_account != null ? Number(item.renounced_freeze_account) : null,

        sniperCount: numberOrNull(item.sniper_count),

        smartDegenCount: numberOrNull(item.smart_degen_count),

        creator: item.creator ?? null,

        launchpad: item.launchpad ?? null,

        launchpadPlatform: item.launchpad_platform ?? null,

        createdTimestamp: numberOrNull(item.created_timestamp),

        rawJson: JSON.stringify(item)

    };

}

// GMGN's response section keys don't always match the request keys
// verbatim (e.g. "near_completion" comes back as "pump" for sol) -
// this iterates whatever sections the response actually contains
// rather than assuming fixed names.

function transformResponse(responseData){

    const entries = [];

    for(const section of Object.keys(responseData)){

        const items = responseData[section];

        if(!Array.isArray(items)) continue;

        items.forEach(item => entries.push(transformEntry(section, item)));

    }

    return entries;

}

module.exports = { transformEntry, transformResponse };
