// services/walletService.js - CRAB User Journey v1 (locked). Two
// wallets, two jobs, never blurred:
//   - Owner Wallet (user_wallets): account ownership, security
//     verification, withdraw destination. NEVER used for trading.
//     Every connect/replace is recorded in user_wallet_history - never
//     a silent overwrite (see repositories/userWalletRepository.js).
//   - Trading Wallet (trading_wallets): a real Solana keypair CRAB
//     generates and holds, scoped only to this user's bot. The private
//     key is NEVER returned to any caller of this file - only
//     public_key ever leaves this module. Encrypted at rest with
//     TRADING_WALLET_ENCRYPTION_KEY - explicitly placeholder-grade
//     custody (see config/env.js's comment), not HSM/KMS-backed; real
//     custody architecture is the next sprint's named deliverable.
//     importTradingWallet() is the one exception to "CRAB always
//     generates it" - a Founder-only, migration-only path (Sprint A
//     multi-tenant migration) for carrying an already-funded wallet
//     forward instead of minting a new random one. Gated structurally
//     by matching the derived public key against
//     FOUNDER_WALLET_PUBLIC_KEY, not by caller identity.
//
// Allocation: allocation_pct (services/tradingBotService.js's
// setAllocation) is a percentage of the REAL on-chain Trading Wallet
// balance (getRealWalletBalance below) - trading_bot_config.initial_capital
// is always a derived recomputation of the two, never independently
// settable.
//
// Production Stabilization V1 (Sections D/E/Q): this file used to also
// own a self-reported "deposit" ledger (deposited_balance_usd) with its
// own depositFunds()/withdrawFunds() actions - removed. A real SOL
// deposit or withdrawal happens on-chain, outside this app entirely;
// the real balance (getRealWalletBalance) already reflects it on the
// very next read, with nothing here to keep manually in sync. Removing
// the two functions closes the exact gap that let the self-reported
// figure drift from the real wallet balance indefinitely.

const crypto = require("crypto");
const { Keypair, PublicKey } = require("@solana/web3.js");
const nacl = require("tweetnacl");
const bs58 = require("bs58");
const config = require("../config/env");
const userWalletRepository = require("../repositories/userWalletRepository");
const tradingWalletRepository = require("../repositories/tradingWalletRepository");
// Safe as a top-level require - pure math plus one function taking
// gmgnClient as a parameter, no requires of its own, so no circular-
// dependency risk (unlike ./execution below, which requires this file).
const { getSolUsdPrice, LAMPORTS_PER_SOL } = require("./execution/usdToSolConverter");

const CHALLENGE_TTL_MS = 5 * 60 * 1000; // 5 minutes - short-lived, per the plan

// Derives a real 32-byte AES key from whatever string
// TRADING_WALLET_ENCRYPTION_KEY happens to be (env vars are strings of
// arbitrary length, AES-256-GCM needs exactly 32 bytes) - sha256 is a
// deterministic, dependency-free way to get there.
function encryptionKey(){
    return crypto.createHash("sha256").update(config.TRADING_WALLET_ENCRYPTION_KEY).digest();
}

function encryptSecretKey(secretKeyBytes){
    const iv = crypto.randomBytes(12);
    const cipher = crypto.createCipheriv("aes-256-gcm", encryptionKey(), iv);
    const encrypted = Buffer.concat([cipher.update(Buffer.from(secretKeyBytes)), cipher.final()]);
    const authTag = cipher.getAuthTag();
    // ivHex:authTagHex:encryptedHex - self-contained, no separate column needed.
    return `${iv.toString("hex")}:${authTag.toString("hex")}:${encrypted.toString("hex")}`;
}

// Exported only for the Execution Layer sprint's own use (signing a
// real transaction) - never called by anything in this file after
// generateTradingWallet(), and never returned over HTTP by
// controllers/walletController.js.
function decryptSecretKey(encryptedString){
    const [ivHex, authTagHex, encryptedHex] = encryptedString.split(":");
    const decipher = crypto.createDecipheriv("aes-256-gcm", encryptionKey(), Buffer.from(ivHex, "hex"));
    decipher.setAuthTag(Buffer.from(authTagHex, "hex"));
    return Buffer.concat([decipher.update(Buffer.from(encryptedHex, "hex")), decipher.final()]);
}

// CRAB User Journey v1: every connect/replace is recorded, never a
// silent overwrite. previousAddress is null only for the very first
// connect, which has no "previous."
function connectWallet(userId, walletAddress){

    if(!walletAddress) return { ok: false, status: 400, error: "Bad request", details: "walletAddress is required." };

    let decoded;
    try{ decoded = new PublicKey(walletAddress); }
    catch(e){ return { ok: false, status: 400, error: "Bad request", details: "Not a valid Solana wallet address." }; }

    const existing = userWalletRepository.findByUserId(userId);
    const previousAddress = existing ? existing.wallet_address : null;

    userWalletRepository.upsertWallet(userId, decoded.toBase58());
    userWalletRepository.insertHistory({ userId, previousAddress, newAddress: decoded.toBase58() });

    return { ok: true };

}

