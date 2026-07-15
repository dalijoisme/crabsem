// =====================================
// CRAB AGENT WALLET MODULE
// picker.js - wallet picker / install prompt UI.
// Reuses the same visual language as the existing
// disclaimer modal (see css/wallet.css).
// =====================================

const WalletPicker = (function(){

    let overlay, titleEl, subEl, listEl, closeBtn;

    let pendingReject = null;

    function init(){

        overlay = document.getElementById("walletPickerOverlay");
        titleEl = document.getElementById("walletPickerTitle");
        subEl = document.getElementById("walletPickerSub");
        listEl = document.getElementById("walletPickerList");
        closeBtn = document.getElementById("walletPickerCloseBtn");

        if(closeBtn){

            closeBtn.onclick = ()=>hide(true);

        }

    }

    function hide(cancelled){

        if(overlay){

            overlay.classList.add("hidden");

        }

        if(cancelled && pendingReject){

            pendingReject(new Error("cancelled"));

        }

        pendingReject = null;

    }

    function renderOption({ iconHtml, name, tag, onClick }){

        const btn = document.createElement("button");

        btn.type = "button";

        btn.className = "walletOption";

        btn.innerHTML = `

            <div class="walletOptionIcon">${iconHtml}</div>

            <div>

                <div class="walletOptionName">${name}</div>

                <div class="walletOptionTag">${tag}</div>

            </div>

        `;

        btn.onclick = onClick;

        listEl.appendChild(btn);

        return btn;

    }

    // Shows the list of already-detected wallets (Wallet Standard
    // + legacy). Resolves with the entry the user picked, rejects
    // if they close the modal without choosing.

    function showPicker(wallets){

        return new Promise((resolve, reject)=>{

            pendingReject = reject;

            titleEl.textContent = "Connect Wallet";

            subEl.textContent = "Choose a wallet to continue";

            listEl.innerHTML = "";

            wallets.forEach(w=>{

                const iconHtml =
                    w.icon
                    ? `<img src="${w.icon}" style="width:100%;height:100%;border-radius:10px;object-fit:cover">`
                    : "🔑";

                renderOption({

                    iconHtml,

                    name: w.name,

                    tag: w.isLegacy ? "Detected" : "Wallet Standard",

                    onClick: ()=>{

                        pendingReject = null;

                        overlay.classList.add("hidden");

                        resolve(w);

                    }

                });

            });

            overlay.classList.remove("hidden");

        });

    }

    // Mobile, no injected provider at all: offer to open this
    // page inside a wallet app's own in-app browser via the
    // official universal links (see deeplink.js). Clicking an
    // option navigates away, so there's nothing to resolve.

    function showMobileOptions(deeplinks){

        titleEl.textContent = "Connect Wallet";

        subEl.textContent = "Open this page inside your wallet app";

        listEl.innerHTML = "";

        deeplinks.forEach(d=>{

            renderOption({

                iconHtml: "🔗",

                name: d.name,

                tag: "Open in-app browser",

                onClick: ()=>{

                    window.location.href = d.link;

                }

            });

        });

        overlay.classList.remove("hidden");

    }

    // Desktop, nothing detected at all - genuinely no wallet.

    function showNoWalletModal(){

        titleEl.textContent = "No wallet detected";

        subEl.textContent = "Install a Solana wallet to continue";

        listEl.innerHTML = "";

        const installOptions = [

            { name:"Phantom", url:"https://phantom.app/download" },

            { name:"Solflare", url:"https://solflare.com/download" },

            { name:"Backpack", url:"https://backpack.app/download" }

        ];

        installOptions.forEach(o=>{

            renderOption({

                iconHtml: "⬇️",

                name: o.name,

                tag: "Install",

                onClick: ()=>{

                    window.open(o.url, "_blank", "noopener,noreferrer");

                }

            });

        });

        overlay.classList.remove("hidden");

    }

    return{

        init,

        hide,

        showPicker,

        showMobileOptions,

        showNoWalletModal

    };

})();
