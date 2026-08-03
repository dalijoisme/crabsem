# Phase 2 — Architecture Review

Status: **REVIEW ONLY. No code written. No formulas, thresholds, weights, or
multipliers proposed anywhere below.** This document critically reviews
`PHASE2_TRADING_ENGINE_OPTIMIZATION_DESIGN.md` — including calling out real
weaknesses in that design, not just restating it.

**One honest framing up front, because it governs almost every section
below:** "Realtime" in Realtime Pulse means *reacts to change between
polls*, not *sub-30-second live streaming*. Every signal in this design is
still bound by GMGN's own collector cadence (nominally 30s, empirically
sometimes much worse — see Section 1 and Section 7). No architecture
change in this document can make Arjuna faster than its own data source.
Several of the risks identified below trace back to this one fact.

---

## Section 1 — Realtime Pulse Architecture (deep review)

### Data flow, precisely

The original design said Pulse runs "immediately after the collector tick
finishes." On closer review this needs to be more precise, because it
changes the risk profile:

`gmgnTrendingScheduler` runs its 7 collectors **sequentially**, each spaced
~1.2s apart, and — per a real value observed while smoke-testing Phase 1 —
the batch can take far longer than 30s when GMGN itself is slow (one
observed batch: **57.5 seconds**, driven by a single collector timing out
at 15s and apparently retrying). This means:

- Within a single "tick," `gmgn_tokens` (trending) and `gmgn_activity_feed`
  (smart_money/kol) are **not** written at the same instant — they can be
  several seconds to tens of seconds apart. A Pulse computation that treats
  "this tick" as one synchronized snapshot is not strictly accurate; it's
  a snapshot of *whichever collectors happened to succeed and finish by
  the time Pulse runs*, which can be a partial, staggered picture.
- The "30s cadence" assumed throughout the design document is the
  **nominal**, not the **actual**, interval. Actual gaps between polls can
  be 30s, 60s, 90s+, irregularly, depending on GMGN's health.

**Risk this creates:** any velocity/acceleration math that assumes a fixed
Δt between polls will be systematically wrong whenever the real interval
deviates from that assumption — and it deviates most exactly when GMGN is
under load, which correlates with high market activity, i.e. precisely
when Arjuna most needs a trustworthy signal.

**Architecture correction:** each buffered poll must carry its own real
timestamp, and every delta-based signal must be computed against the
*actual* elapsed time between two real polls, not an assumed constant. A
"previous" point that is far older than the nominal interval (because a
tick was slow or skipped) should be treated as **stale**, not blindly used
as if it were a normal 30s-old reading. This is a correction to the
original design, not something it already specified.

### Lifecycle

1. **Poll ingestion** — once a collector tick's data is available, Pulse
   reads the current real values for a token, compares them against the
   buffered Previous/Previous-Previous points, computes the signals
   (Section 2/6), and writes both the in-memory buffer update and the
   durable snapshot row.
2. **Consumption** — the entry pipeline (15s BUY tick) and exit pipeline
   (1–30s per user) read whatever the *latest computed* Pulse record is;
   neither loop ever triggers or waits on a Pulse computation.
3. **Eviction** — **this was under-specified in the original design.** "Ages
   out" is not a real mechanism by itself. A token that permanently drops
   out of the fresh universe (rugged, delisted, stopped trending) needs an
   **explicit** removal from the in-memory Map, or it sits there forever —
   a genuine, slow memory leak. The correction: on each computation pass,
   compare the current fresh-universe token set against the buffer's
   keys, and drop any buffer entry whose token is no longer in that set
   (or hasn't been refreshed within some bound). This must be an explicit
   step in the implementation, not an assumption.

### Polling lifecycle vs. memory lifecycle vs. expiration lifecycle

These are three genuinely different lifetimes and the design needs to keep
them distinct:

| Lifecycle | Lives in | Bound by | Risk if conflated |
|---|---|---|---|
| Polling | Collector tick cadence | GMGN's own responsiveness (Section 1's finding above) | Assuming fixed intervals produces wrong deltas |
| In-memory buffer | Process memory (Map) | Fresh-universe membership + explicit eviction | No eviction = leak |
| Durable snapshot table | SQLite, on disk | `retentionConfig.js`-style pruning | Unbounded growth if not added to the existing retention pass |

### Recovery after restart

