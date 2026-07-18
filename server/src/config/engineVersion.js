// config/engineVersion.js - the real, single source of truth for
// "what engine version is this". There was no version concept
// anywhere in this codebase before the CEO Dashboard sprint - bump
// this string (and the note) by hand whenever a real scoring/engine
// change ships (see scoringConfig.js/tradePlanConfig.js for what
// "the engine" means here - this project has no separate trained ML
// model, so "AI Model Version" in the dashboard is this same value,
// not a second, different number).
//
// services/engineVersionService.js records a real row in
// engine_version_history the first time the server starts up with a
// version it hasn't seen before, snapshotting real validation stats
// at that moment - never a fabricated historical entry.

module.exports = {

    version: "1.0.0",

    // What actually changed in this version - real, human-written,
    // updated by hand at the same time `version` is bumped.
    notes: "First tracked version - structural self-validation penalty, trade plan readiness gate, and the prediction_history-based AI Validation Framework (STRONG BUY/BUY/HOLD/AVOID, TP/SL/Expired) are all already live as of this version; nothing before this point was tracked."

};
