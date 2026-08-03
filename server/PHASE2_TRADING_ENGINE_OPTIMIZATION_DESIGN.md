# Phase 2 — Trading Engine Optimization Design

Status: **DRAFT — awaiting Solution Architect (ChatGPT) review. No implementation started.**

This document describes architecture only. It names no scoring weight, threshold,
multiplier, or formula that does not already exist in production today. Every
"how it will work" statement below is about data flow, storage, timing, and
integration points — never about what number decides what.

---

## Section 1 — Current Production Pipeline

### 1.1 Architecture (as of Phase 1 / commit `39354be`)

```
Collectors (gmgnTrendingScheduler, 30s tick, 7 collectors, sequential)
  trending / trenches / hot_searches / kol_activity / smart_money_activity /
  gas_price / launchpad_stats
        │
        ▼
gmgn_tokens (upsert)  gmgn_trenches (upsert)  gmgn_activity_feed (append,
  one row/token,        one row/token,          system-wide, last ~50 trades
  overwritten every     overwritten every       per feed_type, 7-day
  tick — NO history)    tick — NO history)       retention)

token_price_history (append, price/market_cap/liquidity ONLY, 48h retention)
        │
        ▼
tradingBotScheduler (15s tick)
  → freshUniverseService.getBuyCandidateUniverse()   [freshness + market-cap floor]
  → scoringWorkerPool.scoreTokens(tokens, philosophy) [once per distinct Strategy
                                                         Profile this tick, fanned
                                                         out to every due user]
        │
        ▼
productionEngineResolver.getActiveEngine()  →  researchEngineFactory ("production_v2",
                                                 Momentum Hunter — the ACTIVE engine)
  analyzeTokenWithPhilosophy(token):
    participant modules: accumulation, smartMoney, kol, whale, developer,
                          sniper, bundle, insider, walletQuality, walletProfitability
    market modules:       liquidity, security, holderDistribution, volume,
                          priceStability, momentumPhase (scoring modifier only)
    → computeUnifiedEntryScore: renormalized weighted average of the 10 modules
      that have real data, + security penalty, + wash penalty, + age bonus
      (bucketed, bonus-only), + momentum-phase modifier
    → action tier (STRONG BUY / BUY / HOLD / AVOID) from the unified score
    → safety veto (honeypot / hard security reject / liquidity floor /
      backing ratio / min holders) — the ONLY thing that can force AVOID
      regardless of score
    → confidence + risk classification
        │
        ▼
entryGateService.evaluateEntry()  [8 hard checks, in order]
  1. hasDecision                       5. min_confidence floor
  2. structural exclusion               6. gmgn_trenches presence (MISSING_QUALITY_DATA)
  3. action tier is BUY/STRONG BUY      7. qualityGateService structural gate
  4. market-data freshness (≤120s)      8. max open positions / one-per-token / cooldown / re-entry scrutiny
        │
        ▼
syntheticMarketFilterService  [final execution-time veto — bot/bundle/wash-pattern
                                orderflow shape, single current snapshot]
        │
        ▼
tradeManager.openPosition()  →  executionService (real) or virtual row (simulation)
```

Position monitoring while OPEN: `tradeManager`/`tradingBotEngine` refresh a
held position's price on-demand (bypassing the 30s snapshot) either when the
token has fallen out of the trending collector entirely, or when it has
crossed into profit-protection territory (at/above the TP1 trigger) — both
existing, proven Phase-1-era fixes, unchanged by this design.

Exit: independent `exitEvaluationScheduler` (1s outer tick; each user's own
`exit_evaluation_interval_seconds`, default 5s) → `tradingBotEngine.runExitCycle`
→ `dynamicExitService.evaluateDynamicExit`:

```
Momentum Health Score (6 components, renormalized average, computed EVERY
  cycle regardless of TP/SL state): priceAcceleration, buyerPressure,
  volumeTrend, liquidityHealth, structuralIntegrity, orderflowIntegrity
        │
        ├─ score ≤ emergency floor & context not stale → SELL_ALL (Emergency Exit)
        │
Hard Stop Loss (fixed % below entry_price, unconditional) → SELL_ALL
        │
Pre-TP1: roiPct ≥ TP1 trigger → SELL_PARTIAL (fixed fraction), 5-minute timer starts
        │
Post-TP1 "Free Ride Mode" (remaining position, NO intermediate profit floor):
  roiPct ≥ TP2 → SELL_ALL
  timer expired → SELL_ALL (Time Exit, unconditional on ROI at that moment)
```

