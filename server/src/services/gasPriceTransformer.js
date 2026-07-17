// services/gasPriceTransformer.js - converts a raw GMGN gas_price
// response into the row gmgnGasPriceRepository persists. Fields
// verified live: chain, auto, high, average, low,
// native_token_usd_price (auto/high/average/low are strings, GMGN's
// own convention for fee values).

function numberOrNull(value){

    return (value === undefined || value === null) ? null : Number(value);

}

function transformResponse(chain, responseData){

    return {

        chain,

        autoFee: numberOrNull(responseData.auto),

        highFee: numberOrNull(responseData.high),

        averageFee: numberOrNull(responseData.average),

        lowFee: numberOrNull(responseData.low),

        nativeTokenUsdPrice: numberOrNull(responseData.native_token_usd_price),

        rawJson: JSON.stringify(responseData)

    };

}

module.exports = { transformResponse };
