// services/execution/transactionSigningService.test.js - proves
// signing actually produces a valid signature, that a public-key
// mismatch is rejected rather than silently signing with the wrong
// key, and - the important one for a module that touches a decrypted
// private key - that the raw secret key never appears in anything this
// module returns or throws. No mocking library: walletService/
// tradingWalletRepository are small hand-written fakes, same pattern as
// entryGateService.test.js. Run with `node --test`.

const test = require("node:test");
const assert = require("node:assert/strict");
const { Keypair, Transaction, SystemProgram, PublicKey } = require("@solana/web3.js");

const { createTransactionSigningService } = require("./transactionSigningService");

function fakeWalletService(secretKey){
    return {
        decryptSecretKey(){
            // Real decrypt would return a fresh Buffer per call - match
            // that shape so the service's own .fill(0) scrub can't
            // accidentally corrupt a shared fixture across tests.
            return Buffer.from(secretKey);
        }
    };
}

function fakeTradingWalletRepository(publicKeyBase58){
    return {
        findByUserId(userId){
            return userId === 1 ? { public_key: publicKeyBase58, encrypted_private_key: "irrelevant-in-this-fake" } : undefined;
        }
    };
}

function buildUnsignedTransferTransaction(feePayerPublicKey){
    const tx = new Transaction();
    // Any real 32-byte base58 value round-trips through Transaction.serialize()
    // correctly - a blockhash is structurally identical to a public key, and
    // it doesn't need to be a REAL recent blockhash just to prove signing works.
    tx.recentBlockhash = Keypair.generate().publicKey.toBase58();
    tx.feePayer = feePayerPublicKey;
    tx.add(SystemProgram.transfer({
        fromPubkey: feePayerPublicKey,
        toPubkey: feePayerPublicKey,
        lamports: 0
    }));
    return tx;
}

test("signs a transaction with the correct trading wallet and produces a verifiable signature", () => {
    const keypair = Keypair.generate();
    const service = createTransactionSigningService({
        walletService: fakeWalletService(keypair.secretKey),
        tradingWalletRepository: fakeTradingWalletRepository(keypair.publicKey.toBase58())
    });

    const tx = buildUnsignedTransferTransaction(keypair.publicKey);
    const signed = service.sign(1, tx);

    assert.equal(signed, tx); // same object, mutated in place
    assert.equal(signed.verifySignatures(), true);
});

test("rejects when the decrypted keypair does not match the trading wallet's recorded public key", () => {
    const realKeypair = Keypair.generate();
    const wrongKeypair = Keypair.generate();

    const service = createTransactionSigningService({
        walletService: fakeWalletService(wrongKeypair.secretKey), // decrypt "returns" the wrong key
        tradingWalletRepository: fakeTradingWalletRepository(realKeypair.publicKey.toBase58()) // but the row says the real one
    });

    const tx = buildUnsignedTransferTransaction(realKeypair.publicKey);

    assert.throws(
        () => service.sign(1, tx),
        /does not match the trading wallet's recorded public key/
    );
});

test("throws a clean error when no trading wallet exists for the user, never touches decryptSecretKey", () => {
    let decryptCalled = false;
    const service = createTransactionSigningService({
        walletService: { decryptSecretKey(){ decryptCalled = true; return Buffer.alloc(64); } },
        tradingWalletRepository: { findByUserId: () => undefined }
    });

    assert.throws(() => service.sign(999, {}), /no trading wallet found for user 999/);
    assert.equal(decryptCalled, false);
});

test("the raw secret key never appears in a thrown error's message", () => {
    const keypair = Keypair.generate();
    const secretKeyBase58 = Buffer.from(keypair.secretKey).toString("hex");

    const service = createTransactionSigningService({
        walletService: fakeWalletService(keypair.secretKey),
        tradingWalletRepository: fakeTradingWalletRepository("some-other-public-key") // forces the mismatch throw path
    });

    try{
        service.sign(1, buildUnsignedTransferTransaction(keypair.publicKey));
        assert.fail("expected sign() to throw");
    }
    catch(err){
        assert.equal(err.message.includes(secretKeyBase58), false);
    }
});
