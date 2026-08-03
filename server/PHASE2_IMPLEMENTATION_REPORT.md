# Phase 2 — Implementation Report

Status: **Implementation complete. Not deployed to the VPS.** Local test suite
green (445/445), local smoke test run against the real production database
copy with real results shown below.

This report follows the FINAL DELIVERABLE structure requested: architecture
corrections made during coding, files modified, new modules, database
changes, deployment steps, verification checklist, performance impact, and
remaining placeholders for the Solution Architect.

---

## 1. Architecture corrections made during coding

Per instruction, these were corrected immediately during implementation
rather than stopping for a new planning checkpoint. All are documented
in-line in the affected files' own comments too.

1. **`config/realtimePulseConfig.js` cross-layer dependency.** While
   writing this file I initially had it `require("../services/entryGateService")`
   to reuse `MAX_MARKET_DATA_AGE_SECONDS`. Checked the convention first —
   no `config/` file in this codebase requires a `service/` file (services
   require config, never the reverse). Corrected: removed the import;
   `realtimePulseService.js` reads that constant directly from
   `entryGateService` instead, keeping `config/realtimePulseConfig.js` a
   pure leaf module.

2. **`computedAtMs` broke two existing "byte-identical output" regression
   tests.** `researchEngineFactory.test.js` has two tests (`M5 regression
   guarantee`, `omitted override reproduces...`) that call the engine
   twice and deep-equal the results to prove refactors didn't change
   behavior. Adding a real `Date.now()` timestamp to Realtime Pulse's
   output broke that equality (two separate calls, two different real
   instants — expected, not a bug). Corrected the same way the file
   already handled `freshnessPenalty`/`ageMinutes` (its own pre-existing
   wall-clock fields): strip `computedAtMs` before comparing, with a
   tolerance-free exact match on everything else. Both tests pass.

3. **Momentum Acceleration vs. Deceleration simplified to one signed
   field.** The original design named these as two concepts. Implemented
   as a single `acceleration` number per signal (positive = speeding up,
   negative = losing steam) rather than two redundant fields that are
   just sign-flips of each other — simpler, and the sign already carries
   the "acceleration vs. deceleration" distinction losslessly. Documented
   in `realtimePulseService.js`'s own comments.

4. **Cross-signal composites are explicit "Provisional" majority-vote
   summaries, not a formula.** "Realtime Flow Direction" and "Realtime
   Momentum Consistency" (Section 5 of the design doc) require combining
   *multiple* per-signal directions into one verdict. Per the Formula
   Policy, combining signals into a decision-relevant number is exactly
   the kind of thing this implementation isn't authorized to invent.
   Resolved by implementing them as `flowDirectionVoteProvisional`/
   `consistencyVoteProvisional` — a plain majority-count for
   logging/dashboard display only, explicitly named "Provisional," and
   never read by any scoring or gating code path. If the Architect wants
   a different combination rule, this is the one place to change it.

5. **Orphaned dev-server process found running against the live database
   during smoke testing (operational, not code).** While smoke-testing
   Phase 2, a second `node src/index.js` instance failed to bind port
   4000 because an *earlier* instance — left over from Phase 1's smoke
   test, apparently not actually killed by the `TaskStop` call at the
   time despite it reporting success — had been running unattended this
   entire session, continuously ticking its schedulers (including
   exit-evaluation for `user_id=8`, the live founder wallet) against the
   real database. Found via `netstat`/`Get-Process` and terminated
   (`taskkill /F`). No evidence of any unintended trade execution was
   found in the logs (exit cycles logged `closed=0` throughout), but
   flagging this prominently: **Windows background-process cleanup for
   this kind of long-running dev server should be double-checked with
   `netstat -ano | grep :4000` after any `TaskStop`, not trusted on the
   tool's success message alone**, especially before/after any session
   that boots the real trading engine locally.

---

## 2. Files modified (existing files, additive changes only)

