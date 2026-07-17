// services/statsService.js - thin orchestration for GET /stats.

const gmgnTokenRepository = require("../repositories/gmgnTokenRepository");

function getStats(){

    return gmgnTokenRepository.getStats();

}

module.exports = { getStats };
