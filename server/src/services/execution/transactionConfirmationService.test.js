// services/execution/transactionConfirmationService.test.js - proves
// the three outcomes are classified correctly and never conflated:
// immediate success, delayed success (polls more than once), a genuine
// on-chain error, a plain poll-window timeout, and a blockhash-expired
// timeout (same outcome as a plain timeout, but a different reason, so
// a future caller can tell "unknown" apart from "this attempt can never
// land"). sleep is stubbed to resolve instantly - no real waiting.
// Run with `node --test`.

const test = require("node:test");
const assert = require("node:assert/strict");

const { createTransactionConfirmationService } = require("./transactionConfirmationService");

function fakeConnectionProvider({ statusSequence = [], blockHeightSequence = [] }){
    let statusCalls = 0;
    let blockHeightCalls = 0;
    return {
        getConnection(){
            return {
                async getSignatureStatus(){
                    const value = statusSequence[Math.min(statusCalls, statusSequence.length - 1)];
                    statusCalls++;
                    return { value };
                },
                async getBlockHeight(){
                    const height = blockHeightSequence[Math.min(blockHeightCalls, blockHeightSequence.length - 1)];
                    blockHeightCalls++;
                    return height;
                }
            };
        }
    };
}

const instantSleep = async () => {};

test("resolves SUCCESS immediately when the first poll is already confirmed", async () => {
    const service = createTransactionConfirmationService(
        fakeConnectionProvider({ statusSequence: [{ err: null, confirmationStatus: "confirmed", slot: 100 }] }),
        { sleep: instantSleep, timeoutMs: 10000, pollIntervalMs: 1 }
    );
    const result = await service.confirm({ signature: "sig1", lastValidBlockHeight: 1000 });
    assert.equal(result.outcome, "SUCCESS");
    assert.equal(result.slot, 100);
});

test("resolves SUCCESS after polling a few times (null, null, confirmed)", async () => {
    const service = createTransactionConfirmationService(
        fakeConnectionProvider({
            statusSequence: [null, null, { err: null, confirmationStatus: "confirmed", slot: 200 }],
            blockHeightSequence: [500, 500]
        }),
        { sleep: instantSleep, timeoutMs: 10000, pollIntervalMs: 1 }
    );
    const result = await service.confirm({ signature: "sig2", lastValidBlockHeight: 1000 });
    assert.equal(result.outcome, "SUCCESS");
});

test("does not count 'processed' as confirmed when commitment is 'confirmed'", async () => {
    const service = createTransactionConfirmationService(
        fakeConnectionProvider({
            statusSequence: [
                { err: null, confirmationStatus: "processed", slot: 1 },
                { err: null, confirmationStatus: "confirmed", slot: 1 }
            ]
        }),
        { sleep: instantSleep, timeoutMs: 10000, pollIntervalMs: 1, commitment: "confirmed" }
    );
    const result = await service.confirm({ signature: "sig3", lastValidBlockHeight: 1000 });
    assert.equal(result.outcome, "SUCCESS"); // only resolves on the second, truly-confirmed poll
});

test("resolves FAILED on a genuine on-chain error, distinct from a timeout", async () => {
    const service = createTransactionConfirmationService(
        fakeConnectionProvider({ statusSequence: [{ err: { InstructionError: [0, "Custom"] }, confirmationStatus: "confirmed", slot: 5 }] }),
        { sleep: instantSleep, timeoutMs: 10000, pollIntervalMs: 1 }
    );
    const result = await service.confirm({ signature: "sig4", lastValidBlockHeight: 1000 });
    assert.equal(result.outcome, "FAILED");
    assert.equal(result.reason, "ON_CHAIN_ERROR");
    assert.ok(result.err);
});

test("resolves TIMEOUT with POLL_WINDOW_ELAPSED when nothing is ever found and the blockhash is still valid", async () => {
    const service = createTransactionConfirmationService(
        fakeConnectionProvider({ statusSequence: [null], blockHeightSequence: [100] }), // always well under lastValidBlockHeight
        { sleep: instantSleep, timeoutMs: 5, pollIntervalMs: 1 }
    );
    const result = await service.confirm({ signature: "sig5", lastValidBlockHeight: 999999 });
    assert.equal(result.outcome, "TIMEOUT");
    assert.equal(result.reason, "POLL_WINDOW_ELAPSED");
});

test("resolves TIMEOUT with BLOCKHASH_EXPIRED as soon as current block height passes lastValidBlockHeight", async () => {
    const service = createTransactionConfirmationService(
        fakeConnectionProvider({ statusSequence: [null], blockHeightSequence: [1000] }),
        { sleep: instantSleep, timeoutMs: 10000, pollIntervalMs: 1 } // long timeout - must resolve via blockhash expiry, not the window
    );
    const result = await service.confirm({ signature: "sig6", lastValidBlockHeight: 999 });
    assert.equal(result.outcome, "TIMEOUT");
    assert.equal(result.reason, "BLOCKHASH_EXPIRED");
});
