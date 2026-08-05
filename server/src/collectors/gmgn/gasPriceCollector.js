// collectors/gmgn/gasPriceCollector.js - collects the current
// Solana network fee snapshot from GET /v1/trade/gas_price.

const config = require("../../config/env");
const marketDataGateway = require("../../services/marketDataGateway");
const { transformResponse } = require("../../services/gasPriceTransformer");
const gmgnGasPriceRepository = require("../../repositories/gmgnGasPriceRepository");

const CHAIN = "sol";

async function collectGasPrice(){

    if(!config.GMGN_API_KEY){

        throw new Error("GMGN_API_KEY is not set in server/.env.");

    }

    const result = await marketDataGateway.getGasPrice(CHAIN);

    const entry = transformResponse(CHAIN, result.data);

    const id = gmgnGasPriceRepository.insertSnapshot(entry);

    return { chain: CHAIN, id };

}

module.exports = { collectGasPrice };