// Stateless challenge, no new table needed: the message embeds its own
// expiry and a checksum (HMAC over the message text) using the same
// placeholder-grade server secret as Trading Wallet encryption - the
// verify step below recomputes the checksum rather than trusting a
// stored value, so nothing has to be persisted or cleaned up.
function issueOwnershipChallenge(userId){
    const nonce = crypto.randomBytes(16).toString("hex");
    const expiresAt = new Date(Date.now() + CHALLENGE_TTL_MS).toISOString();
    const message = `CRAB Owner Wallet Verification\nUser: ${userId}\nNonce: ${nonce}\nExpires: ${expiresAt}`;
    const checksum = crypto.createHmac("sha256", encryptionKey()).update(message).digest("hex");
    return { message, checksum };
}

function verifyOwnership(userId, { message, checksum, signature }){

    if(!message || !checksum || !signature){
        return { ok: false, status: 400, error: "Bad request", details: "message, checksum, and signature are required." };
    }

    const expectedChecksum = crypto.createHmac("sha256", encryptionKey()).update(message).digest("hex");
    const checksumBuf = Buffer.from(checksum, "hex");
    const expectedBuf = Buffer.from(expectedChecksum, "hex");
    if(checksumBuf.length !== expectedBuf.length || !crypto.timingSafeEqual(checksumBuf, expectedBuf)){
        return { ok: false, status: 400, error: "Bad request", details: "This challenge was not issued by this server or has been tampered with." };
    }

    const expiresMatch = /Expires: (.+)$/m.exec(message);
    if(!expiresMatch || new Date(expiresMatch[1]).getTime() < Date.now()){
        return { ok: false, status: 400, error: "Bad request", details: "This challenge has expired - request a new one." };
    }

    const wallet = userWalletRepository.findByUserId(userId);
    if(!wallet) return { ok: false, status: 400, error: "Bad request", details: "Connect an Owner Wallet first." };

    let signatureValid;
    try{
        const publicKeyBytes = new PublicKey(wallet.wallet_address).toBytes();
        const signatureBytes = Buffer.from(signature, "base64");
        signatureValid = nacl.sign.detached.verify(Buffer.from(message, "utf8"), signatureBytes, publicKeyBytes);
    }
    catch(e){ signatureValid = false; }

    if(!signatureValid) return { ok: false, status: 400, error: "Bad request", details: "Signature does not match the connected Owner Wallet." };

    userWalletRepository.markVerified(userId);
    return { ok: true };

}

function generateTradingWallet(userId){

    const ownerWallet = userWalletRepository.findByUserId(userId);
    if(!ownerWallet || !ownerWallet.verified_at){
        return { ok: false, status: 403, error: "Forbidden", details: "Verify your Owner Wallet before generating a Trading Wallet." };
    }

    if(tradingWalletRepository.findByUserId(userId)){
        return { ok: false, status: 409, error: "Conflict", details: "A Trading Wallet already exists for this account." };
    }

    const keypair = Keypair.generate();
    const publicKey = keypair.publicKey.toBase58();
    const encryptedPrivateKey = encryptSecretKey(keypair.secretKey);

    tradingWalletRepository.insertWallet({ userId, publicKey, encryptedPrivateKey });

    return { ok: true, publicKey };

}

// Accepts the two shapes a real Solana wallet's "Export Private Key"
// commonly produces: a base58 string (Phantom/Solflare), or the raw
// 64-byte secret key as a JSON array. Never accepts/derives from a
// public key or a mnemonic - only a real secret key round-trips through
// Keypair.fromSecretKey() to prove it's genuine below.
function parseSecretKey(secretKeyInput){
    if(Array.isArray(secretKeyInput)) return Uint8Array.from(secretKeyInput);
    if(typeof secretKeyInput === "string"){
        const trimmed = secretKeyInput.trim();
        if(trimmed.startsWith("[")) return Uint8Array.from(JSON.parse(trimmed));
        return bs58.decode(trimmed);
    }
    throw new Error("Unsupported secret key format");
}

