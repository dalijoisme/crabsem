// utils/dateRange.js - shared date-range math for the CEO Dashboard's
// global filter (Section 2) and its "trend vs previous period"
// comparisons (Section 3). Pure functions, no DB access - every
// caller still does its own real querying against the resolved
// from/to strings.

function parseUtcDate(dateStr){

    // "YYYY-MM-DD" parsed as a real UTC midnight instant - avoids any
    // local-timezone drift between the browser's quick-button choice
    // and the server's own date math.
    return new Date(`${dateStr}T00:00:00Z`);

}

function formatUtcDate(date){

    return date.toISOString().slice(0, 10);

}

// The immediately preceding period of the SAME real length, used to
// compute "trend vs previous period" (Section 3). Returns null when
// there's no real bounded range to compare against (All Time, or only
// one side of the range given - a trend needs two comparable,
// equal-length windows, not a guess).

function computePreviousPeriod({ from, to }){

    if(!from || !to) return null;

    const fromDate = parseUtcDate(from);

    const toDate = parseUtcDate(to);

    const lengthMs = toDate.getTime() - fromDate.getTime();

    if(lengthMs < 0) return null;

    const prevTo = new Date(fromDate.getTime() - 24*60*60*1000);

    const prevFrom = new Date(prevTo.getTime() - lengthMs);

    return { from: formatUtcDate(prevFrom), to: formatUtcDate(prevTo) };

}

module.exports = { computePreviousPeriod };
