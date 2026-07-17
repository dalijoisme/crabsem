// eslint-disable-next-line no-unused-vars
function errorHandler(err, req, res, next){

    console.error(err);

    const status = err.status || 500;

    res.status(status).json({

        success: false,

        error: "Internal Server Error",

        details: err.message || ""

    });

}

module.exports = errorHandler;
