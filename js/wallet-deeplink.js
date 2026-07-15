// =====================================
// CRAB AGENT WALLET MODULE
// wallet-deeplink.js - official "browse" universal links.
//
// Verified directly against each wallet's own developer
// docs (not guessed):
//   Phantom:  https://phantom.app/ul/browse/<url>?ref=<ref>
//   Solflare: https://solflare.com/ul/v1/browse/<url>?ref=<ref>
//   Backpack: https://backpack.app/ul/v1/browse/<url>?ref=<ref>
//
// These open the CURRENT page inside that wallet's own
// in-app browser. Once there, the wallet's provider is
// injected exactly like a desktop extension, so the normal
// Wallet Standard / legacy connect flow just works - no
// separate encrypted deep-link protocol needed for a plain
// connect.
//
// If the wallet app isn't installed, iOS/Android treat the
// link as a normal HTTPS link and load that wallet's own
// website (which offers the install) - so we never have to
// guess whether a wallet is installed on someone's phone.
// =====================================

const WalletDeeplink = {

    SUPPORTED: [

        {

            name: "Phantom",

            buildBrowseLink(url, ref){

                return `https://phantom.app/ul/browse/${encodeURIComponent(url)}?ref=${encodeURIComponent(ref)}`;

            }

        },

        {

            name: "Solflare",

            buildBrowseLink(url, ref){

                return `https://solflare.com/ul/v1/browse/${encodeURIComponent(url)}?ref=${encodeURIComponent(ref)}`;

            }

        },

        {

            name: "Backpack",

            buildBrowseLink(url, ref){

                return `https://backpack.app/ul/v1/browse/${encodeURIComponent(url)}?ref=${encodeURIComponent(ref)}`;

            }

        }

    ],

    buildLinksForCurrentPage(){

        const url = window.location.href;

        const ref = window.location.origin;

        return this.SUPPORTED.map(w=>({

            name: w.name,

            link: w.buildBrowseLink(url, ref)

        }));

    }

};
