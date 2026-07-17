// services/intelligence/participant/developer.js - creator/dev
// wallet track record. gmgn_trenches only promotes `creator` to a
// dedicated column; creator_created_count, creator_created_open_ratio
// and creator_balance_rate are real GMGN fields present in the same
// row's raw_json but not (yet) promoted to columns - parsed here
// defensively rather than via a schema migration, since this sprint
// is about scoring philosophy, not schema changes.
//
// Not timing-sensitive: a developer's track record doesn't change
// based on this token's recent price action.

const config = require("../../../config/scoringConfig");

const MAX_SCORE = config.participant.weights.developer;

function parseRawFields(trenchesEntry){

    if(!trenchesEntry?.raw_json) return null;

    try{

        const raw = JSON.parse(trenchesEntry.raw_json);

        return {

            createdCount: raw.creator_created_count != null ? Number(raw.creator_created_count) : null,

            openRatio: raw.creator_created_open_ratio != null ? Number(raw.creator_created_open_ratio) : null,

            balanceRate: raw.creator_balance_rate != null ? Number(raw.creator_balance_rate) : null

        };

    }
    catch(e){

        return null;

    }

}

function score(trenchesEntry){

    const fields = parseRawFields(trenchesEntry);

    if(!trenchesEntry?.creator || !fields || fields.createdCount == null){

        return {

            score: Math.round(MAX_SCORE * config.participant.neutralFraction),

            max: MAX_SCORE,

            hasData: false,

            reasons: [],

            riskReasons: []

        };

    }

    const reasons = [];

    const riskReasons = [];

    let raw;

    if(fields.createdCount === 0){

        raw = MAX_SCORE * 0.4; // brand new dev, no track record either way

    }
    else if(fields.openRatio != null && fields.openRatio >= 0.5 && fields.createdCount >= 3){

        raw = MAX_SCORE;

        reasons.push(`Developer has a strong track record (${Math.round(fields.openRatio*100)}% of ${fields.createdCount} prior tokens graduated)`);

    }
    else if(fields.openRatio != null && fields.openRatio < 0.2 && fields.createdCount >= 5){

        raw = MAX_SCORE * 0.1;

        riskReasons.push(`Developer has a weak track record (only ${Math.round(fields.openRatio*100)}% of ${fields.createdCount} prior tokens graduated)`);

    }
    else{

        raw = MAX_SCORE * 0.5;

    }

    if(fields.balanceRate != null && fields.balanceRate >= 0.15){

        raw *= 0.6;

        riskReasons.push(`Developer still holds ${(fields.balanceRate*100).toFixed(0)}% of supply - dump risk`);

    }

    return { score: Math.round(raw), max: MAX_SCORE, hasData: true, reasons, riskReasons };

}

module.exports = { score, MAX_SCORE };
