// =====================================
// CRAB AGENT WALLET MODULE
// wallet-connect.js - unified connect flow.
//
// Both a Wallet Standard wallet entry and a legacy provider
// entry (see provider.js) resolve to the exact same shape
// here: { address, walletName }. Nothing downstream needs
// to know or care which mechanism was used.
// =====================================

const WalletConnect = {

    async connect(walletEntry){

        if(!walletEntry){

            throw new Error("No wallet selected");

        }

        if(walletEntry.isLegacy){

            const provider = walletEntry.provider;

            const response = await provider.connect();

            const address =
                response?.publicKey?.toString?.() ||
                provider.publicKey?.toString?.() ||
                null;

            if(!address){

                throw new Error("Legacy provider did not return a public key");

            }

            return{ address, walletName: walletEntry.name };

        }

        // Wallet Standard wallet: use the standard "standard:connect"
        // feature. `account.address` is already the base58-encoded
        // Solana address per the Wallet Standard base spec - no
        // extra encoding library needed.

        const wallet = walletEntry.standardWallet;

        const connectFeature = wallet.features?.["standard:connect"];

        if(!connectFeature || typeof connectFeature.connect !== "function"){

            throw new Error(`${wallet.name} does not support standard:connect`);

        }

        const result = await connectFeature.connect();

        const account = result?.accounts?.[0];

        if(!account?.address){

            throw new Error("No account returned from wallet");

        }

        return{ address: account.address, walletName: wallet.name };

    }

};