| File | What changed |
|---|---|
| `server/package.json` | Registered the 6 new test files in the `test` script |
| `server/src/config/retentionConfig.js` | Added `realtimePulseSnapshotsMaxAgeHours` (48h) |
| `server/src/services/retentionService.js` | Wired `realtimePulseRepository.pruneOlderThan` into the existing prune pass |
| `server/src/scheduler/gmgnTrendingScheduler.js` | Chains a deferred (`setImmediate`) Realtime Pulse tick onto the end of each successful collector batch; new `getPulseHealth()` export |
| `server/src/services/intelligence/participant/smartMoney.js` | New optional trailing `realtimeSignal` param → `realtimeFacts` on the return value. Score/reasons unchanged |
| `server/src/services/intelligence/participant/kol.js` | Same pattern as smartMoney.js |
| `server/src/services/researchEngineFactory.js` | Computes Realtime Pulse once per token; threads it into smartMoney/kol/syntheticMarketFilter calls; adds the inert `resolveRealtimePulseModifier` integration point (always +0) into `computeUnifiedEntryScore`; carries `realtimePulse` through the existing `breakdown` object |
| `server/src/services/syntheticMarketFilterService.js` | New optional trailing `realtimeSignal` param → `realtimeFacts` on `computeSyntheticBreakdown`'s return. `syntheticScore`/`washFlagged` unchanged |
| `server/src/services/dynamicExitService.js` | `computeMomentumHealth` gains optional `realtimeSignal` → `realtimeFacts`; `evaluateDynamicExit` reads the held position's own Realtime Pulse buffer, logs it, and routes TP1/TP2/SL/Timer through four new inert `resolveEffective*` hooks (all currently return the existing `exitConfig` values unchanged) |
| `server/src/repositories/tradingBotRepository.js` | `buildTradeDatasetFields` projects `realtimePulse` onto the new `realtime_pulse_at_entry_json` column; insert statement updated |
| `server/src/services/health.js`, `server/src/services/adminService.js`, `server/src/controllers/adminController.js`, `server/src/routes/v1/admin.js` | New `realtimePulse`/`scheduler.dailyReview` blocks on `GET /admin/system`; new `GET /admin/daily-review` and `GET /admin/daily-review/recent` endpoints |
| `server/src/index.js` | Starts/stops `dailyReviewScheduler` alongside the other 9 schedulers |
| `admin.html`, `js/admin.js` | New "Realtime Pulse & Daily Review" stat row on the System panel; new "Daily Trading Review" section with trading summary + suggested observations |
| `server/src/scheduler/tradingBotScheduler.js`, `.test.js`, `server/src/scheduler/exitEvaluationScheduler.js`, `.test.js`, `server/src/repositories/executionRepository.js` | **Phase 1 files, already reported** — untouched by Phase 2 beyond what was already delivered |

No existing table's existing columns were altered. No existing scoring
formula, threshold, weight, or gate changed behavior — verified by the
full test suite passing unmodified (391 pre-existing tests) plus 2
tests adjusted for the `computedAtMs` nondeterminism (item 2 above).

## 3. New modules

