// utils/validators.js - request-query validation shared by every v1
// token-listing endpoint (/tokens, /trending, /search). This is also
// the single allow-list for ORDER BY columns: SQLite can't
// parameterize a column name, so gmgnTokenRepository interpolates
// `sort` directly into SQL - it is only ever safe because every
// caller is required to validate against SORTABLE_COLUMNS first.

const SORTABLE_COLUMNS = [
    "market_cap",
    "volume_1h",
    "holders",
    "price",
    "liquidity",
    "price_change_5m",
    "price_change_1h",
    "symbol",
    "name",
    "updated_at",
    "last_seen"
];

const DEFAULT_LIMIT = 50;
const MAX_LIMIT = 200;
const DEFAULT_SORT = "market_cap";
const DEFAULT_DIRECTION = "DESC";

function validateListQuery(query){

    const errors = [];

    let page = 1;
    let limit = DEFAULT_LIMIT;
    let sort = DEFAULT_SORT;
    let direction = DEFAULT_DIRECTION;
    let search = null;

    if(query.page !== undefined){

        const n = Number(query.page);

        if(!Number.isInteger(n) || n < 1){

            errors.push("page must be a positive integer");

        }
        else{

            page = n;

        }

    }

    if(query.limit !== undefined){

        const n = Number(query.limit);

        if(!Number.isInteger(n) || n < 1 || n > MAX_LIMIT){

            errors.push(`limit must be an integer between 1 and ${MAX_LIMIT}`);

        }
        else{

            limit = n;

        }

    }

    if(query.sort !== undefined){

        if(!SORTABLE_COLUMNS.includes(query.sort)){

            errors.push(`sort must be one of: ${SORTABLE_COLUMNS.join(", ")}`);

        }
        else{

            sort = query.sort;

        }

    }

    if(query.direction !== undefined){

        const dir = String(query.direction).toUpperCase();

        if(dir !== "ASC" && dir !== "DESC"){

            errors.push("direction must be 'asc' or 'desc'");

        }
        else{

            direction = dir;

        }

    }

    if(query.search !== undefined && String(query.search).trim() !== ""){

        search = String(query.search).trim();

    }

    return { valid: errors.length === 0, errors, page, limit, sort, direction, search };

}

// Standalone `limit` validation for endpoints that don't take the
// full list-query shape (e.g. /trending, /search).

function validateLimit(rawLimit, fallback){

    if(rawLimit === undefined) return { valid: true, limit: fallback };

    const n = Number(rawLimit);

    if(!Number.isInteger(n) || n < 1 || n > MAX_LIMIT){

        return { valid: false, error: `limit must be an integer between 1 and ${MAX_LIMIT}` };

    }

    return { valid: true, limit: n };

}

module.exports = {
    SORTABLE_COLUMNS,
    DEFAULT_LIMIT,
    MAX_LIMIT,
    DEFAULT_SORT,
    DEFAULT_DIRECTION,
    validateListQuery,
    validateLimit
};
