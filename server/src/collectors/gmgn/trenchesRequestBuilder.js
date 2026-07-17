// collectors/gmgn/trenchesRequestBuilder.js - builds the POST body
// for /v1/trenches. Ported exactly from GMGN's own reference client
// (buildTrenchesBody in gmgn-cli's src/commands/market.ts) - omitting
// launchpad_platform/quote_address_type caused a response section to
// come back mislabeled in live testing against the real API, so this
// is not a simplified or guessed version of that logic.

const TRENCHES_PLATFORMS = {

    sol: [
        "Pump.fun", "pump_mayhem", "pump_mayhem_agent", "pump_agent",
        "letsbonk", "bonkers", "bags", "memoo", "liquid", "bankr", "zora",
        "surge", "anoncoin", "moonshot_app", "wendotdev", "heaven", "sugar",
        "token_mill", "believe", "trendsfun", "trends_fun", "jup_studio",
        "Moonshot", "boop", "ray_launchpad", "meteora_virtual_curve", "xstocks"
    ]

};

const TRENCHES_QUOTE_ADDRESS_TYPES = {

    sol: [4, 5, 3, 1, 13, 0]

};

function buildTrenchesBody(chain, { types, platforms, limit, filters } = {}){

    const selectedTypes = types?.length ? types : ["new_creation", "near_completion", "completed"];

    const launchpadPlatform = platforms?.length ? platforms : (TRENCHES_PLATFORMS[chain] ?? []);

    const quoteAddressType = TRENCHES_QUOTE_ADDRESS_TYPES[chain] ?? [];

    const actualLimit = limit ?? 80;

    const section = {

        filters: ["offchain", "onchain"],

        launchpad_platform_v2: true,

        limit: actualLimit,

        ...filters

    };

    if(launchpadPlatform.length) section.launchpad_platform = launchpadPlatform;

    if(quoteAddressType.length) section.quote_address_type = quoteAddressType;

    const body = { version: "v2" };

    for(const type of selectedTypes){

        body[type] = { ...section };

    }

    return body;

}

module.exports = { buildTrenchesBody };
