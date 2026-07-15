// =====================================
// CRAB AGENT
// WALLET.JS - orchestrator
//
// Actual logic lives in js/*.js (flat, same folder as every
// other script in this project - no subfolder, to avoid
// path-resolution mistakes across different hosting setups):
//   detect.js        - device / in-app browser detection
//   provider.js       - Wallet Standard registry + legacy fallback
//   deeplink.js       - official universal "browse" links
//   connect.js        - unified connect() for any wallet
//   verification.js   - CRABSEM holder check (unchanged logic)
//   picker.js         - wallet picker / install prompt UI
//
// This file just wires the buttons on this page to those
// modules. No wallet-specific wording or logic lives here -
// "Connect Wallet" works the same regardless of which
// Solana wallet the user actually has.
// =====================================

// =====================================
// SESSION KEYS
// holderVerified / walletAddress / verifiedUntil = wallet +
// holding check result (set once, in verifiedHolder()).
// acceptedDisclaimer = a SEPARATE concern, only set after the
// user actually ticks the box and clicks continue - so a
// closed tab between "wallet connected" and "disclaimer
// accepted" can never skip the disclaimer.
// =====================================

const SESSION_VALID_HOURS = 24;

function isSessionValid(){

    const verified = sessionStorage.getItem("holderVerified") === "true";

    const disclaimerOk = sessionStorage.getItem("acceptedDisclaimer") === "true";

    const until = Number(sessionStorage.getItem("verifiedUntil") || 0);

    return verified && disclaimerOk && Date.now() < until;

}

// If this tab already has a fully valid session (verified +
// disclaimer accepted + not expired), skip straight to the
// dashboard - never reconnect, never re-show the disclaimer.

if(isSessionValid()){

    window.location.href = "dashboard.html";

}

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
        "acceptedDisclaimer",
        "true"
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

        // No minimum holding - any positive CRABSEM balance
        // qualifies. This was previously gated behind
        // CONFIG.MIN_CRABSEM_HOLDING (100,000 tokens); that
        // requirement has been explicitly removed per product
        // decision - holding ANY amount of CRABSEM unlocks the
        // app. Using a plain `amount > 0` check here rather than
        // depending on a config threshold makes that intent
        // unambiguous regardless of what MIN_CRABSEM_HOLDING is
        // set to elsewhere.

        if(amount !== null && amount > 0){

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
        "holderVerified",
        "true"
    );

    sessionStorage.setItem(
        "walletAddress",
        wallet
    );

    sessionStorage.setItem(
        "verifiedUntil",
        String(Date.now() + SESSION_VALID_HOURS * 3600000)
    );

    // Cache the balance we just verified on-chain so
    // the dashboard doesn't need a second RPC call for
    // the same information right after this one.

    sessionStorage.setItem(
        "walletBalance",
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
