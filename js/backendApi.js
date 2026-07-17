// =========================================
// CRAB AGENT BACKEND API CLIENT
// backendApi.js - the ONLY file that calls our own backend
// (/api/v1/...). dashboard.js/ui.js never call fetch() directly -
// every backend call goes through BackendAPI below, so request
// de-duplication and cancellation are handled in exactly one place,
// not repeated per caller.
//
// Response envelope handling: our backend always replies with
// either { success:true, data } or { success:false, error, details }
// (see server/src/utils/apiResponse.js) - unwrapped once here so
// every caller just gets the real data or a thrown Error.
// =========================================

// SQLite's CURRENT_TIMESTAMP is UTC as "YYYY-MM-DD HH:MM:SS" (no
// timezone marker) - every backend timestamp field (updated_at,
// last_seen, launch_time, scheduler.lastRunAt) uses this format.
// Converts to a real epoch ms value instead of relying on
// engine-specific non-ISO Date parsing behavior.

function parseBackendTimestamp(ts){

    if(!ts) return null;

    return Date.parse(`${ts.replace(" ", "T")}Z`);

}

const BackendAPI = (function(){

    const BASE_URL =
        (typeof CONFIG !== "undefined" && CONFIG.BACKEND_API_URL) ||
        "http://localhost:4000/api/v1";

    // One AbortController per "channel" - a new call on the same
    // channel (e.g. a second trending poll firing before the first
    // resolved, or opening a new token detail before the previous
    // one loaded) aborts the previous in-flight request instead of
    // letting both race and whichever happens to resolve last
    // silently win (see STEP 6 - "prevent race conditions").

    const controllers = {};

    // In-flight de-duplication: an identical request (same channel
    // *and* same URL) already in flight is reused instead of firing
    // a second, redundant fetch (see STEP 6 - "reuse responses").

    const inFlight = {};

    async function request(channel, path){

        const url = `${BASE_URL}${path}`;

        const existing = inFlight[channel];

        if(existing && existing.url === url){

            return existing.promise;

        }

        if(controllers[channel]){

            controllers[channel].abort();

        }

        const controller = new AbortController();

        controllers[channel] = controller;

        const promise = (async () => {

            try{

                const res = await fetch(url, { signal: controller.signal });

                const json = await res.json().catch(() => null);

                if(!json){

                    throw new Error(`Backend returned a non-JSON response (HTTP ${res.status})`);

                }

                if(!json.success){

                    throw new Error(json.error || `Backend request failed (HTTP ${res.status})`);

                }

                return json.data;

            }
            finally{

                if(controllers[channel] === controller){

                    delete controllers[channel];

                }

                if(inFlight[channel] && inFlight[channel].url === url){

                    delete inFlight[channel];

                }

            }

        })();

        inFlight[channel] = { url, promise };

        return promise;

    }

    return {

        // GET /health - real backend/DB/scheduler status, used for
        // the "Engine"/"LIVE" indicator (see dashboard.js applyStatus()).

        getHealth(){

            return request("health", "/health");

        },

        // GET /stats - real database-wide aggregates, used for the
        // "Monitoring" tooltip (see dashboard.js renderStatsTooltip()).

        getStats(){

            return request("stats", "/stats");

        },

        // GET /trending - the dashboard's default coin list, sorted
        // server-side by volume_1h DESC.

        getTrending(limit = 20){

            return request("trending", `/trending?limit=${encodeURIComponent(limit)}`);

        },

        // GET /search?q= - powers the search box.

        search(query, limit = 50){

            return request(
                "search",
                `/search?q=${encodeURIComponent(query)}&limit=${encodeURIComponent(limit)}`
            );

        },

        // GET /token/:address - full row (including raw_json) for
        // the detail panel. A single fixed channel: only the most
        // recently clicked token's detail request matters, so
        // opening a new one always supersedes whatever was still
        // loading.

        getToken(address){

            return request("detail", `/token/${encodeURIComponent(address)}`);

        }

    };

})();