### 1.2 Limitations found in the production audit (why Phase 2 exists)

1. **No per-token poll-to-poll history for the fields that actually define
   momentum.** `token_price_history` only carries price/market_cap/liquidity.
   Holders, buy/sell volume, smart-money $, and KOL $ are all upsert-only —
   every tick overwrites the last one. Every "momentum" proxy that exists
   today (`priceAccelerationScore`'s 5m-vs-expected-hourly-share,
   `volumeTrendScore`'s this-tick-vs-`position.last_volume_1h`) is a
   single-snapshot approximation, not a real measured delta between
   consecutive real polls.
2. **Smart Money and KOL scoring are pure totals.** `smartMoney.js`/`kol.js`
   read a rolling ~50-trade system-wide feed, sum buy/sell USD, classify
   accumulating vs. distributing by a ratio, and discount by
   `price_change_1h` magnitude ("earliness"). There is no concept of
   freshness, velocity, or acceleration — a wallet that started buying 2
   minutes ago and one that has been buying steadily for an hour can look
   identical if their totals match.
3. **`price_change_1h` is the primary timing signal**, used as the
   "earliness" discount for participant scoring. A full hour is slow
   relative to the audit's own findings: winning trades entered at roughly
   14–60 minutes token age on average; losing trades averaged roughly 482
   minutes — i.e. the losers are disproportionately old, slow-forming
   setups the 1h window is too coarse to distinguish from fresh ones in
   real time.
4. **Token age is already a soft, bonus-only signal** (`ageBonusPoints`,
   bucketed by minutes, additive, never a reject) — this part of the
   philosophy is already correct and simply needs to evolve into richer
   *timing context* (Section 7), not be re-litigated.
5. **Fake-pump / wash-trading detection is a single-snapshot veto.**
   `syntheticMarketFilterService` reads one `gmgn_trenches.raw_json` at BUY
   time — real signal, but no trend view of whether a synthetic-looking
   pattern is emerging, sustained, or already clearing.
6. **The exit side's Momentum Health Score is already well-designed**
   (continuous, renormalized, backstop-only-never-primary) but every one of
   its 6 components inherits the same underlying data gap as #1 — it
   approximates trend from single snapshots because true multi-poll history
   doesn't exist yet.
7. Two research-only paths already exist in this codebase as proven
   precedent for shipping new logic dark before trusting it in the live
   path: `decisionEngineV2` (registered in `productionVersionRegistry.js`
   but not the active version) and `candidateEngineV2.js` (explicitly
   research/shadow only, never wired into any live route or scheduler).
   Phase 2's deployment strategy (Section 14) follows this same precedent.

---

## Section 2 — Realtime Pulse Architecture

**Where it executes:** inside the same process, as a new stage that runs
immediately after `gmgnTrendingScheduler`'s 30s collector tick finishes
writing `gmgn_tokens`/`gmgn_trenches`/`gmgn_activity_feed` for that cycle.
It consumes data that has *already* been fetched for that tick — it never
makes its own GMGN API call.

**How often:** once per 30s collector tick — the fastest cadence any of the
underlying real fields actually change today, since they all come from the
same collectors. It is explicitly **not** recomputed per BUY-tick (15s),
per user, or per exit-evaluation cycle (1–30s) — those all *read* whatever
the current tick's already-computed Pulse record is. This mirrors the
"compute once, fan out" principle `tradingBotScheduler`/`scoringWorkerPool`
already use for scoring, applied one layer earlier.

**What it consumes:** the current tick's freshly-collected token/trenches/
activity-feed rows, plus a short rolling buffer of the same real fields from
the previous 1–2 ticks (Current / Previous / Previous-Previous, per the
brief's own "detect change, not just existence" requirement).

**What it produces:** one Realtime Pulse record per token per tick —
the named signals in Section 5, plus an explainable summary (direction +
consistency) — computed once and read many times that same tick by the
entry pipeline, the exit pipeline, the dashboard, and the daily report.

**How latency is minimized:** it runs synchronously inside the collector
tick's own existing budget, using data already in hand. Neither the BUY
loop nor the exit loop ever awaits a Realtime Pulse computation — they read
an already-materialized value, the same way they already read
`gmgn_tokens`/`gmgn_trenches` today. This is what satisfies "no artificial
waiting": there is no new synchronous dependency in either hot loop.

**How memory is managed:** a bounded, fixed-size rolling buffer keyed by
`token_address`, holding exactly 3 points per token (Current/Previous/
Previous-Previous), scoped to the same fresh-universe population
`freshUniverseService` already limits scoring to. A token that falls out of
the fresh/trending universe simply stops being refreshed and ages out —
no unbounded growth, same order of magnitude as data structures already
held in memory today (e.g. `gmgnTrendingScheduler`'s `collectorHealth` Map).

**How polling history is stored:** two tiers —
- **In-memory** rolling buffer for the hot computation path — zero DB
  round-trip on the path the BUY/exit loops touch.
- **Durable, per-tick snapshot table** (new, additive) — same shape and
  spirit as the existing `token_price_history` table, extended to carry the
  additional real fields Section 5's signals need (holders, buy/sell
  volume, smart-money $, KOL $ for that tick). This is what makes Realtime
  Pulse: survivable across a process restart (the in-memory buffer is empty
  on boot, same cold-start behavior every other in-memory cache in this
  codebase already has), available to the Daily Report and the Phase 4
  self-learning dataset without retroactive reconstruction, and debuggable
  (Section 10).

**How old snapshots expire:** the same retention pattern already governing
`token_price_history`/`gmgn_raw_snapshots`/`gmgn_activity_feed`
(`config/retentionConfig.js` + `services/retentionService.js`) — a new
named entry in that same config, pruned on the same existing scheduled
retention pass. The exact retention window is a configuration decision for
the Solution Architect (sized to whatever the longest realtime lookback and
the daily-report window actually need) — not invented here.

---

## Section 3 — Entry Pipeline

The future entry pipeline is the current one (Section 1.1) with **one new
stage inserted**, at the same integration point Phase 1's audit already
identified (`computeUnifiedEntryScore`'s additive spot, where `ageBonusPoints`
and `momentumModifierPoints` already live). Every other stage is unchanged.

| # | Stage | Purpose | Input | Output | Failure mode | Reason for existing |
|---|-------|---------|-------|--------|---------------|----------------------|
| 1 | Collectors | Fetch real market/orderflow/activity data | GMGN API | `gmgn_tokens`/`gmgn_trenches`/`gmgn_activity_feed` rows | Per-collector try/catch, failed collector logged, others unaffected | Ground truth for everything downstream |
| 2 | Fresh Universe filter | Exclude stale/dead rows before scoring | `gmgn_tokens` | Filtered candidate token list | Fails closed — ambiguous freshness excludes the token, never guesses | Prevents wasted scoring + downstream `STALE_MARKET_DATA` rejects |
| 3 | **Realtime Pulse computation (NEW)** | Compute this tick's velocity/acceleration/flow signals per token | Current + Previous + Previous-Previous poll snapshots (Section 2) | Realtime Pulse record per token, cached for the tick | Fails **open** to neutral/absent, same convention every existing scoring module already uses — never blocks Research from running, never fabricates a signal from insufficient history | Decouples "which token" from "is momentum happening right now" |
| 4 | Research Engine scoring (unchanged) | Decide **which token** — participant credibility + market health + unified entry score + action tier | Fresh token + trenches + activity feed + wallet stats | Action tier, confidence, risk, full reasons/breakdown | Missing sub-module data → neutral, renormalized (existing, proven) | This is Arjuna's opportunity-discovery brain — preserved wholesale |
| 5 | **Realtime Pulse integration (NEW)** | Confirm the Research Engine's candidate is backed by *currently emerging* momentum, not stale/exhausted signal | Research Engine's action/score + this tick's Realtime Pulse record | An adjustment to score/confidence at the same additive spot `ageBonusPoints`/`momentumModifierPoints` already occupy | Deployed inert (observation mode) until the Solution Architect defines real formulas from observed production data (Section 14) — when inactive, contributes nothing and changes no decision | The literal mechanism for "Research chooses the opportunity, Realtime Pulse chooses the timing" |
| 6 | Entry Gate (unchanged) | Final binary safety/business-rule gate — 8 existing hard checks | Action/confidence + position/cooldown state | Eligible true/false + specific reason | Fails closed — any unclear state rejects, never guesses | Already proven, no gap Phase 2 needs to touch |
| 7 | Synthetic Market Filter (evolves per Section 6) | Final execution-time veto on bot/bundle/wash-shaped orderflow | `gmgn_trenches.raw_json`, evolving to also read Realtime Pulse trend context | Pass / reject | Fails open — missing/unparseable data never rejects | Catches structurally "clean" but synthetically-traded tokens the Entry Gate's other checks don't see |
| 8 | Execution (unchanged) | Open the position, real or simulated | Approved candidate | Position row, real tx if LIVE | Existing execution state machine / reconciliation, unchanged | Out of scope for Phase 2 |

---

## Section 4 — Exit Pipeline

The exit architecture (state machine, thresholds, step order) is
**unchanged**. What evolves is the *data* feeding Momentum Health and
reversal detection — from single-snapshot proxies to real multi-poll trend
signals, using the same Realtime Pulse buffer Section 2 introduces.

**Position Monitoring / realtime price refresh** (unchanged) — the existing
on-demand refresh (token fell out of trending, or position is in
profit-protection territory) still governs when a fresh price read happens
outside the normal 30s cadence.

**Realtime Pulse for held positions (NEW)** — the same per-tick computation
described in Section 2, read every exit-evaluation cycle for each open
position's own token. This generalizes a pattern that already partially
exists — `volumeTrendScore` already compares "this reading vs.
`position.last_volume_1h`", a de facto 2-point history — into the same
3-point Current/Previous/Previous-Previous window used on the entry side,
and extends the same treatment to buyer pressure, liquidity, and structural
integrity.

**Momentum Health Score (evolves, not replaced)** — same 6-component
renormalized-average machinery, same "backstop only, never the primary exit
driver" role (unchanged from the existing CTO decision already encoded in
this file). Realtime Pulse's richer trend signals become additional/refined
inputs to this **same** score, not a second parallel score — preserving one
continuous, explainable exit-health read rather than adding a competing
signal.

**Dynamic TP / Dynamic SL (unchanged)** — Hard Stop Loss, TP1 partial +
timer, Free Ride Mode (TP2 / Time Exit). Phase 2 does not touch the
state-machine steps or their numbers; those remain the Solution Architect's
to revisit if and when the observed data warrants it, not invented here.

**Momentum weakening / reversal detection (evolves per the same pattern as
Momentum Health)** — the same real underlying facts
(`structuralIntegrityScore`, `orderflowIntegrityScore`) become trend-aware
(is integrity/orderflow *degrading* across recent polls) instead of
point-in-time only.

**Time Exit / Emergency Exit (unchanged)** — pure timer fallback and
structural-collapse backstop respectively, both explicitly "never the
primary exit driver" — this framing is preserved exactly.

---

## Section 5 — Realtime Signals

Every signal below is computed from the Realtime Pulse poll history
(Section 2): the token's Current, Previous, and Previous-Previous polls,
each drawn from real, already-collected GMGN data. **No formula, weight, or
threshold is specified here — only what each signal represents, where its
data comes from, and how it behaves.**

Refresh frequency for every signal below is identical: once per 30s
collector tick (Section 2) — none of them are recomputed on the faster
15s/1s scheduler loops.

### Participant-flow signals

| Signal | Purpose | Data source | How it changes over time | Expected behavior | Difference from today |
|---|---|---|---|---|---|
| Smart Money Velocity | How fast real smart-money $ flow is building for this token right now | `gmgn_activity_feed` (`feed_type='smart_money'`) | Compares this poll's smart-money $ activity against the prior poll(s) | Rises when fresh smart-money buying is actively accelerating; falls toward zero when activity has stalled | Today: a single cumulative total with no time dimension |
| KOL Velocity | Same concept, for KOL wallet activity | `gmgn_activity_feed` (`feed_type='kol'`) | Poll-to-poll comparison of KOL $ activity | Same shape as Smart Money Velocity | Today: single cumulative total |
| Buy Velocity | How fast real buy-side transaction activity is building | `gmgn_trenches`/`gmgn_tokens` buy counts/volume | Poll-to-poll change in buy activity | Rises with genuinely accelerating buy interest | Today: only a single-window total (e.g. `buys_5m`) |
| Sell Velocity | How fast real sell-side activity is building | Same source, sell side | Poll-to-poll change in sell activity | Rises when distribution is accelerating | Today: only a single-window total (`sells_5m`) |
| Buy Pressure | Current balance of buy vs. sell activity | Buy/sell counts or volume for the current poll | A point-in-time ratio, refreshed each poll | High when buying currently dominates | Already exists today as a single-snapshot ratio (`buyerPressureScore`) — Pulse adds the poll-to-poll trend of this ratio, not just its current value |
| Sell Pressure | Inverse of Buy Pressure | Same source | Same, sell side | High when selling currently dominates | Same evolution as Buy Pressure |
| Net Buy Velocity | Rate of change of net buy/sell imbalance | Buy/sell volumes across polls | Poll-to-poll delta of (buy − sell) | Rises when net accumulation is genuinely building, not just present | Today: `net_buy_24h` is a single rolling total with no rate-of-change view |

### Market-structure signals

| Signal | Purpose | Data source | How it changes over time | Expected behavior | Difference from today |
|---|---|---|---|---|---|
| Liquidity Velocity | How fast pool liquidity is changing | `gmgn_tokens.liquidity` | Poll-to-poll delta | Rising liquidity alongside price = healthier; liquidity draining alongside a price rise = a red flag | Today: liquidity is read as a single current value only |
| Holder Velocity | How fast the real holder count is changing | `gmgn_tokens.holders` | Poll-to-poll delta | Rising holder count = broadening organic interest; flat/falling despite a price rise = a red flag | Today: holder count has no history at all — not even a single-snapshot proxy exists |
| Volume Velocity | How fast trading volume is changing | `gmgn_tokens.volume_1h` (or equivalent) | Poll-to-poll delta | Confirms whether a price move is backed by genuinely growing volume | Today: `volumeTrendScore` already compares this-tick-vs-last-tick — Pulse generalizes this to the shared 3-point buffer, available to entry scoring too, not only exit |

### Composite / derived signals

| Signal | Purpose | Data source | How it changes over time | Expected behavior | Difference from today |
|---|---|---|---|---|---|
| Momentum Acceleration | Whether the RATE of positive change is itself increasing | Derived from the velocity signals above across 3 polls | Second-order — a trend in the trend | High when a move is genuinely gathering speed, not just present | Today: no second-order signal exists anywhere in the engine |
| Momentum Deceleration | Whether the rate of positive change is fading | Same derivation, opposite direction | Rises as a prior move loses steam | Flags a token that is exhausting, before price itself has clearly turned | Today: only inferable retroactively, after price has already dropped |
| Realtime Flow Direction | The single dominant direction across the participant + market signals right now | Combination of the above, read together | Re-evaluated every poll | A plain, explainable "accumulating" / "distributing" / "mixed" read | Today: each module infers its own direction independently, with no single unified realtime read |
| Realtime Momentum Consistency | Whether the signals above agree with each other across consecutive polls, or are noisy/conflicting | Same signals, checked for agreement across the 3-point window | High when multiple independent signals move the same direction together, repeatedly; low when they conflict or flip poll-to-poll | Distinguishes a genuine, broad-based move from a single noisy spike | Today: no cross-signal consistency check exists |

---

## Section 6 — Fake Pump Detection

**Architecture only — no new formula.** This section describes how the
*existing* final-execution-filter (`syntheticMarketFilterService`, Section
3 stage 7) evolves from a single-snapshot veto into a trend-aware one, using
the same Realtime Pulse buffer as everything else in this document. Its
position in the pipeline (post-Entry-Gate, pre-execution), its fail-open
philosophy, and its "veto only, never adds to scoring" role are unchanged.

**How a fake pump differs from healthy momentum:** healthy momentum shows
buy pressure, holder growth, and volume rising *together with* price across
consecutive real polls (Realtime Flow Direction agreeing across signals,
high Realtime Momentum Consistency). A fake pump shows price rising in
isolation — without confirming buy pressure, holder growth, or volume
across those same polls — or a burst pattern that spikes and reverses
within a very short poll window, which is only visible as a poll-to-poll
direction flip, never visible in a single snapshot.

**How wash trading differs from genuine buying:** the existing real
orderflow signals (`bot_degen_rate`, `bundler_trader_amount_rate`,
`rat_trader_amount_rate`, `entrapment_ratio`, `fresh_wallet_rate`,
`suspected_insider_hold_rate`, holder/swap diversity, buy/sell balance
clustering) are unchanged and remain the primary evidence. What evolves is
*when* they're trusted: a synthetic-looking pattern that is momentary
(present on one poll, gone the next) is architecturally distinguishable
from one that is sustained across multiple polls, using the same buffer
Section 2 introduces.

**How bot activity differs from organic demand:** bot-driven activity tends
to be mechanically uniform poll-to-poll (the same shape repeating), while
organic demand shows the natural variability of many independent real
actors — this is exactly what Realtime Momentum Consistency (Section 5) is
designed to expose: a *too*-consistent, mechanical pattern is itself a
signal, distinct from healthy, broad-based, mildly-noisy real conviction.

---

## Section 7 — Token Age

Token age is **already** a soft, bonus-only signal in production
(`ageBonusPoints`, bucketed by minutes-since-launch, purely additive, never
a reject — confirmed unchanged since before this sprint). This philosophy
is correct and Phase 2 does not revisit whether age should be a hard
filter; it does not become one.

**The evolution:** today, age is evaluated in isolation — "how old is this
token" as a static lookup. Phase 2 turns age into **timing context**: age
is read *together with* the Momentum Acceleration/Deceleration and Realtime
Flow Consistency signals (Section 5), so the engine's real question becomes
"given this token's age, is momentum still building or already fading" —
not "is this token young or old." A young token with decelerating momentum
and an old token with genuinely accelerating momentum are both real,
distinguishable situations this evolution is designed to surface, that a
static age bucket alone cannot.

Architecturally, this plugs into the exact same additive integration point
`ageBonusPoints` already occupies today (Section 3 stage 5) — it is a
richer input to the same spot, not a new gate, and it can never reject a
token for age alone, exactly as the original brief requires.

---

## Section 8 — Smart Money Evolution

**Today (static snapshot):** `smartMoney.js` reads the current tick's
~50-trade system-wide `gmgn_activity_feed` window filtered to a token, sums
buy/sell USD, classifies accumulating vs. distributing by a ratio, blends
the result toward neutral when the sample is too small to be meaningful,
and discounts the whole thing by `price_change_1h` magnitude ("earliness").
This is a single point-in-time total — a wallet that started buying 2
minutes ago and one that has been steadily buying for an hour can look
identical if their current totals match.

**Phase 2 (realtime flow):** the existing classification philosophy
(accumulating vs. distributing, volume-significance gating) is **unchanged
and reused** — not replaced. What's added, using the Realtime Pulse buffer:

- **Freshness** — is this smart-money activity new (first appearing in the
  last poll or two) or long-established.
- **Velocity** — is smart-money $ volume growing poll-to-poll (Section 5).
- **Acceleration** — is that growth itself speeding up.
- **Buy/sell transition** — did the smart-money flow just flip direction.
- **Poll-to-poll evolution / flow consistency** — is the direction
  sustained across multiple real polls, or a single noisy reading.

Architecturally this is additive: the existing static score becomes one
input alongside these new trend-based signals, computed by the same module,
at the same point in the pipeline (`participantModules.smartMoney`). Its
existing fail-open behavior (`hasData:false` → neutral, no reason string)
is preserved for the new trend signals too — insufficient poll history
never fabricates a velocity/acceleration reading.

---

## Section 9 — KOL Evolution

Identical evolution to Section 8, applied to `kol.js`. Today: the same
static-total-plus-earliness-discount shape, reading `gmgn_activity_feed`
with `feed_type='kol'`. Phase 2 adds the same five dimensions — velocity,
freshness, acceleration, trend direction, poll-to-poll evolution — computed
from the same shared Realtime Pulse buffer, additive to the existing
classification logic, with the same fail-open guarantee on insufficient
history.

---

## Section 10 — Realtime Observability

**Logs:** Realtime Pulse gets its own log line per tick per candidate
actually under consideration (not every fresh-universe token, to avoid
log-spam), following the exact existing convention already used throughout
this codebase — `[momentum-health]` (dynamicExitService.js),
`[synthetic-filter]` (syntheticMarketFilterService.js),
`[stale-market-data]` (entryGateService.js). A `[realtime-pulse]` line
states the computed signals and the resulting direction/consistency read,
in the same human-readable style.

**Database:** the new per-tick snapshot table (Section 2) *is* the durable
observability record. Every Realtime Pulse value that ever influenced (or,
while in observation mode, could have influenced) a decision is queryable
after the fact — the same durability guarantee `breakdown_json`/
`module_scores_json` already give today's scoring breakdown per trade.

**Admin dashboard:** extends the existing CEO Dashboard / Position Detail
surfaces (which already render a persisted Confidence Breakdown and
Strength/Weakness per position) with a Realtime Pulse panel per candidate/
position — same pattern: read an already-persisted JSON record, render it,
no new live computation on page load.

**Daily report:** the persisted Realtime Pulse history is exactly the
dataset Section 11's report reads from — no new SQL required, per the
original brief's own requirement.

**Debugging capability:** because every signal fails open to neutral/absent
and is independently logged and persisted, a candidate that had no Realtime
Pulse confirmation is distinguishable after the fact from one that did, and
from one that had confirmation but was still held back by Research —
matching the "every BUY, every HOLD, every EXIT must have understandable
reasons" objective directly.

---

## Section 11 — Daily Trading Review

**Trigger:** a new, genuine once-a-day scheduler (day-rollover triggered),
distinct from the existing `predictionValidationScheduler`'s continuous
"recompute today" pattern — the production audit found no existing
once-a-day job, so this is a new scheduler, not an extension of one.

**Data sources:** the existing `trading_bot_trades` table (already rich —
confidence, participant score, market health, token age at entry, MFE/MAE,
exit classification, and more, all real and already captured) plus the new
Realtime Pulse snapshot table (Section 2) for entry/exit-time signal
context.

**Output:** a structured, stored report (same durable-artifact pattern
`engine_daily_metrics` already establishes) covering exactly the categories
the original brief lists: Total Trades, Win/Loss Rate, Net Profit, Average
ROI/MFE/MAE/Holding Time, Exit Reason Distribution, Confidence/Participant/
Market Health/Liquidity/Token Age/Holding Duration Analysis, Best/Worst
Performing Pattern, Most Frequent SL/TP Characteristics, Most Common
Winning/Losing Conditions, Top 5 loss reasons, Top 5 profit reasons, and
Suggested parameter adjustments. Every field is a descriptive aggregation
of already-captured real data — no new formula, and per the brief's
explicit requirement, this report **never** automatically modifies
production formulas.

**Surface:** rendered as a dashboard page (extends the existing CEO
Dashboard pattern), so "no SQL should be required" is genuinely true — a
human reads a page, never runs a query.

---

## Section 12 — Performance Budget

Phase 2's central cost-control decision is **Section 2's "once per 30s
collector tick" cadence** — every cost below follows from that.

**Memory:** a bounded, fixed-size (3-point) rolling buffer per token,
scoped to the fresh-universe population already held in memory today by
the scoring pass — same order of magnitude as existing in-memory
structures (e.g. `collectorHealth`), not a new unbounded structure.

**CPU:** Realtime Pulse computation runs exactly once per 30s tick, never
per-user and never per BUY-tick (15s) or exit cycle (1–30s). This means its
CPU cost scales with token-universe size and the fixed 30s cadence only —
**not** with the number of running users or trade frequency. Both the BUY
loop and the exit loop pay only the cost of reading an already-computed
value, never the cost of computing one.

**Database:** one new lightweight insert per token per 30s tick — the same
shape and cost class as the existing `token_price_history` insert, which
already happens every 30s today. The read path is a fixed 3-row lookback
per token (indexed), not a table scan.

**Polling / Network:** zero new GMGN API calls. Realtime Pulse consumes
only data the existing 7 collectors already fetch every 30s. This is the
direct reason it can satisfy "no artificial waiting" — it never introduces
a new network round-trip anywhere in the decision path.

**Net effect on latency:** the BUY loop and exit loop each gain one fast,
already-computed lookup instead of a new computation or new I/O. The added
latency per decision is a single in-memory/indexed read, not a new
synchronous dependency chain — Arjuna's realtime character is preserved by
construction, not by tuning after the fact.

---

## Section 13 — Backward Compatibility

**Unchanged:**
- Research Engine's entire scoring architecture — participant/market
  module split, `combineScore` renormalization, structural self-validation
  penalty, safety veto, action tiers, confidence blend.
- Entry Gate's 8 existing checks, in the same order.
- Dynamic Exit's state-machine steps and numbers — Hard SL, TP1, Free Ride
  Mode, TP2, Time Exit.
- Synthetic Market Filter's existing pass/reject logic (only its future
  *input* gains trend context — see Section 6).
