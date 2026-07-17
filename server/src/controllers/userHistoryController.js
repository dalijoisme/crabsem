const userHistoryService = require("../services/userHistoryService");
const { sendSuccess, sendError } = require("../utils/apiResponse");

function isValidWalletParam(v){

    return typeof v === "string" && v.length >= 10 && v.length <= 100;

}

async function recordView(req, res, next){

    try{

        const { wallet, address } = req.params;

        if(!isValidWalletParam(wallet)) return sendError(res, 400, "Invalid wallet address");

        sendSuccess(res, userHistoryService.recordView(wallet, address));

    }
    catch(err){ next(err); }

}

async function getRecentlyViewed(req, res, next){

    try{

        sendSuccess(res, { tokens: userHistoryService.getRecentlyViewed(req.params.wallet, 100) });

    }
    catch(err){ next(err); }

}

async function getWatchlist(req, res, next){

    try{ sendSuccess(res, { tokens: userHistoryService.getWatchlist(req.params.wallet) }); }
    catch(err){ next(err); }

}

async function addWatchlist(req, res, next){

    try{ sendSuccess(res, userHistoryService.addToWatchlist(req.params.wallet, req.params.address)); }
    catch(err){ next(err); }

}

async function removeWatchlist(req, res, next){

    try{ sendSuccess(res, userHistoryService.removeFromWatchlist(req.params.wallet, req.params.address)); }
    catch(err){ next(err); }

}

async function getFavorites(req, res, next){

    try{ sendSuccess(res, { tokens: userHistoryService.getFavorites(req.params.wallet) }); }
    catch(err){ next(err); }

}

async function addFavorite(req, res, next){

    try{ sendSuccess(res, userHistoryService.addToFavorites(req.params.wallet, req.params.address)); }
    catch(err){ next(err); }

}

async function removeFavorite(req, res, next){

    try{ sendSuccess(res, userHistoryService.removeFromFavorites(req.params.wallet, req.params.address)); }
    catch(err){ next(err); }

}

module.exports = {
    recordView, getRecentlyViewed,
    getWatchlist, addWatchlist, removeWatchlist,
    getFavorites, addFavorite, removeFavorite
};
