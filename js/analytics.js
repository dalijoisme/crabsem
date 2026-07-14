// =========================================
// CRAB AGENT ANALYTICS (local-only, honest)
// =========================================
//
// No backend endpoint exists yet (CONFIG.ANALYTICS_ENDPOINT
// is null). Events are counted anonymously in
// sessionStorage only - nothing is transmitted anywhere.
// No wallet address, IP, or personal identifier is ever
// stored. If a real endpoint is configured later, this
// module will forward events there too, but until then
// it is purely local instrumentation for our own testing.

const Analytics = {

    STORAGE_KEY: "crab_analytics_v1",

    _read(){

        try{

            const raw = sessionStorage.getItem(this.STORAGE_KEY);

            return raw ? JSON.parse(raw) : {};

        }

        catch(e){

            return {};

        }

    },

    _write(data){

        try{

            sessionStorage.setItem(

                this.STORAGE_KEY,

                JSON.stringify(data)

            );

        }

        catch(e){

            // storage unavailable - fail silently,
            // analytics must never break the app

        }

    },

    // Anonymous event counter. `event` is a short label
    // (e.g. "wallet_connect", "search", "detail_open",
    // "gmgn_click", "dexscreener_click"). No personal
    // data is ever passed in `meta`.

    track(event, meta){

        const data = this._read();

        if(!data[event]){

            data[event] = { count:0, lastAt:null };

        }

        data[event].count += 1;

        data[event].lastAt = Date.now();

        this._write(data);

        if(CONFIG?.ANALYTICS_ENDPOINT){

            // Real endpoint configured - forward the
            // event. Intentionally fire-and-forget and
            // never blocks the UI.

            try{

                fetch(CONFIG.ANALYTICS_ENDPOINT,{

                    method:"POST",

                    headers:{ "Content-Type":"application/json" },

                    body: JSON.stringify({

                        event,

                        meta: meta || {},

                        ts: Date.now()

                    })

                }).catch(()=>{});

            }

            catch(e){}

        }

    },

    // Returns the local anonymous counters - useful for
    // debugging in the console (Analytics.summary()).

    summary(){

        return this._read();

    }

};
