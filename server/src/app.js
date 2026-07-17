const express = require("express");
const cors = require("cors");
const routes = require("./routes");
const errorHandler = require("./middleware/errorHandler");

const app = express();

app.use(cors());
app.use(express.json());

app.use("/api", routes);

// Any /api/* path that didn't match a route above - keeps 404s as
// the same consistent JSON envelope as every other error, instead
// of Express's default HTML 404 page.

app.use("/api", (req, res) => {

    res.status(404).json({

        success: false,

        error: "Not Found",

        details: `No route matches ${req.method} ${req.originalUrl}`

    });

});

app.use(errorHandler);

module.exports = app;