// Migration-only counterpart to generateTradingWallet() above - imports
// an EXISTING keypair instead of minting a new random one, for exactly
// one purpose: carrying the already-funded Founder wallet forward into
// the multi-tenant trading_wallets table (migration 040) without losing
// its address. Every other precondition/side effect is identical to
// generateTradingWallet() (Owner Wallet verified, one Trading Wallet
// per user, encryptSecretKey(), tradingWalletRepository.insertWallet())
// - the only new check is the fail-closed match against
// FOUNDER_WALLET_PUBLIC_KEY below, which is what makes this Founder-only
// rather than a general "import any wallet" capability. The secret key
// is never logged, never returned, and never persisted anywhere except
// as the same AES-256-GCM ciphertext generateTradingWallet() already
// produces.
function importTradingWallet(userId, secretKeyInput){

    if(!config.FOUNDER_WALLET_PUBLIC_KEY){
        return { ok: false, status: 403, error: "Forbidden", details: "FOUNDER_WALLET_PUBLIC_KEY is not configured - wallet import is unavailable." };
    }

    const ownerWallet = userWalletRepository.findByUserId(userId);
    if(!ownerWallet || !ownerWallet.verified_at){
        return { ok: false, status: 403, error: "Forbidden", details: "Verify your Owner Wallet before importing a Trading Wallet." };
    }

    if(tradingWalletRepository.findByUserId(userId)){
        return { ok: false, status: 409, error: "Conflict", details: "A Trading Wallet already exists for this account." };
    }

    let secretKeyBytes;
    try{ secretKeyBytes = parseSecretKey(secretKeyInput); }
    catch(e){ return { ok: false, status: 400, error: "Bad request", details: "Could not parse the provided secret key - expected a base58 string or a JSON array of 64 numbers." }; }

    let keypair;
    try{ keypair = Keypair.fromSecretKey(secretKeyBytes); }
    catch(e){ return { ok: false, status: 400, error: "Bad request", details: "The provided value is not a valid Solana secret key." }; }

    const publicKey = keypair.publicKey.toBase58();

    // The one gate that makes this "Founder-only": structural, not
    // role-based - the exact same fail-closed pattern
    // services/execution/founderModeGuard.js already uses. Any secret
    // key that doesn't derive to the configured Founder wallet is
    // refused before anything is persisted.
    if(publicKey !== config.FOUNDER_WALLET_PUBLIC_KEY){
        return { ok: false, status: 403, error: "Forbidden", details: "This secret key does not match the configured Founder Trading Wallet - refusing to import." };
    }

    const encryptedPrivateKey = encryptSecretKey(keypair.secretKey);

    tradingWalletRepository.insertWallet({ userId, publicKey, encryptedPrivateKey });

    return { ok: true, publicKey };

}

// Trust/UX sprint: the real on-chain counterpart to depositedBalanceUsd
// above, which is a self-reported figure only ever set by a manual
// deposit call, never synced to the chain (the exact gap a real trade
// already exposed - dashboard said $67, the real wallet held $11.71).
// Reuses balanceValidationService/usdToSolConverter exactly as already
// proven at sell-time and pre-buy-sufficiency-time - no new RPC
// integration. Fails soft on every real-world gap (no RPC configured, a
// GMGN price-quote hiccup) - a dashboard read must never throw just
// because a network call it triggered had a bad moment; it returns an
// honest unavailableReason instead of a fabricated number.
async function getRealWalletBalance(userId){

    const trading = tradingWalletRepository.findByUserId(userId);
    if(!trading) return null;

    if(!config.SOLANA_RPC_URL){
        return { publicKey: trading.public_key, solLamports: null, solAmount: null, solUsdPrice: null, solUsd: null, unavailableReason: "SOLANA_RPC_URL is not configured" };
    }

    // Required lazily - services/execution/index.js requires this file
    // (walletService.js) itself, so a top-level require here would be
    // circular. Same convention services/tradingBotEngine.js's own
    // buildLiveExecutionOptions() already uses for the identical reason.
    const { balanceService, gmgnClient } = require("./execution");

    let solLamports;
    try{
        solLamports = await balanceService.getNativeSolBalanceLamports(trading.public_key);
    }
    catch(e){
        return { publicKey: trading.public_key, solLamports: null, solAmount: null, solUsdPrice: null, solUsd: null, unavailableReason: `RPC balance read failed: ${e.message}` };
    }

    const solAmount = solLamports / LAMPORTS_PER_SOL;

    // The lamports figure above is already real and final regardless of
    // what happens next - a failed USD price probe only ever nulls out
    // the USD conversion, never the real balance itself.
    let solUsdPrice = null, solUsd = null;
    try{
        solUsdPrice = await getSolUsdPrice(gmgnClient, trading.public_key);
        solUsd = solAmount * solUsdPrice;
    }
    catch(e){ /* price probe failed - solLamports/solAmount above are still real and returned */ }

    return { publicKey: trading.public_key, solLamports, solAmount, solUsdPrice, solUsd, unavailableReason: null };

}

// Async as of the Trust/UX sprint (was sync) - its one real caller
// (controllers/ownerWalletController.js's status handler) is already an
// async Express handler; nothing else in the codebase calls
// walletService.getStatus() (confirmed by grep), so this has no
// hot-path/trading-engine impact.
async function getStatus(userId){
    const owner = userWalletRepository.findByUserId(userId);
    const trading = tradingWalletRepository.findByUserId(userId);
    const realBalance = trading ? await getRealWalletBalance(userId) : null;
    return {
        ownerWallet: owner ? { address: owner.wallet_address, verified: Boolean(owner.verified_at) } : null,
        tradingWallet: trading ? {
            publicKey: trading.public_key,
            realSolBalanceLamports: realBalance?.solLamports ?? null,
            realSolAmount: realBalance?.solAmount ?? null,
            realSolUsdPrice: realBalance?.solUsdPrice ?? null,
            realSolUsd: realBalance?.solUsd ?? null,
            realBalanceUnavailableReason: realBalance?.unavailableReason ?? null
        } : null
    };
}

module.exports = {
    connectWallet, issueOwnershipChallenge, verifyOwnership,
    generateTradingWallet, importTradingWallet, getStatus, getRealWalletBalance,
    decryptSecretKey
};
