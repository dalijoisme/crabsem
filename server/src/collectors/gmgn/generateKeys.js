// collectors/gmgn/generateKeys.js - one-time setup script.
// Run with: npm run gmgn:generate-keys [-- --force]
//
// Generates an Ed25519 keypair for signing GMGN OpenAPI requests,
// writes GMGN_PRIVATE_KEY into server/.env (never printed to stdout),
// and writes the public key to server/keys/gmgn_ed25519_public.pem so
// it can be pasted into https://gmgn.ai/ai to obtain a GMGN_API_KEY.

const fs = require("fs");
const path = require("path");
const crypto = require("crypto");

const ENV_PATH = path.resolve(__dirname, "../../../.env");
const KEYS_DIR = path.resolve(__dirname, "../../../keys");
const PUBLIC_KEY_PATH = path.join(KEYS_DIR, "gmgn_ed25519_public.pem");

function readEnv(){

    return fs.existsSync(ENV_PATH) ? fs.readFileSync(ENV_PATH, "utf8") : "";

}

function envHasPrivateKey(content){

    return /^GMGN_PRIVATE_KEY=.+$/m.test(content);

}

function upsertEnvVar(content, key, value){

    const line = `${key}=${value}`;

    const pattern = new RegExp(`^${key}=.*$`, "m");

    if(pattern.test(content)){

        return content.replace(pattern, line);

    }

    const separator = content.length === 0 || content.endsWith("\n") ? "" : "\n";

    return `${content}${separator}${line}\n`;

}

function main(){

    const force = process.argv.includes("--force");

    let envContent = readEnv();

    if(envHasPrivateKey(envContent) && !force){

        console.error(
            "GMGN_PRIVATE_KEY already exists in server/.env. Refusing to overwrite it: " +
            "the matching public key may already be registered with GMGN, and " +
            "regenerating would silently break future signed requests. Re-run with " +
            "`npm run gmgn:generate-keys -- --force` if you intend to replace it and " +
            "re-register the new public key at https://gmgn.ai/ai."
        );

        process.exit(1);

    }

    const { publicKey, privateKey } = crypto.generateKeyPairSync("ed25519", {

        publicKeyEncoding: { type: "spki", format: "pem" },

        privateKeyEncoding: { type: "pkcs8", format: "pem" }

    });

    fs.mkdirSync(KEYS_DIR, { recursive: true });

    fs.writeFileSync(PUBLIC_KEY_PATH, publicKey, { mode: 0o600 });

    const escapedPrivateKey = privateKey.trim().replace(/\n/g, "\\n");

    envContent = upsertEnvVar(envContent, "GMGN_PRIVATE_KEY", `"${escapedPrivateKey}"`);

    if(!/^GMGN_API_KEY=.*$/m.test(envContent)){

        envContent = upsertEnvVar(envContent, "GMGN_API_KEY", "");

    }

    if(!/^GMGN_HOST=.*$/m.test(envContent)){

        envContent = upsertEnvVar(envContent, "GMGN_HOST", "https://openapi.gmgn.ai");

    }

    fs.writeFileSync(ENV_PATH, envContent, { mode: 0o600 });

    console.log("Ed25519 keypair generated.");
    console.log("");
    console.log("Private key written to server/.env as GMGN_PRIVATE_KEY (not printed here).");
    console.log(`Public key written to: ${PUBLIC_KEY_PATH}`);
    console.log("");
    console.log("Next steps:");
    console.log("1. Open the public key file above and copy its FULL contents,");
    console.log("   including the BEGIN/END lines.");
    console.log("2. Go to https://gmgn.ai/ai and paste it to register your public key.");
    console.log("3. GMGN will issue an API key - copy it into server/.env as GMGN_API_KEY.");
    console.log("4. Run: npm run gmgn:verify-auth");

}

main();
