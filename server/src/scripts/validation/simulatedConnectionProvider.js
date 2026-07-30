// scripts/validation/simulatedConnectionProvider.js - a configurable,
// deterministic fake of the same interface
// services/execution/solanaConnectionProvider.js exposes. Used by
// every Sprint 1.5 script that validates pipeline LOGIC (state
// transitions, DB consistency, crash recovery, balance edge cases,
// throughput) rather than real network behavior, which is covered
// separately, for real, by founderDryRun.js against actual devnet.
//
// Deliberately structured the same way the Sprint 1 unit test fakes
// are (see services/execution/*.test.js) - this is that same pattern,
// generalized into one reusable module instead of being re-written
// per test file, and made swappable mid-run (setBehavior) so a single
// long stress test can vary its scenario mix call by call.

function sleep(ms){
    return new Promise(resolve => setTimeout(resolve, ms));
}

// A blockhash is a real 32-byte value, base58-encoded - it is NOT
// "any 32 base58 characters" (base58 is not a fixed-width encoding;
// an arbitrary 32-character string decodes to a variable, almost never
// 32-byte, buffer). transactionSigningService.js really signs this
// simulated transaction with real @solana/web3.js crypto, and
// Transaction.serialize() validates the blockhash is exactly 32 bytes -
// so this MUST be a genuinely valid 32-byte-decoding value, the same
// way a real Connection's getLatestBlockhash() would return one. The
// cheapest source of a guaranteed-valid one is a fresh keypair's own
// public key (Ed25519 public keys are always exactly 32 bytes).
function randomValid32ByteBase58(){
    return require("@solana/web3.js").Keypair.generate().publicKey.toBase58();
}

// Opaque signature/tx-hash placeholder - unlike the blockhash above,
// nothing in the pipeline decodes this as bytes (it's stored as plain
// TEXT), so any distinguishable string is fine here.
function randomOpaqueId(prefix){
    const alphabet = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";
    let out = prefix;
    for(let i = 0; i < 16; i++) out += alphabet[Math.floor(Math.random() * alphabet.length)];
    return out;
}

/**
 * @param {object} initialBehavior - see `behaviors` below for shape
 */
function createSimulatedConnectionProvider(initialBehavior){

    let behavior = initialBehavior;
    let callCount = 0;
    const latencies = [];

    async function timed(fn){
        callCount++;
        const startedAt = Date.now();
        try{
            return await fn();
        }
        finally{
            latencies.push(Date.now() - startedAt);
        }
    }

    function getConnection(){
        return {
            getLatestBlockhash: () => timed(() => behavior.latestBlockhash()),
            sendRawTransaction: () => timed(() => behavior.sendRawTransaction()),
            getSignatureStatus: (signature) => timed(() => behavior.signatureStatus(signature)),
            getBlockHeight: () => timed(() => behavior.blockHeight()),
            getBalance: (publicKey) => timed(() => behavior.balance(publicKey)),
            getParsedTokenAccountsByOwner: (owner, opts) => timed(() => behavior.tokenAccounts(owner, opts))
        };
    }

    return {
        getConnection,
        getEndpoint: () => "simulated-rpc",
        setBehavior(next){ behavior = next; },
        getCallCount: () => callCount,
        getLatencies: () => latencies.slice(),
        resetStats(){ callCount = 0; latencies.length = 0; }
    };

}

// Ready-made, composable behavior presets. Every preset builds on
// `success` via spread so a scenario only ever overrides the one call
// it needs to change - the rest of the pipeline behaves normally,
// which is what makes each preset test ONE specific failure mode in
// isolation rather than an unrealistic all-broken RPC.
const behaviors = {

    success(opts = {}){
        const latencyMs = opts.latencyMs ?? 5;
        return {
            async latestBlockhash(){ await sleep(latencyMs); return { blockhash: randomValid32ByteBase58(), lastValidBlockHeight: 1_000_000 }; },
            async sendRawTransaction(){ await sleep(latencyMs); return randomOpaqueId("SimSig"); },
            async signatureStatus(){ await sleep(latencyMs); return { value: { err: null, confirmationStatus: "confirmed", slot: 1 } }; },
            async blockHeight(){ await sleep(latencyMs); return 1; },
            async balance(){ await sleep(latencyMs); return opts.balanceLamports ?? 1_000_000_000; },
            async tokenAccounts(){ await sleep(latencyMs); return { value: opts.tokenAccounts ?? [] }; }
        };
    },

    onChainError(opts = {}){
        const base = behaviors.success(opts);
        return { ...base, async signatureStatus(){ await sleep(opts.latencyMs ?? 5); return { value: { err: { InstructionError: [0, "Custom"] }, confirmationStatus: "confirmed", slot: 1 } }; } };
    },

    pollTimeout(opts = {}){
        const base = behaviors.success(opts);
        return { ...base, async signatureStatus(){ await sleep(opts.latencyMs ?? 5); return { value: null }; }, async blockHeight(){ return 1; } };
    },

    blockhashExpired(opts = {}){
        const base = behaviors.success(opts);
        return { ...base, async signatureStatus(){ await sleep(opts.latencyMs ?? 5); return { value: null }; }, async blockHeight(){ return 999_999_999; } };
    },

    broadcastRejected(opts = {}){
        const base = behaviors.success(opts);
        return { ...base, async sendRawTransaction(){ await sleep(opts.latencyMs ?? 5); throw new Error("simulated broadcast rejected (invalid transaction)"); } };
    },

    rpcUnavailable(){
        const fail = async () => { throw new Error("simulated RPC unavailable (connection refused)"); };
        return { latestBlockhash: fail, sendRawTransaction: fail, signatureStatus: fail, blockHeight: fail, balance: fail, tokenAccounts: fail };
    },

    emptyWallet(opts = {}){
        return { ...behaviors.success(opts), async balance(){ await sleep(opts.latencyMs ?? 5); return 0; } };
    },

    lowBalance(opts = {}){
        // Enough to look non-empty, not enough to cover MIN_FEE_BUFFER_LAMPORTS (5000)
        return { ...behaviors.success(opts), async balance(){ await sleep(opts.latencyMs ?? 5); return 1000; } };
    },

    invalidWalletShape(){
        // hasSufficientSolBalance() constructs `new PublicKey(...)` itself -
        // the throw happens before this behavior's balance() would ever run.
        return behaviors.success();
    }

};

module.exports = { createSimulatedConnectionProvider, behaviors };