| File | Purpose |
|---|---|
| `server/src/config/realtimePulseConfig.js` | Structural config only: `BUFFER_SIZE` (3, per the brief's explicit mandate), `STALE_POINT_INTERVAL_MULTIPLIER` (3x, reused from 3 existing precedents in this codebase) |
| `server/src/repositories/realtimePulseRepository.js` (+ test) | Durable per-poll snapshot storage, batched insert, recent-lookback for warm-start, retention pruning |
| `server/src/services/realtimePulseBufferService.js` (+ test) | In-memory rolling 3-point buffer per token, explicit eviction, warm-start seeding |
| `server/src/services/realtimePulseService.js` (+ test, 19 tests) | The core computation: real-elapsed-time velocity/acceleration/direction/consistency per tracked signal (price, liquidity, holders, volume, buy/sell counts, net flow, buy pressure, smart-money net USD, KOL net USD), plus the per-tick orchestration (`runPulseTick`) |
| `server/src/repositories/dailyReviewRepository.js` (+ test) | Global (not user-scoped) date-bounded trade query + upsert-per-day report storage |
| `server/src/services/dailyReviewService.js` (+ test, 9 tests) | Pure descriptive aggregation: trading summary, entry/exit quality by winner/loser, exit reason distribution, best/worst pattern (with a sample-size guard), frequency tables over real reason strings, Realtime Pulse coverage stats, plain comparative "suggested observations" (never a directive) |
| `server/src/scheduler/dailyReviewScheduler.js` (+ test, 6 tests) | Once-a-day trigger (polls every 15 min, idempotent, targets the most recently *completed* real UTC day, never "today") |
| `server/PHASE2_TRADING_ENGINE_OPTIMIZATION_DESIGN.md` | The design document (previous turn) |
| `server/PHASE2_ARCHITECTURE_REVIEW.md` | The architecture review (previous turn) |
| `server/PHASE2_IMPLEMENTATION_REPORT.md` | This document |

## 4. Database changes

One new migration: `068_arjuna_v4_phase2_realtime_pulse.sql` — purely
additive, no `ALTER` on any existing hot-path table's behavior:

- **`realtime_pulse_snapshots`** (new table) — one row per token per Pulse
  tick: raw price/liquidity/holders/volume/buy-sell counts +
  smart-money/KOL aggregated $ for that poll. Indexed on
  `(token_address, recorded_at DESC)`.
- **`trading_bot_trades.realtime_pulse_at_entry_json`** (new nullable
  column) — the computed Realtime Pulse signal set at the moment of BUY,
  for the self-learning dataset (original brief's Part 4) and the Daily
  Review's coverage stats.
- **`daily_trading_reviews`** (new table) — one upserted row per real UTC
  day: flat summary columns + a `report_json` blob with the full
  structured report.

Migration applied and verified locally (confirmed via
`schema_migrations`; `npm test`/smoke test both ran against the migrated
schema).

## 5. Deployment steps

Same procedure as Phase 1's checklist (commit → deploy → restart → verify
→ observe), with these Phase-2-specific additions:

1. **Migration runs automatically** on next boot (`runMigrations()`,
   unchanged mechanism) — no manual step.
2. **No new env vars, no new dependencies** — `package.json`'s
   `dependencies` list is unchanged.
3. **No feature flag needs flipping.** Every decision-influencing
   integration point (`resolveRealtimePulseModifier` in
   `researchEngineFactory.js`; the four `resolveEffective*` hooks in
   `dynamicExitService.js`) is hardcoded inert (always returns the
   existing value) — there is nothing to turn "on" yet, and nothing
   accidentally left "on."
4. Restart procedure, rollback procedure, and general verification
   commands are otherwise identical to Phase 1's checklist — additive
   only, code-only rollback (revert + restart, no migration to reverse).

## 6. Verification checklist

- [x] `npm test` — **445/445 passing** (391 pre-existing + 55 new,
  including the 2 adjusted for `computedAtMs`).
- [x] Local smoke test against the real production database copy
  (`server/data/crabsem.sqlite`) — see Section 7 for real numbers observed.
- [x] `GET /api/v1/health` → `status: "ok"`, unaffected by Phase 2.
- [x] `GET /api/v1/admin/system` → new `realtimePulse` and
  `scheduler.dailyReview` blocks populate with real values.
- [x] `realtime_pulse_snapshots` table receiving real rows every collector
  tick (418 rows after 2 ticks in the smoke test, real token data).
- [x] `GET /api/v1/admin/daily-review` → returns a real, correctly
  computed report for `2026-08-02` (1 real trade, honest null-handling
  for the empty winner group).
- [x] Admin dashboard (`admin.html`) loads the new panels without
  breaking existing ones (verified by reading the rendered output
  contract; full visual check still recommended before declaring this
  done — see note below).
- [ ] **Not yet done**: a real BUY/SELL cycle observed end-to-end in a
  live-running process long enough to see `researchEngineFactory.js`'s
  `realtimePulseModifierPoints` and `dynamicExitService.js`'s
  `resolveEffective*` hooks fire for a real candidate/position (the smoke
  test window was ~30s, too short for a full BUY-tick cycle against a
  RUNNING bot). Recommend leaving this running longer in a staging/dev
  session before the VPS deploy, per Phase 1's own "observe over days,
  not minutes" posture.

## 7. Performance impact — measured, not estimated

The architecture review (Section 7) gave *estimated* figures pending real
data. The smoke test now provides **real, measured numbers** from the
production database copy:

- **Fresh-universe size observed:** 205 tokens (within the review's
  assumed "a few hundred" range — confirmed, not guessed).
- **Pulse tick duration:** **98ms** for 205 tokens (computation + batched
  DB write), run via `setImmediate` *after* the collector batch's own
  lock release — did not affect the collector batch's own reported
  duration.
- **Rows written:** 418 real rows across 2 ticks (~209/tick, consistent
  with fresh-universe size).
- **Evicted count:** 0 (expected — short test window, fresh-universe
  membership was stable).
- **No new GMGN API calls** — confirmed by design (Pulse only reads
  already-fetched `gmgn_tokens`/`gmgn_trenches`/`gmgn_activity_feed` rows)
  and by the collector log showing the same 7 collectors, nothing new.
- **BUY/exit loop overhead per candidate:** one `getLatestSignals()` call
  — an in-memory Map lookup + arithmetic over ≤3 points — not separately
  measured in isolation but bounded by the same 98ms/205-token total
  above (each candidate's own share is a small fraction of that).

**Conclusion:** measured cost is well inside the architecture review's
performance budget, with real margin to spare — 98ms is roughly 0.3% of
the 30s collector tick interval, and the deferred/`setImmediate`
scheduling means it never competed with the collector batch's own timing
in this test.

## 8. Remaining placeholders requiring formulas from the Solution Architect

Every one of these is wired, computed, logged, and persisted — none of
them currently change any BUY/HOLD/AVOID/SELL decision. Each is a single,
clearly marked function; activating a real formula is a local change to
that function only, never a pipeline restructure.

| Placeholder | File | Currently returns |
|---|---|---|
| `resolveRealtimePulseModifier(realtimePulse)` | `researchEngineFactory.js` | `0` always (entry score unaffected) |
| `resolveEffectiveStopLossPct(position, token, realtimePulse)` | `dynamicExitService.js` | `exitConfig.hardStopLossPct` unchanged |
| `resolveEffectiveTp1TriggerPct(...)` | `dynamicExitService.js` | `exitConfig.tp1.triggerPct` unchanged |
| `resolveEffectiveTp2Pct(...)` | `dynamicExitService.js` | `exitConfig.tp2Pct` unchanged |
| `resolveEffectiveTimerMinutes(...)` | `dynamicExitService.js` | `exitConfig.timerMinutes` unchanged |
| `flowDirectionVoteProvisional` / `consistencyVoteProvisional` combination rule | `realtimePulseService.js` | Simple majority-count, observability-only — real cross-signal weighting is an open question for the Architect if a different combination is wanted |

Also flagged as open questions in the architecture review, still open
after implementation (infrastructure exists to support either answer,
no code changes needed to explore them once decided):

- Whether Buy/Sell/Holder Velocity's underlying GMGN fields actually
  refresh every real collector tick (unverified assumption) — worth
  checking against a longer real observation window now that the
  snapshot table is collecting real data.
- Whether an on-demand Pulse refresh for held positions in
  profit-protection/near-emergency territory (mirroring the existing
  on-demand price refresh) is wanted, to make exit-side momentum
  *reaction speed* faster than the 30s collector cadence, not just
  *read quality* better.

---

*Implementation complete per the mission brief. Nothing was silently
invented — every formula-shaped decision point above is explicit,
isolated, and inert pending the Solution Architect.*
