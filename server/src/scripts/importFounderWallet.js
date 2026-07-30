// scripts/importFounderWallet.js - one-time migration tool (Sprint A
// multi-tenant migration, deployment plan step 4). Carries the EXISTING,
// already-funded Founder wallet forward into the new trading_wallets
// table via services/walletService.js's importTradingWallet() - the
// same service-layer function, same encryptSecretKey(), same
// tradingWalletRepository.insertWallet() call generateTradingWallet()
// uses. No SQL of any kind lives in this file.
//
// The secret key is read from an interactive, non-echoed prompt only -
// never a CLI argument (would land in shell history / `ps`), never an
// env var. It is never logged, never written to a file, never returned
// by this script beyond the resulting public key.
//
// Usage: node src/scripts/importFounderWallet.js <founder-email>
// Run this AFTER the Founder has registered an account and connected +
// verified an Owner Wallet (importTradingWallet() requires both, same
// precondition generateTradingWallet() already has).

const readline = require("readline");
const userRepository = require("../repositories/userRepository");
const walletService = require("../services/walletService");
const config = require("../config/env");

// Prompts without echoing the typed characters back to the terminal -
// this is a private key, it must never appear on screen or in a
// terminal scrollback buffer.
function promptHidden(question){
    return new Promise((resolve) => {
        const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
        const realWrite = rl._writeToOutput.bind(rl);
        rl._writeToOutput = (str) => { if(str.startsWith(question)) realWrite(str); };
        rl.question(question, (answer) => {
            rl.close();
            process.stdout.write("\n");
            resolve(answer.trim());
        });
    });
}

async function main(){

    const email = process.argv[2];

    if(!email){
        console.error("Usage: node src/scripts/importFounderWallet.js <founder-email>");
        process.exit(1);
    }

    if(!config.FOUNDER_WALLET_PUBLIC_KEY){
        console.error("FOUNDER_WALLET_PUBLIC_KEY is not configured on this environment - refusing to run.");
        process.exit(1);
    }

    const user = userRepository.findByEmail(email);

    if(!user){
        console.error(`No registered user found for ${email}. Register the Founder account first (deployment plan step 3).`);
        process.exit(1);
    }

    console.log(`Target account: user_id=${user.id} (${email})`);
    console.log(`Required public key (FOUNDER_WALLET_PUBLIC_KEY): ${config.FOUNDER_WALLET_PUBLIC_KEY}`);
    console.log("A secret key that derives to any other public key will be refused before anything is stored.\n");

    const secretKeyInput = await promptHidden("Paste the Founder wallet's secret key (base58, or a JSON array of 64 numbers): ");

    const result = walletService.importTradingWallet(user.id, secretKeyInput);

    if(!result.ok){
        console.error(`\nImport FAILED (${result.error}): ${result.details}`);
        process.exit(1);
    }

    console.log(`\nImport succeeded. Trading Wallet public_key: ${result.publicKey}`);
    console.log("Next: deployment plan step 5 - verify this matches FOUNDER_WALLET_PUBLIC_KEY (it does, or importTradingWallet() would have refused it).");

    process.exit(0);

}

main().catch(err => { console.error("Import script crashed:", err.message); process.exit(1); });
