// services/execution/balanceValidationService.test.js - proves every
// balance figure comes from the injected connection (never fabricated,
// never trusting a caller-supplied number), and that a missing token
// account reads as a real zero rather than an error. Fake connection
// only - no real RPC call in this file. Run with `node --test`.

const test = require("node:test");
const assert = require("node:assert/strict");
const { Keypair } = require("@solana/web3.js");

const { createBalanceValidationService } = require("./balanceValidationService");

function fakeConnectionProvider({ balanceLamports, tokenAccounts = [] }){
    return {
        getConnection(){
            return {
                async getBalance(){ return balanceLamports; },
                async getParsedTokenAccountsByOwner(){ return { value: tokenAccounts }; }
            };
        }
    };
}

function fakeParsedTokenAccount(amount, decimals, uiAmount){
    return { account: { data: { parsed: { info: { tokenAmount: { amount, decimals, uiAmount } } } } } };
}

test("reads native SOL balance straight from the connection, in lamports", async () => {
    const service = createBalanceValidationService(fakeConnectionProvider({ balanceLamports: 1_500_000_000 }));
    const lamports = await service.getNativeSolBalanceLamports(Keypair.generate().publicKey.toBase58());
    assert.equal(lamports, 1_500_000_000);
});

test("returns a real zero (not an error) when no token account exists for the mint", async () => {
    const service = createBalanceValidationService(fakeConnectionProvider({ balanceLamports: 0, tokenAccounts: [] }));
    const result = await service.getSplTokenBalance(
        Keypair.generate().publicKey.toBase58(),
        Keypair.generate().publicKey.toBase58()
    );
    assert.deepEqual(result, { amountRaw: "0", decimals: null, uiAmount: 0 });
});

test("returns the real parsed token amount when an account exists", async () => {
    const service = createBalanceValidationService(fakeConnectionProvider({
        balanceLamports: 0,
        tokenAccounts: [fakeParsedTokenAccount("42500000", 6, 42.5)]
    }));
    const result = await service.getSplTokenBalance(
        Keypair.generate().publicKey.toBase58(),
        Keypair.generate().publicKey.toBase58()
    );
    assert.deepEqual(result, { amountRaw: "42500000", decimals: 6, uiAmount: 42.5 });
});

test("hasSufficientSolBalance compares the real on-chain balance, not a claimed one", async () => {
    const service = createBalanceValidationService(fakeConnectionProvider({ balanceLamports: 1000 }));
    const pubkey = Keypair.generate().publicKey.toBase58();
    assert.equal(await service.hasSufficientSolBalance(pubkey, 999), true);
    assert.equal(await service.hasSufficientSolBalance(pubkey, 1000), true);
    assert.equal(await service.hasSufficientSolBalance(pubkey, 1001), false);
});