- Collector/scheduler cadences (30s collectors, 15s BUY tick, per-user exit
  interval).
- Every existing table's schema — Phase 2 is purely additive (new table(s)
  only, no `ALTER` on any hot-path table).
- Every existing API/dashboard endpoint — only additive fields/panels.

**Changes:**
- New Realtime Pulse computation stage + new snapshot table (additive
  schema, new scheduler-adjacent stage).
- New integration point in the entry pipeline (Section 3, stage 5) —
  deployed inert/observation-mode initially (Section 14).
- Momentum Health Score's *inputs* get richer (Section 4); its own
  combination machinery and backstop-only role are unchanged.
- New daily report generator + storage — wholly new, touches no existing
  behavior.
- Admin dashboard gains new panels — additive only.

---

## Section 14 — Deployment Strategy

**Feature flag:** Realtime Pulse's computation/persistence/logging stage
(Section 2) is safe to ship and run in production immediately — it is
additive, makes zero new network calls, and influences no decision by
itself. Its **decision-influencing** integration point (Section 3, stage 5)
ships behind an explicit off-by-default flag, mirroring the existing
`DECISION_ENGINE_V2_EXPLAIN`-style env-gated pattern already proven in this
codebase for shipping new logic dark before it's trusted.

**Staged rollout:**
1. Ship Pulse computation, persistence, and logging only. Verify data
   quality and coverage in production for a real observation window.
