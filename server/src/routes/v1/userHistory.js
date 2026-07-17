const express = require("express");
const controller = require("../../controllers/userHistoryController");

const router = express.Router();

router.post("/users/:wallet/views/:address", controller.recordView);
router.get("/users/:wallet/recently-viewed", controller.getRecentlyViewed);

router.get("/users/:wallet/watchlist", controller.getWatchlist);
router.post("/users/:wallet/watchlist/:address", controller.addWatchlist);
router.delete("/users/:wallet/watchlist/:address", controller.removeWatchlist);

router.get("/users/:wallet/favorites", controller.getFavorites);
router.post("/users/:wallet/favorites/:address", controller.addFavorite);
router.delete("/users/:wallet/favorites/:address", controller.removeFavorite);

module.exports = router;