On process restart, the in-memory buffer starts empty — same cold-start
behavior every other in-memory cache in this codebase already has
(`collectorHealth`, `token_last_decision`-adjacent state, etc.), so this is
not a new class of problem. Concretely: for the first 1–3 ticks after a
restart, every token has fewer than 3 real points, so Pulse fails open to
neutral for all of them — the entry pipeline's Pulse-integration stage
contributes nothing during that window (an acceptable, bounded, ~60–90s
cold window under nominal cadence — longer under the degraded cadence
described above).

**Improvement worth considering:** since the durable snapshot table
already persists the last few real polls per token, the buffer could be
**warm-started** from that table on boot (read the most recent 1–3 rows
per fresh-universe token) instead of starting fully cold. This removes the
post-restart blind window almost entirely and is a low-cost addition — it
reuses data that's being written anyway. This is a genuine improvement to
propose, not something the original design already included.

### Synchronization with collectors

Already covered above (partial-tick skew, irregular real cadence). One
more concrete implication: Pulse should **not** be its own independently
scheduled timer. It should be chained directly onto the *end* of the
existing collector tick (a callback/continuation, not a second
`setInterval`). Two independent timers drifting relative to each other is
exactly how you get double-counted or skipped polls (see "duplicate
polling" in Section 8). Chaining onto the existing tick also means Pulse
inherits Phase 1's already-proven single-flight lock guard for free — no
new concurrency primitive needed.

### Synchronization with the Research Engine

Research reads `gmgn_tokens`/`gmgn_trenches` directly on its own 15s BUY
tick; those rows are themselves only as fresh as the last successful
collector run (30s+). Pulse computes once per collector tick too. **This
means Research and Pulse are bound by the exact same underlying freshness
ceiling — Pulse does not introduce a new staleness gap relative to
Research, because neither of them can be fresher than GMGN's own data.**
Two consecutive 15s BUY ticks will very often read the identical Pulse
record between two Pulse computations — this is expected and correct, not
a bug.

The one real edge case: because of partial-tick skew (above), it's
possible for `token.updated_at` (price/liquidity) to be fresher than a
given token's smart-money/KOL Pulse sub-signal in the same instant, if
that particular collector lagged or failed that tick. **Correction to the
design:** Pulse's record should expose which of its inputs were actually
refreshed this pass vs. carried over from an older poll (a per-field
freshness/coverage fact), mirroring the `hasData:false`-never-fabricated
convention already used throughout `intelligenceEngine.js`. Without this,
a consumer can't tell "genuinely confirmed neutral" apart from "we simply
don't have a fresh reading yet."

---

## Section 2 — Realtime Signal Buffer: 3 vs. 4 vs. 5 points

**Why 3 is the correct minimum, not an arbitrary choice:**
- 2 points (current + previous) is the floor for *any* delta/velocity
  signal — this already exists informally today (`volumeTrendScore`
  compares against `position.last_volume_1h`).
- **3 points is the minimum that supports acceleration** (a delta of
  deltas needs three readings: velocity₁ = p2−p1, velocity₂ = p3−p2,
  acceleration = velocity₂−velocity₁) and the minimum that can see a
  direction *flip within the window* (up-down-up, not just up-down). This
  is also literally what the originating brief specified ("Current Poll,
  Previous Poll, Previous-Previous Poll") — 3 is not a number this review
  is inventing, it's the brief's own requirement, justified independently
  by the acceleration requirement above.

**Would 4 points be better?** Marginally, for one specific thing: a second
acceleration reading (comparing accel₁ vs accel₂) gives one extra
confirmation for the *consistency* signal specifically, and a little
noise-smoothing. Cost: at nominal 30s cadence, 4 points span ~90s of real
time instead of ~60s. That's a real, direct tension with responsiveness —
a genuine reversal happening inside that wider window takes longer to be
fully reflected if the design ever requires all 4 points to agree.

**Would 5 points be better?** No — this is where the tradeoff turns
negative. A 5-point requirement spans ~120s of real time at nominal
cadence (more under any degradation). Two concrete costs:
1. **Time-to-first-opinion for brand-new tokens.** A token discovered on
   its first or second collector tick simply doesn't have 5 real polls
   yet — it wouldn't for several minutes. Since Arjuna's own philosophy
   (and the audit's own finding — winners entered at ~14–60 minutes token
   age) explicitly wants to be aggressive on **very fresh** tokens, a
   design that needs 5 points before it has *any* opinion works against
   exactly the population Arjuna most wants to catch early.
2. **Reaction lag to a genuine sudden reversal.** The wider the required
   window, the slower any consistency-style signal can "believe" a real,
   fast reversal — directly in tension with "never become a lagging
   engine."

**Memory tradeoff:** trivial in absolute terms either way (a few extra
numbers per token — see Section 7's concrete math) — this is not the
deciding factor.

**Latency tradeoff:** also not the deciding factor by itself (computing
over 3, 4, or 5 points costs about the same, sub-millisecond, per token).
The real cost of a larger window is **elapsed wall-clock time before the
signal is trustworthy**, not compute time.

**Engineering tradeoff, stated plainly:** every point added to the buffer
trades a small amount of noise-robustness for a proportional amount of
responsiveness — and responsiveness is the one thing this entire sprint is
explicitly not allowed to sacrifice.

**Justified architecture:** keep 3 points canonical, as specified. Do not
let this grow to 4 or 5 as an implementation convenience later ("while
we're at it, let's smooth it more") — that drift is exactly the kind of
scope creep that would quietly turn a realtime signal into a
delayed-confirmation one. If a *specific* signal genuinely needs more
smoothing once real data is observed, that should be a deliberate,
individually-justified exception for that one signal — never a change to
the shared buffer size for all of them.

---

## Section 3 — Entry Pipeline (stage-by-stage review)

| Stage | Why it exists | Can it be simplified? | Latency introduced | False-negative risk | Threatens aggressive philosophy? |
|---|---|---|---|---|---|
| 1. Collectors | Ground truth | No — nothing downstream works without it | None (unchanged) | Only under collector degradation (pre-existing, not new) | No |
| 2. Fresh Universe filter | Avoid scoring stale rows | Already minimal | Negligible (SQL filter) | Under GMGN degradation, more tokens get excluded as "stale" exactly when the market may be most active — a **pre-existing** risk, not introduced by Phase 2, but Phase 2 does not fix it either | Indirectly, only under degraded conditions |
| 3. **Realtime Pulse computation (new)** | Turn snapshot data into change-over-time data | No — this is the core new capability | **Real risk if implemented naively** (see below) | None by itself — fails open to neutral on insufficient history | Only if implemented wrong (see below) |
| 4. Research Engine scoring | Decide *which* token | No — unchanged, proven | Unchanged | Unchanged | No |
| 5. **Pulse integration point (new)** | Confirm timing without replacing Research's judgment | Not simplifiable — this is the requested mechanism | None if additive-only (see below) | **Highest-risk stage in the whole design** — see below | **Highest-risk stage in the whole design** — see below |
| 6. Entry Gate | Final safety/business rules | No — proven, unchanged | Unchanged | Unchanged | No |
| 7. Synthetic Market Filter (evolving) | Catch bot/wash/synthetic orderflow | No | Risk if evolved wrong (see below) | Could increase if implemented as a "wait for confirmation" gate | Risk if implemented wrong (see below) |
| 8. Execution | Open the position | No | Unchanged | Unchanged | No |

### Stage 3 — the real latency risk

If Pulse computation runs **synchronously and inline** inside the
collector tick's own execution, and the fresh-universe population is large
or GC pressure is non-trivial, it can lengthen the collector tick itself.
Because Node is single-threaded, that doesn't just slow collectors down —
it can delay **everything else sharing the event loop**, including the
exit-evaluation scheduler's fast 1s tick, which is exactly the loop
responsible for reacting quickly to a real stop-loss. This is a genuine,
concrete risk that the original design document did not call out.

**Mitigation to build in:** scope Pulse's per-tick work strictly to the
fresh-universe population (already filtered, much smaller than the full
token table), and either timebox it (same convention `scoringWorkerPool`
already uses — a real 60s timeout precedent in this codebase) or, if
computation cost turns out non-trivial once measured, offload it the same
way scoring already offloads CPU-bound work to a worker
(`scoringWorkerPool`). Do not let it block the event loop unbounded.

### Stage 5 — the highest-risk stage, examined closely

This is where "Research chooses the opportunity, Realtime Pulse chooses
the timing" actually gets implemented, and it is the single place in this
entire design most capable of silently violating "never wait for perfect
confirmation" if built carelessly.

**The risk:** nothing in the original design *structurally* prevents a
future implementer from wiring this stage as a second pass/fail gate
(e.g., "reject if Pulse disagrees") instead of a same-tick multiplier.
That would directly reintroduce exactly what the original sprint brief
forbade — Realtime Pulse becoming a hard filter that reduces trade
frequency.

**Architectural correction:** this integration point should be
**structurally** constrained to the same shape `ageBonusPoints`/
`momentumModifierPoints` already use in `computeUnifiedEntryScore` —
additive, bounded-magnitude, contributes a number into the same score,
never introduces a separate pass/fail branch and never overrides the
action tier by itself. This isn't a formula choice (no number is proposed
here) — it's a *shape* constraint: whatever the eventual formula is, it
must be wired as one more additive term, not a new conditional gate. This
should be treated as a hard architectural rule for this stage, not
something left to formula-time judgment.

### Stage 7 — the same risk, in a different place

The Synthetic Market Filter's evolution (persisted trend context instead
of a single snapshot) must strictly be interpreted as **gaining a new
catching capability** (spotting a momentary spike it couldn't see before),
never as **requiring N polls of sustained cleanliness before a candidate
is allowed to pass**. The latter framing would quietly add a waiting
requirement to the execution path — a real, if subtle, violation of "no
delayed buy." The design document's wording ("evolves," "additive") is
directionally correct but should be made explicit as a hard constraint
here too, for the same reason as Stage 5.

---

## Section 4 — Exit Pipeline (deep review)

### How realtime monitoring actually works, precisely

Two genuinely different mechanisms exist and must not be conflated:

1. **Price monitoring** — already fast today (on-demand refresh bypassing
   the 30s snapshot, triggered when a position enters profit-protection
   territory or falls out of trending). This mechanism is **unchanged** by
   Phase 2.
2. **Momentum-context monitoring (Realtime Pulse for held positions)** —
   bound by the same collector-tick cadence as everything else in this
   document (30s nominal, worse under degradation). The exit-evaluation
   loop can check a position every 1–5s, but it will read the **same**
   Pulse record across many consecutive checks in a row, because Pulse
   itself only updates once per collector tick.

**Honest conclusion:** Phase 2 improves the *quality* of the momentum
context the exit system reasons about, but it does **not** make the exit
system react to momentum changes any faster than ~30s (worse under
degradation) — only price reactions are currently sub-30s. If "react
faster to momentum changes" is meant literally (not just "reason better
about momentum, at the existing cadence"), the current design under-serves
that objective.

**Improvement worth considering:** extend the *existing* on-demand refresh
mechanism (already proven for price) to also request an on-demand Pulse
refresh for a specific held position when it enters
profit-protection/near-emergency territory — the same escape-hatch shape
already used for price, applied to momentum context too. This is a real
gap in the original design worth flagging for the Solution Architect,
not something to silently assume is already covered.

### How TP adapts / how SL adapts / how Time Exit evolves

**This needs to be stated plainly, because the original design document
was not explicit enough here:** Phase 2, as designed, does **not** make
the TP1/TP2/Hard-Stop-Loss/Time-Exit *thresholds* dynamic or reactive to
Realtime Pulse. Those remain the fixed state-machine numbers they are
today (deliberately — changing them is a formula decision reserved for the
Solution Architect, not this design). What Phase 2 actually changes is the
**input quality** to the Momentum Health emergency backstop and reversal
detection — i.e. it makes the system's read of "is this deteriorating"
more accurate, not the TP/SL levels themselves more adaptive.

If genuinely adaptive TP/SL (e.g., trailing based on Realtime Pulse
momentum) is part of the intent behind "Dynamic TP. Dynamic SL." in the
original brief, **that is an open design question this document does not
yet resolve**, and should be raised explicitly with the Solution Architect
rather than assumed to already be in scope. Silently claiming it's covered
would be a real gap between what's designed and what's delivered.

### Expected effect on MFE and MAE — stated honestly

The reasoning chain is directionally sound: better-quality momentum-health
inputs → the Emergency Exit backstop is less likely to fire on noise
(fewer false positives cutting a real winner short) and less likely to
miss genuine deterioration that a single stale snapshot masked (fewer
false negatives letting a real loser run) → in principle this should
reduce MAE without harming MFE capture (since Free Ride Mode / TP2, which
is what actually captures large MFE, is untouched by this design).

**What this review will not do is claim a guaranteed improvement.** The
actual magnitude depends entirely on the eventual formula/threshold
calibration (explicitly out of scope for this document) and on real
production data. The honest claim is: the *mechanism* points the right
direction; the *size* of the effect is unproven until measured.

---

## Section 5 — Fake Pump Detection (architecture, in depth)

| Pattern | How it's architecturally distinguished |
|---|---|
| **Healthy momentum** | Price, buy pressure, holder count, and volume rise **together** across consecutive real polls; Realtime Flow Direction agrees across multiple independent signals; Realtime Momentum Consistency is high. |
| **Fake momentum (fake pump)** | Price rises without confirming buy pressure/holder/volume growth across the same polls — or the price move itself flips direction within a very short poll window (visible only as a poll-to-poll reversal, invisible to any single-snapshot check). |
| **Wash trading** | Detected primarily by the existing, unchanged real orderflow signals (bot/bundler/rat-trader/entrapment/fresh-wallet/insider-hold rates, holder-to-swap diversity, buy/sell balance clustering). Phase 2's contribution is only *when* these are trusted: a synthetic-looking pattern present on one poll and gone the next is architecturally distinguishable from one sustained across multiple polls. |
| **Coordinated/bot buying** | Bot-driven activity tends to be mechanically uniform poll-to-poll — the same shape repeating almost exactly. This is what Realtime Momentum Consistency is designed to expose from the *opposite* direction: a pattern that is *too* consistent, too mechanically regular, is itself suspicious — distinct from the natural variability of many independent real actors. |
| **Genuine accumulation** | Smart-money/KOL flow that is fresh, growing (velocity), accelerating, and consistent in direction across multiple real polls — evolving the existing static-total classification (Section 8/9 of the design doc) rather than replacing it. |

**Honest limitation, stated plainly:** this is a refinement of a
detection heuristic, not a defeat of adversarial behavior. A sufficiently
patient bad actor could in principle spread a wash pattern across multiple
polls instead of concentrating it in one tick, the same fundamental
limitation any window-based heuristic has today. Phase 2 raises the cost
of faking the pattern; it does not make faking it impossible. This should
not be oversold as a solved problem in reporting to the Solution
Architect.

---

## Section 6 — Realtime Signals (per-signal review)

**Blanket caveat that applies to every row below:** none of these signals
is faster than GMGN's own collector cadence. "Truly realtime" here means
"reflects the most recent real change GMGN has reported," not "sub-30s
live." Every signal inherits the same worst-case lag described in Section
1/7 when GMGN itself degrades.

| Signal | Strength | Weakness | Failure mode | Truly realtime? | Depends on delayed GMGN data? |
|---|---|---|---|---|---|
| Smart Money Velocity | Real improvement over a static total — sees emergence, not just presence | Depends entirely on `gmgn_activity_feed`'s own ~50-trade window being representative; a very high-activity token could churn that window fast enough to lose older-but-relevant context | Insufficient/no smart-money activity this tick → fails open to neutral (correct, by design) | Bounded by collector cadence | Yes, same as today's static version |
| KOL Velocity | Same as above, KOL side | Same as above | Same as above | Bounded by collector cadence | Yes |
| Buy Velocity | Captures acceleration a single-window total (`buys_5m`) cannot | Assumes GMGN's own `buys_5m`-equivalent field updates every real collector tick — **unverified assumption**, GMGN's own internal refresh cadence for this field is not independently confirmed | If GMGN only recomputes this field on its own slower internal schedule, poll-to-poll "delta" could read as zero even when real activity occurred — a false "no change" reading | Only as real-time as GMGN's own field refresh — needs verification before implementation | Yes, directly |
| Sell Velocity | Same as Buy Velocity | Same as Buy Velocity | Same as Buy Velocity | Same caveat | Yes |
| Buy Pressure | Already a proven, existing snapshot signal (`buyerPressureScore`) — Pulse only adds its trend | Low risk — this is the least novel signal in the set | Same fail-open convention as today | Bounded by collector cadence | Yes (already true today) |
| Sell Pressure | Same as Buy Pressure | Same | Same | Same | Yes |
| Net Buy Velocity | Directly targets the audit's own "old, slow-forming losers" finding | `net_buy_24h` is a 24h rolling figure on GMGN's side — a poll-to-poll delta of a 24h rolling number moves slowly by construction, so this signal may be inherently less "reactive" than its name implies | Could under-react to genuinely fast intraday shifts because the underlying field itself is a slow-moving rolling average | Bounded by collector cadence **and** by the underlying field's own 24h smoothing | Yes |
| Liquidity Velocity | Directly useful for catching "price up, liquidity draining" red flags | Liquidity can move sharply on a single large LP withdrawal — a 2-point (or even 3-point) delta may not distinguish "gradual drain" from "one big single-tick event" without more context | A single-tick liquidity shock could look identical in the buffer to a real sustained drain until the next poll disambiguates it | Bounded by collector cadence | Yes |
| Holder Velocity | Fills a genuine gap — no history for this field exists today at all | **Real unknown, not yet verified:** does GMGN refresh holder count every real collector tick, or on a slower internal cadence? If the latter, poll-to-poll deltas will frequently read as flat/zero for reasons unrelated to real holder-growth stalling | Same as Buy/Sell Velocity's GMGN-refresh-cadence risk, specifically flagged here because holder count is plausibly one of GMGN's slower-updating fields | Needs verification before implementation | Yes, directly, and specifically flagged as unverified |
| Volume Velocity | Already partially proven (`volumeTrendScore` already does a 2-point version of this for exits) | Low incremental risk — this is a generalization of an already-working pattern | Same fail-open convention | Bounded by collector cadence | Yes (already true today) |
| Momentum Acceleration | Genuinely new capability — no equivalent exists today | Needs 3 real, sufficiently-recent points — least available for the very freshest tokens (by design, see Section 2) | Fails open to neutral when history is insufficient (correct) | Bounded by collector cadence, and needs the full 3-point window to exist yet | Yes |
| Momentum Deceleration | Same as Acceleration, opposite direction — potentially the single most valuable new signal for the audit's "old, decaying losers" pattern | Same 3-point requirement | Same | Same | Yes |
| Realtime Flow Direction | Human-explainable single read across multiple modules — directly serves the explainability objective | Only as good as the individual signals it summarizes — inherits every weakness above | A summary of mostly-neutral inputs (insufficient history) should itself report neutral/unknown, not a confident-sounding default | Bounded by collector cadence | Yes, transitively |
| Realtime Momentum Consistency | Most powerful anti-fake-pump signal in the set (Section 5) | Requires the most real history among all the signals to mean anything (benefits most from — but per Section 2, should NOT require — more than 3 points) | Could be mistaken for "waiting for confirmation" if implemented as a gate rather than a score input — same Stage 5 risk from Section 3 | Bounded by collector cadence | Yes, transitively |

**Net finding for this section:** the two signals carrying the most
architectural uncertainty are **Buy/Sell Velocity and Holder Velocity**,
because they depend on an unverified assumption about GMGN's own internal
refresh cadence for those specific fields. This should be verified
empirically (log the raw field values across a few real ticks and check
whether they actually change tick-to-tick) before implementation, not
assumed.

---

## Section 7 — Performance Budget (concrete estimates)

These are engineering-cost estimates (memory/CPU/IO), not trading
formulas, weights, or thresholds — flagged explicitly so this section is
not mistaken for the kind of number this review is otherwise avoiding.

**Fresh-universe size — the key unknown input to every estimate below.**
The local smoke test during Phase 1 observed a total `gmgn_tokens` count
of ~12,500 but a `freshUniverseCount` of only 1 (a stale/inactive local
dev copy, not representative of live production trending volume). This
review does **not** have a confirmed real production figure and estimates
below use an assumed range of "a few hundred tokens" (consistent with
GMGN's own trending-list size class) — **this should be measured in
production before finalizing the performance budget**, not assumed.

**Memory (assuming ~300–500 fresh-universe tokens):**
- Per token: 3 buffered points × ~14 signals × 8 bytes (float) ≈ 340 bytes
  of raw numbers, plus JS object/Map overhead (realistically another
  300–500 bytes for a small object with ~14 numeric keys in V8).
- Estimated per-token cost: **~1–2 KB** including overhead.
- Total for 300–500 tokens: **well under 1 MB**, likely in the low
  hundreds of KB.
- **Conclusion: memory cost is negligible** relative to a Node process's
  normal baseline footprint (tens to hundreds of MB) — this is not a
  meaningful risk by itself, *provided eviction (Section 1) is actually
  implemented* — without eviction, this becomes an unbounded, if slow,
  leak instead of a fixed small cost.

**CPU:**
- Per-tick arithmetic: a few operations per signal × ~14 signals × a few
  hundred tokens = low thousands of floating-point operations — this is
  sub-millisecond of real CPU time; pure arithmetic is not the cost driver.
- The real cost driver is **object allocation and GC pressure** from
  creating a new record per token every ~30s, and **any synchronous DB
  write** in the same pass (see below).
- **Conclusion:** CPU cost is small in isolation, but see Section 3's
  "Stage 3" risk — the danger isn't the math, it's where in the event loop
  this work runs.

**Database:**
- The durable snapshot write should follow the exact pattern
  `tokenPriceHistoryRepository.insertMany` already uses — a single batched
  `db.transaction()` insert, not one statement per row. `better-sqlite3` is
  a synchronous native binding; batched inserts of a few hundred rows
  under this pattern are typically single-digit milliseconds, consistent
  with the cost the existing `token_price_history` write already pays
  every 30s today. **This is not a new class of DB cost — it's the same
  cost class as an existing, already-proven write, one more time per
  tick.**
- Read path: a fixed, indexed 3-row lookback per token — negligible.

**Polling / Network:** zero new GMGN calls, by design (Section 2 of the
design doc) — this is the one line item with no meaningful cost to
estimate.

**Expected additional latency per decision:**
- BUY loop: one additional in-memory/indexed-DB read per candidate — on
  the order of microseconds to low single-digit milliseconds, not a new
  synchronous dependency chain.
- Exit loop: same, per open position.

**Worst case:** bound by GMGN's own degradation (Section 1's observed
57.5s batch), not by anything in this design — Pulse's own worst-case
staleness cannot be worse than the collector tick's own worst case,
because Pulse is chained onto it. In that scenario, the *existing*
`STALE_MARKET_DATA` gate (120s ceiling, already in production) already
protects the overall pipeline before Pulse's contribution would even
matter.

**Average case:** the estimates above (sub-1MB memory, sub-millisecond
compute, single-digit-ms batched DB write, once per ~30s).

**Peak market case (broad rally, many tokens trending at once):** the
fresh-universe population grows, and cost scales roughly linearly with it
— but this is exactly the same scaling Research's own per-tick scoring
already has to absorb at a *faster* (15s) cadence. Pulse does not
introduce a new peak-load bottleneck distinct from the one Research
scoring already has to handle; it scales with the same input at a slower
cadence.

---

## Section 8 — Production Risk Review

| Risk | Mitigation |
|---|---|
| **Memory leak** | Not automatically prevented by the original design ("ages out" was vague). **Correction:** explicit eviction of buffer entries no longer in the fresh universe, on every computation pass. |
| **Scheduler starvation** | Real risk if Pulse computation runs synchronously inline and is slow. **Mitigation:** scope to fresh-universe size only, timebox (mirroring `scoringWorkerPool`'s existing 60s-timeout precedent), and prefer running it as a continuation *after* the collector tick's own lock releases rather than inside the critical path. |
| **Buffer growth** | Same as memory leak — solved by the same eviction step. |
| **Collector failure (single collector)** | Each signal must fail open **independently** per input (mirrors `intelligenceEngine.js`'s existing `hasData:false` convention) — a smart-money collector outage only neutralizes smart-money-derived signals, not price/liquidity-derived ones. |
| **Partial collector outage** | Same as above, plus the per-field freshness/coverage fact recommended in Section 1, so downstream consumers can tell "confirmed neutral" from "not yet known." |
| **GMGN API degradation** | Inherited, not introduced, by Phase 2 — the existing `STALE_MARKET_DATA` gate (120s) already protects the pipeline. Pulse should independently refuse a "confident" reading once its own underlying data exceeds the same existing age bound, reusing that number rather than inventing a second one. |
| **Restart recovery** | Cold buffer on boot (bounded, ~60–90s blind window at nominal cadence) — same class of cold-start every other in-memory cache in this codebase already has. Optional improvement: warm-start the buffer from the durable snapshot table's last few rows per token (Section 1). |
| **Stale buffers** | Per-point timestamps (Section 1) plus a max-age check on individual points, not just whole-token eviction — a "previous" point that's abnormally old due to a slow tick should be treated as stale, not blindly used. |
| **Duplicate polling** | Avoided by chaining Pulse onto the existing collector tick's completion rather than running it on its own independent timer — eliminates the class of bug where two independently-drifting timers double-count or skip a poll. |
| **Clock drift** | Single-process, single-machine, single wall clock — classic multi-node clock drift is not applicable here. Within-process timer jitter (event-loop lag under load, `setInterval` firing late) is real and is exactly why real per-point timestamps (not assumed fixed intervals) are required. |
| **Unexpected polling delay** | Same mitigation as clock drift and stale buffers — normalize every delta by actual elapsed time, and treat abnormally old points as stale rather than trusting a fixed-interval assumption. |

---

## Section 9 — Compatibility Review

- **Production V2 philosophy remains unchanged** — confirmed. The
  participant/market module split, `combineScore` renormalization,
  structural self-validation penalty, safety veto, and action-tier logic
  are untouched by anything in this design.
- **Realtime Pulse is additive** — confirmed, with one caveat: additivity
  is only guaranteed if Section 3's "Stage 5" architectural constraint
  (additive-only integration, no new pass/fail branch) is actually
  enforced at implementation time. The design's *intent* is additive; this
  review recommends making that a structural constraint, not a hope.
- **Research Engine remains authoritative** — confirmed by construction:
  Pulse only ever contributes to the same additive score `ageBonusPoints`
  already occupies; it cannot independently set the action tier.
- **Aggressive trading style remains intact** — conditionally confirmed;
  depends on Section 3/8's mitigations (fail-open behavior, additive-only
  integration, no inline event-loop blocking) actually being implemented
  as described, not just intended.
- **High trade frequency remains intact** — same conditional confirmation.
  The single biggest threat identified in this review to trade frequency
  is *not* Realtime Pulse itself, but pre-existing GMGN-degradation-driven
  `STALE_MARKET_DATA` rejection (Section 3, Stage 2) — a risk Phase 2
  inherits and does not worsen, but also does not solve.
- **Realtime decisions remain intact** — conditionally confirmed, with the
  explicit caveat from Section 4 that exit-side momentum *reaction speed*
  is not actually improved by this design (only momentum *read quality*
  is) unless the on-demand-Pulse-refresh improvement is adopted.
- **No unnecessary confirmation layers are introduced** — conditionally
  confirmed. This is true only if Stage 5 and Stage 7 (Section 3) are both
  implemented as score contributions, never as new "wait and see" gates.
  This is the single most important structural rule this review
  recommends carrying into implementation.

---

## MOST IMPORTANT — Philosophy Compliance Check

| Principle | Status | If at risk, what and why |
|---|---|---|
| Remain aggressive | **At risk if Stage 5/7 become gates** | See Section 3 — corrected by making both stages structurally additive-only. |
| Remain realtime | **At risk from two things** | (1) Inline synchronous Pulse computation blocking the event loop (Section 3/8) — corrected by scoping + timeboxing + running after tick-lock release. (2) Fixed-interval-assumed delta math when real GMGN cadence is irregular (Section 1) — corrected by real per-point timestamps and elapsed-time-normalized deltas. |
| Remain high-frequency | **At risk only transitively**, via the same Stage 5/7 and event-loop risks above — no independent new risk beyond those already identified. |
| Improve quality | **On track**, conditionally — the mechanism (richer, trend-aware signals replacing single-snapshot proxies) is sound; actual magnitude of improvement is unproven until real data and real formulas exist (explicitly out of this review's scope). |
| Never become conservative | **At risk if buffer size creeps** (Section 2) — corrected by keeping 3 points canonical and resisting scope creep toward 4/5 "for smoothing." |
| Never wait for perfect confirmation | **The most important single risk in this whole review.** Both Stage 5 (entry integration) and Stage 7 (synthetic filter evolution) could, if implemented carelessly, silently turn into "wait for N polls to agree" gates — which is precisely a confirmation-wait, dressed up as a "trend check." This must be treated as a hard architectural constraint at implementation time, not a matter of formula-tuning later. |
| Never become a lagging engine | **Bounded by GMGN itself, not by this design** — Section 1/7's central honest finding. This design cannot make Arjuna faster than its data source; it can only avoid adding *its own* delay on top of that floor, which the mitigations throughout this review are aimed at guaranteeing. |

### This review's concrete recommendations to carry into the (not-yet-started) implementation phase

1. Chain Pulse onto the existing collector tick's completion — never an
   independently-scheduled timer.
2. Store a real timestamp per buffered point; compute every delta against
   actual elapsed time, never an assumed fixed interval.
3. Explicitly evict buffer entries for tokens no longer in the fresh
   universe, every pass — do not rely on implicit "aging out."
4. Scope Pulse computation strictly to the fresh-universe population, and
   timebox it — never let it block the event loop unbounded.
5. Structurally constrain the entry-pipeline integration point (Stage 5)
   and the synthetic-filter evolution (Stage 7) to be additive-only —
   neither may become a new pass/fail branch, regardless of what formula
   is eventually chosen for either.
6. Verify empirically, before implementation, whether GMGN's own
   `holders`/buy-sell-count fields actually refresh every real collector
   tick — Buy/Sell/Holder Velocity's real-time character depends on this
   and it is currently an unverified assumption.
7. Consider (open question for the Solution Architect, not decided here):
   an on-demand Pulse refresh for held positions in profit-protection/
   near-emergency territory, mirroring the existing on-demand price
   refresh — without it, "react faster to momentum changes" is only
   partially delivered by this design.
8. Consider (also open): warm-starting the in-memory buffer from the
   durable snapshot table on process boot, to shrink the post-restart
   blind window.

---

*End of review. No code was written or modified to produce this document.*
