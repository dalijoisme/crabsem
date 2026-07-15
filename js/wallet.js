// =====================================
// CRAB AGENT
// WALLET.JS - orchestrator
//
// Actual logic lives in js/wallet-*.js (flat, same folder as
// every other script in this project - no subfolder, to avoid
// path-resolution mistakes across different hosting setups):
//   wallet-detect.js        - device / in-app browser detection
//   wallet-provider.js      - Wallet Standard registry + legacy fallback
//   wallet-deeplink.js      - official universal "browse" links
//   wallet-connect.js       - unified connect() for any wallet
//   wallet-verification.js  - CRABSEM holder check (unchanged logic)
//   wallet-picker.js        - wallet picker / install prompt UI
//
// This file just wires the buttons on this page to those
// modules. No wallet-specific wording or logic lives here -
// "Connect Wallet" works the same regardless of which
// Solana wallet the user actually has.
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

WalletPicker.init();

// =====================================
// EVENT
// =====================================

walletButton.onclick = handleConnectClick;

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
// CONNECT FLOW
//
// 1. Ask WalletProvider what's actually available right now
//    (Wallet Standard registry + legacy globals). This also
//    covers "already inside a wallet's in-app browser" - the
//    provider is simply already there, so no redirect ever
//    happens in that case.
// 2. Nothing found + mobile browser -> offer deep links into
//    each supported wallet's in-app browser (never claims a
//    specific wallet "isn't installed" - we can't know that).
// 3. Nothing found + desktop -> genuinely no wallet, offer
//    installs.
// 4. Exactly one wallet -> connect directly, no picker needed.
// 5. More than one -> show the picker.
// =====================================

async function handleConnectClick(){

    try{

        walletButton.disabled = true;

        walletStatus.innerHTML = "Detecting wallets...";

        const wallets = WalletProvider.getAvailableWallets();

        if(wallets.length === 0){

            if(WalletDetect.isMobile() && !WalletDetect.isInWalletBrowser()){

                walletStatus.innerHTML = "Choose a wallet app to continue";

                const deeplinks = WalletDeeplink.buildLinksForCurrentPage();

                WalletPicker.showMobileOptions(deeplinks);

                walletButton.disabled = false;

                return;

            }

            walletStatus.innerHTML = "No wallet detected";

            WalletPicker.showNoWalletModal();

            walletButton.disabled = false;

            return;

        }

        let chosen;

        if(wallets.length === 1){

            chosen = wallets[0];

        }
        else{

            walletStatus.innerHTML = "Choose a wallet...";

            chosen = await WalletPicker.showPicker(wallets);

        }

        walletStatus.innerHTML = "Connecting Wallet...";

        const { address } = await WalletConnect.connect(chosen);

        wallet = address;

        walletStatus.innerHTML = "Checking Holder...";

        const amount = await WalletVerification.getCrabHolding(wallet);

        if(amount !== null && amount >= CONFIG.MIN_CRABSEM_HOLDING){

            verifiedHolder(amount);

        }
        else{

            walletStatus.innerHTML = "❌ You must hold CRABSEM.";

            walletButton.disabled = false;

        }

    }
    catch(err){

        console.error(err);

        if(err?.message === "cancelled"){

            walletStatus.innerHTML = "Wallet not connected";

        }
        else{

            walletStatus.innerHTML = "Connection Failed";

        }

        walletButton.disabled = false;

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
    // the dashboard doesn't need a second RPC call for
    // the same information right after this one.

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
