// =====================================
// CRAB AGENT WALLET MODULE
// wallet-detect.js - device & environment detection
// =====================================

const WalletDetect = {

    isIOS(){

        const ua = navigator.userAgent || "";

        const isIPadOS =
            navigator.platform === "MacIntel" &&
            navigator.maxTouchPoints > 1;

        return /iPhone|iPad|iPod/i.test(ua) || isIPadOS;

    },

    isAndroid(){

        return /Android/i.test(navigator.userAgent || "");

    },

    isMobile(){

        return this.isIOS() || this.isAndroid();

    },

    // Detects whether we're already running inside one of the
    // known wallets' own in-app browser (Phantom / Backpack /
    // Solflare). In that case the wallet's provider is already
    // injected and no redirect is ever needed - this is checked
    // purely from the user agent string, since some in-app
    // browsers append their own token to the UA.

    inAppBrowserName(){

        const ua = navigator.userAgent || "";

        if(/Phantom/i.test(ua)) return "Phantom";

        if(/Backpack/i.test(ua)) return "Backpack";

        if(/Solflare/i.test(ua)) return "Solflare";

        return null;

    },

    isInWalletBrowser(){

        return this.inAppBrowserName() !== null;

    }

};
