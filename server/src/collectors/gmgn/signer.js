// collectors/gmgn/signer.js - Ed25519 / RSA-SHA256 request-signing
// utility for the GMGN OpenAPI.
//
// The wire-level signing format is not published on docs.gmgn.ai, so
// this is ported directly from GMGN's own official reference client
// (source of truth, not guessed):
// https://github.com/GMGNAI/gmgn-skills/blob/main/src/client/signer.ts

const crypto = require("crypto");

function detectAlgorithm(pem){

    const key = crypto.createPrivateKey(pem);

    switch(key.asymmetricKeyType){

        case "ed25519": return "Ed25519";

        case "rsa": return "RSA-SHA256";

        default:
            throw new Error(`Unsupported key type: ${key.asymmetricKeyType}. Supported: Ed25519, RSA`);

    }

}

// timestamp: Unix seconds, server validates within +/-5s
// client_id: UUID, replays rejected within 7s

function buildAuthQuery(){

    return {

        timestamp: Math.floor(Date.now() / 1000),

        client_id: crypto.randomUUID()

    };

}

// Message format: {sub_path}:{sorted_query_string}:{request_body}:{timestamp}
// sorted_query_string: every query param (including timestamp, client_id)
// sorted alphabetically by key; array values become repeated k=v pairs,
// sorted by value.

function buildMessage(subPath, queryParams, body, timestamp){

    const sortedQs = Object.keys(queryParams)
        .sort()
        .flatMap(k => {

            const ek = encodeURIComponent(k);
            const v = queryParams[k];

            if(Array.isArray(v)){

                return [...v].sort().map(item => `${ek}=${encodeURIComponent(item)}`);

            }

            return [`${ek}=${encodeURIComponent(String(v))}`];

        })
        .join("&");

    return `${subPath}:${sortedQs}:${body}:${timestamp}`;

}

// Ed25519: signs raw message bytes (no hashing).
// RSA-SHA256: RSA-PSS + SHA256, salt length = 32.

function sign(message, privateKeyPem, algorithm){

    const msgBuf = Buffer.from(message, "utf-8");

    if(algorithm === "Ed25519"){

        const sig = crypto.sign(null, msgBuf, privateKeyPem);

        return sig.toString("base64");

    }

    const sig = crypto.sign("sha256", msgBuf, {

        key: privateKeyPem,

        padding: crypto.constants.RSA_PKCS1_PSS_PADDING,

        saltLength: 32

    });

    return sig.toString("base64");

}

module.exports = { detectAlgorithm, buildAuthQuery, buildMessage, sign };
