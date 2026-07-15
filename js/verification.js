// =====================================
// CRAB AGENT WALLET MODULE
// verification.js - CRABSEM holder verification.
//
// Logic unchanged from before (per explicit instruction not
// to touch holder verification) - only moved into its own
// module file.
// =====================================

const WalletVerification = {

    // Returns the real on-chain balance (number), or null if
    // the account/holding cannot be determined (no account,
    // RPC error, etc).

    async getCrabHolding(walletAddress){

        try{

            const response = await fetch(CONFIG.HELIUS_RPC, {

                method: "POST",

                headers: {
                    "Content-Type": "application/json"
                },

                body: JSON.stringify({

                    jsonrpc: "2.0",

                    id: 1,

                    method: "getTokenAccountsByOwner",

                    params: [

                        walletAddress,

                        {
                            mint: CONFIG.CRAB_MINT
                        },

                        {
                            encoding: "jsonParsed"
                        }

                    ]

                })

            });

            const data = await response.json();

            if(!data.result){
                return null;
            }

            if(data.result.value.length === 0){
                return 0;
            }

            const amount =
                data.result.value[0]
                    .account.data.parsed.info
                    .tokenAmount.uiAmount;

            return Number(amount || 0);

        }
        catch(e){

            console.error(e);

            return null;

        }

    }

};