2. Enable the dashboard and daily-report surfaces reading that data — still
   zero decision impact.
3. Only once the Solution Architect has defined real formulas from that
   observed data (per your explicit Phase 2 pre-condition) does the entry
   pipeline's integration point get activated — behind the same flag, so it
   can be disabled instantly without a redeploy.

**Rollback:** Phase 2 is additive-only (Section 13), so rollback is the
same code-only procedure already used for Phase 1 — revert + restart, no
migration to reverse. The new table simply stops being written to/read
from; no existing table is ever altered, so there is no schema rollback
risk.

**Validation plan:** the same layered approach already used for Phase 1 —
automated tests for the Pulse computation/storage logic first (deterministic,
using this codebase's existing stub/mock conventions), then a local/staging
dry run against a real DB copy to confirm signal coverage and log output
look sane, then a production deploy with the decision-influencing flag OFF.

**Smoke test (post-deploy):** confirm (a) the new snapshot table is being
written every 30s tick for the fresh universe, (b) the dashboard panel
populates with real values, (c) **zero change** in BUY/SELL decision
behavior versus pre-deploy — same entries/hour, same exit reason
distribution — proving the flag is genuinely inert.

**Production verification:** observe over days, not minutes (same posture
as Phase 1's checklist) — confirm entry frequency holds at the ~10+/hour
target, confirm no added latency in the BUY/exit loops, and manually
spot-check a handful of real tokens' Realtime Pulse values against their
actual on-chain/GMGN behavior before ever proposing to flip the
decision-influencing flag on.

---

*End of document. No code was written or modified to produce this design.*
