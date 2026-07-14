// =====================================
// CRAB AGENT
// WALLET.JS
// =====================================

let wallet = null;

// =====================================
// ELEMENT
// =====================================

const walletButton = document.getElementById("walletButton");
const walletStatus = document.getElementById("walletStatus");
const disclaimer = document.getElementById("disclaimerBox");
const agreeBox = document.getElementById("agreeBox");
const continueButton = document.getElementById("continueButton");

// =====================================
// EVENT
// =====================================

walletButton.onclick = connectWallet;

agreeBox.onchange = () => {
    continueButton.disabled = !agreeBox.checked;
};

continueButton.onclick = () => {

    if (!agreeBox.checked) return;

    sessionStorage.setItem(
        "crab_verified",
        "true"
    );

    sessionStorage.setItem(
        "crab_wallet",
        wallet
    );

    window.location.href = "dashboard.html";

};

// =====================================
// CONNECT WALLET
// =====================================

async function connectWallet() {

    try {

        if (!window.solana || !window.solana.isPhantom) {

            alert("Please install Phantom Wallet.");
            return;

        }

        walletButton.disabled = true;
        walletStatus.innerHTML = "Connecting Wallet...";

        const response = await window.solana.connect();

        wallet = response.publicKey.toString();

        walletStatus.innerHTML = "Checking Holder...";

        const amount = await getCrabHolding(wallet);

        if (amount !== null && amount >= CONFIG.MIN_CRABSEM_HOLDING) {

            verifiedHolder(amount);

        } else {

            walletStatus.innerHTML = "❌ You must hold CRABSEM.";
            walletButton.disabled = false;

        }

    }
    catch (err) {

        console.error(err);

        walletStatus.innerHTML = "Connection Failed";

        walletButton.disabled = false;

    }

}

// =====================================
// GET CRABSEM HOLDING
// Returns the real on-chain balance (number),
// or null if the account/holding cannot be
// determined (no account, RPC error, etc).
// =====================================

async function getCrabHolding(walletAddress) {

    try {

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

        if (!data.result) {
            return null;
        }

        if (data.result.value.length === 0) {
            return 0;
        }

        const amount =
            data.result.value[0]
                .account.data.parsed.info
                .tokenAmount.uiAmount;

        return Number(amount || 0);

    }
    catch (e) {

        console.error(e);

        return null;

    }

}

// =====================================
// VERIFIED HOLDER
// =====================================

function verifiedHolder(amount) {

    sessionStorage.setItem(
        "crab_verified",
        "true"
    );

    sessionStorage.setItem(
        "crab_wallet",
        wallet
    );

    // Cache the balance we just verified on-chain so
    // the dashboard doesn't need a second Helius call
    // for the same information right after this one.

    sessionStorage.setItem(
        "crab_balance",
        String(amount)
    );

    if(typeof Analytics !== "undefined"){

        Analytics.track("wallet_connect");

    }

    walletStatus.innerHTML =
        "✅ Holder Verified";

    walletButton.disabled = true;

    disclaimer.classList.remove("hidden");

}
