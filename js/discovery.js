// =========================================
// CRAB AGENT
// DISCOVERY V3 (address-only identity)
// =========================================

const Discovery = {

    // =====================================
    // LOAD
    // =====================================

    async load(){

    let pairs = await API.trending();

    const dedup = this.removeDuplicate(pairs);

    const filtered = this.filter(dedup);

    return filtered;

},

    // =====================================
    // REMOVE DUPLICATE
    // Identity = contract address ONLY.
    // Never collapse by symbol/name: two
    // different tokens can share the same
    // symbol and must remain two entries.
    // =====================================

    removeDuplicate(pairs){

        const addressMap = {};

        pairs.forEach(pair=>{

            const address =
    pair.baseToken?.address ||
    pair.address;

            if(!address)
                return;

            if(!addressMap[address]){

                addressMap[address]=pair;

                return;

            }

            // If the same address appears more than
            // once (e.g. multiple pools), keep the
            // one with higher activity score.

            const existingScore =
                Number(addressMap[address].__score || 0);

            const currentScore =
                Number(pair.__score || 0);

            if(currentScore > existingScore){

                addressMap[address]=pair;

            }

        });

        return Object.values(addressMap);

    },

    // =====================================
    // FILTER
    // =====================================

    filter(pairs){

        return pairs.filter(pair=>{

            const liquidity =
            Number(pair.liquidity?.usd || 0);

            const volume =
            Number(pair.volume?.h24 || 0);

            if(liquidity < 10000)
                return false;

            if(volume < 5000)
                return false;

            return true;

        });

    }

};
