// services/marketIntelligenceService.js - read-side orchestration
// for every scheduled-collection GMGN data type (trenches,
// hot-searches, KOL/smart-money activity, gas price, launchpad
// stats). No SQL here - only repository calls.

const gmgnTrenchesRepository = require("../repositories/gmgnTrenchesRepository");
const gmgnHotSearchesRepository = require("../repositories/gmgnHotSearchesRepository");
const gmgnActivityFeedRepository = require("../repositories/gmgnActivityFeedRepository");
const gmgnGasPriceRepository = require("../repositories/gmgnGasPriceRepository");
const gmgnLaunchpadStatsRepository = require("../repositories/gmgnLaunchpadStatsRepository");

const VALID_SECTIONS = ["new_creation", "pump", "completed"];

function getTrenches(section, limit){

    if(!VALID_SECTIONS.includes(section)){

        throw Object.assign(new Error(`section must be one of: ${VALID_SECTIONS.join(", ")}`), { status: 400 });

    }

    return { section, tokens: gmgnTrenchesRepository.findBySection(section, limit) };

}

function getHotSearches(chain, interval, limit){

    return { chain, interval, tokens: gmgnHotSearchesRepository.findByChain(chain, interval, limit) };

}

function getActivityFeed(feedType, limit){

    if(feedType !== "kol" && feedType !== "smart_money"){

        throw Object.assign(new Error(`feedType must be "kol" or "smart_money"`), { status: 400 });

    }

    return {

        feedType,

        activity: gmgnActivityFeedRepository.findByType(feedType, limit).map(row => ({

            ...row,

            maker_tags: JSON.parse(row.maker_tags || "[]")

        }))

    };

}

function getGasPrice(chain){

    return gmgnGasPriceRepository.getLatest(chain);

}

function getLaunchpadStats(){

    return { launchpads: gmgnLaunchpadStatsRepository.findAll() };

}

module.exports = { getTrenches, getHotSearches, getActivityFeed, getGasPrice, getLaunchpadStats, VALID_SECTIONS };
