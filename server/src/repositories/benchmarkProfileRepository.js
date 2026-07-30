// repositories/benchmarkProfileRepository.js - the only place that
// reads/writes benchmark_profiles. This table IS the "config only, no
// code changes" extensibility point from the Benchmark Harness
// Architecture Design Document section 4/8 - adding a new benchmark
// participant (e.g. "CONFIDENCE_68") is an INSERT here, nothing else.

const db = require("../database/connection");

function findAll(){
    return db.prepare("SELECT * FROM benchmark_profiles ORDER BY id ASC").all();
}

function findById(id){
    return db.prepare("SELECT * FROM benchmark_profiles WHERE id = ?").get(id);
}

function findByName(name){
    return db.prepare("SELECT * FROM benchmark_profiles WHERE name = ?").get(name);
}

const insertStmt = db.prepare(`
    INSERT INTO benchmark_profiles (name, description, config_json)
    VALUES (@name, @description, @configJson)
`);

function create({ name, description, configJson }){
    const info = insertStmt.run({ name, description: description ?? null, configJson });
    return findById(info.lastInsertRowid);
}

module.exports = { findAll, findById, findByName, create };
