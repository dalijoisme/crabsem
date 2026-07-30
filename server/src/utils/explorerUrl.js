// utils/explorerUrl.js - Trust/UX sprint. One pure function, no I/O, no
// config access of its own (cluster is passed in, not read from env
// here) - the same one-off pattern already used ad hoc in
// scripts/validation/task1_founderDryRun.js, promoted to reusable
// service code instead of being duplicated per caller. A real tx_hash
// only ever needs one of two Solana Explorer URL shapes: mainnet has no
// query string, every other cluster needs ?cluster=<name>.

function buildSolanaTxUrl(txHash, cluster = "mainnet-beta"){
    if(!txHash) return null;
    return cluster === "mainnet-beta"
        ? `https://explorer.solana.com/tx/${txHash}`
        : `https://explorer.solana.com/tx/${txHash}?cluster=${cluster}`;
}

module.exports = { buildSolanaTxUrl };
