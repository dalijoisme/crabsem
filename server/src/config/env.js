require("dotenv").config();

const config = Object.freeze({

    PORT: Number(process.env.PORT) || 4000,

    DB_PATH: process.env.DB_PATH || "./data/crabsem.sqlite",

    NODE_ENV: process.env.NODE_ENV || "development",

    // GMGN OpenAPI - GMGN_PRIVATE_KEY is stored with escaped \n (see
    // collectors/gmgn/generateKeys.js), restored to real newlines here.

    GMGN_API_KEY: process.env.GMGN_API_KEY || null,

    GMGN_PRIVATE_KEY: process.env.GMGN_PRIVATE_KEY
        ? process.env.GMGN_PRIVATE_KEY.replace(/\\n/g, "\n")
        : null,

    GMGN_HOST: process.env.GMGN_HOST || "https://openapi.gmgn.ai"

});

module.exports = config;
