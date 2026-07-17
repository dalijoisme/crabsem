// services/intelligence/curveHelper.js - shared lookup for the
// tiered curves in config/scoringConfig.js (earlinessCurve,
// priceStabilityCurve). Both express "as X grows, apply a smaller
// factor" as an ordered list of { maxX, factor } buckets - this
// just finds the first bucket whose bound the value falls under.

function lookupFactor(curve, value, boundKey){

    for(const bucket of curve){

        if(value <= bucket[boundKey]) return bucket.factor;

    }

    return curve[curve.length - 1].factor;

}

module.exports = { lookupFactor };
