// =====================================
// CRAB AGENT WALLET MODULE
// wallet-provider.js - Wallet Standard registry (zero-dependency
// reimplementation of the official event protocol) +
// legacy provider fallback for wallets that haven't
// adopted Wallet Standard yet.
//
// Protocol reference (verified against the official
// @wallet-standard/app source):
//   - App dispatches "wallet-standard:app-ready" with
//     { detail: { register } }.
//   - App listens for "wallet-standard:register-wallet";
//     each wallet dispatches that event with a callback
//     function as `detail`, which the app then calls with
//     its own { register } API.
//   - This double round-trip guarantees wallets are found
//     regardless of whether the wallet or the app script
//     runs first.
// No external package is loaded - this is the same ~100
// line protocol, written locally with zero dependencies.
// =====================================

const WalletProvider = (function(){

    const registeredWallets = new Set();

    const listeners = {}; // { register: [...], unregister: [...] }

    function guard(fn){

        try{ fn(); }
        catch(e){ console.error(e); }

    }

    function register(...wallets){

        wallets = wallets.filter(w=>!registeredWallets.has(w));

        if(!wallets.length) return function unregister(){};

        wallets.forEach(w=>registeredWallets.add(w));

        (listeners["register"]||[]).forEach(l=>guard(()=>l(...wallets)));

        return function unregister(){

            wallets.forEach(w=>registeredWallets.delete(w));

            (listeners["unregister"]||[]).forEach(l=>guard(()=>l(...wallets)));

        };

    }

    function on(event, listener){

        (listeners[event] = listeners[event] || []).push(listener);

        return function off(){

            listeners[event] = (listeners[event]||[]).filter(l=>l!==listener);

        };

    }

    let initialized = false;

    function init(){

        if(initialized) return;

        initialized = true;

        const api = Object.freeze({ register });

        try{

            window.addEventListener("wallet-standard:register-wallet", (event)=>{

                // Per spec, `detail` is a callback provided by the
                // wallet - we call it with our { register } API and
                // the wallet uses it to register itself.

                if(typeof event.detail === "function"){

                    guard(()=>event.detail(api));

                }

            });

        }
        catch(e){

            console.error("wallet-standard:register-wallet listener failed", e);

        }

        try{

            window.dispatchEvent(

                new CustomEvent("wallet-standard:app-ready", { detail: api })

            );

        }
        catch(e){

            console.error("wallet-standard:app-ready dispatch failed", e);

        }

    }

    function getRegistered(){

        return [...registeredWallets];

    }

    // =====================================
    // LEGACY PROVIDER FALLBACK
    // For wallets that inject a global (window.phantom.solana,
    // window.solflare, window.backpack, or the older shared
    // window.solana) but have not adopted Wallet Standard yet.
    // Wrapped into the same {name, icon, isLegacy, provider}
    // shape so the rest of the app treats every wallet source
    // uniformly.
    // =====================================

    function getLegacyProviders(){

        const found = [];

        if(window.phantom?.solana?.isPhantom){

            found.push({ name:"Phantom", icon:null, isLegacy:true, provider:window.phantom.solana });

        }
        else if(window.solana?.isPhantom){

            found.push({ name:"Phantom", icon:null, isLegacy:true, provider:window.solana });

        }

        if(window.solflare?.isSolflare){

            found.push({ name:"Solflare", icon:null, isLegacy:true, provider:window.solflare });

        }

        if(window.backpack?.isBackpack){

            found.push({ name:"Backpack", icon:null, isLegacy:true, provider:window.backpack });

        }

        // Generic fallback: some standard-less wallet still set
        // window.solana with a connect() method, but didn't match
        // any of the named checks above.

        if(

            !found.length &&
            window.solana &&
            typeof window.solana.connect === "function"

        ){

            found.push({ name:"Solana Wallet", icon:null, isLegacy:true, provider:window.solana });

        }

        return found;

    }

    // =====================================
    // UNIFIED LIST - Wallet Standard wallets first (the
    // modern, preferred path), then any legacy provider not
    // already represented via Wallet Standard (avoids listing
    // the same wallet twice under both mechanisms).
    // =====================================

    function getAvailableWallets(){

        // init() is idempotent (guarded by `initialized`), but is
        // also called eagerly below at module load time - calling
        // it here too is just a safe no-op, not the primary timing
        // guarantee.

        init();

        const standardWallets =
            getRegistered()
            .filter(w=>

                Array.isArray(w.chains) &&
                w.chains.some(c=>String(c).startsWith("solana:"))

            )
            .map(w=>({

                name: w.name,

                icon: w.icon || null,

                isLegacy: false,

                standardWallet: w

            }));

        const standardNames = new Set(standardWallets.map(w=>w.name));

        const legacyWallets =
            getLegacyProviders()
            .filter(w=>!standardNames.has(w.name));

        return [...standardWallets, ...legacyWallets];

    }

    return{

        init,

        on,

        getAvailableWallets

    };

})();

// Initialize immediately at module load time (not lazily on
// first click). This guarantees our "wallet-standard:register-wallet"
// listener is already attached before any wallet extension's own
// content script runs its initial registration dispatch - closing
// a real timing gap rather than relying solely on wallets correctly
// re-dispatching on "wallet-standard:app-ready".

WalletProvider.init();
