# CRAB Intelligence Engine

CRAB is a **market participant intelligence platform**, not a chart-analysis
tool. This document is the philosophy and architecture reference for
`src/services/intelligenceEngine.js` and everything under
`src/services/intelligence/`.

## 1. Final Architecture

```
intelligenceEngine.js (orchestrator)
├── gathers real data ONCE per token, via repositories only:
│   gmgn_tokens, gmgn_trenches, gmgn_activity_feed (kol + smart_money),
│   gmgn_hot_searches, gmgn_launchpad_stats, gmgn_ondemand_cache
│
├── intelligence/participant/  (PRIMARY - drives BUY/HOLD/AVOID)
│   ├── accumulation.js        net_buy_24h direction (gmgn_trenches)
│   ├── smartMoney.js          real smart-money trade feed for this token
│   ├── kol.js                 real KOL trade feed for this token
│   ├── whale.js                smart/degen wallet concentration
│   ├── developer.js           creator track record
│   ├── sniper.js              inverse: sniper-bot concentration
│   ├── bundle.js               inverse: coordinated/bundled trading
│   ├── insider.js              inverse: suspected-insider hold rate
│   ├── walletQuality.js       cached wallet_stats for involved makers
│   └── walletProfitability.js cached wallet_stats PNL/winrate
│
├── intelligence/market/       (CONFIRMS/ADJUSTS - never primary)
│   ├── liquidity.js
│   ├── security.js
│   ├── holderDistribution.js
│   ├── volume.js
│   └── priceStability.js
│
└── config/scoringConfig.js    every weight, threshold, and curve -
                                no scorer hardcodes a number
```

Every module returns `{ score, max, hasData, reasons|confirmations, riskReasons }`.
`hasData:false` means the real underlying data doesn't exist yet - the module
still returns a neutral (never zero, never full-marks) score and contributes
**no** reason string. Nothing is ever fabricated, estimated, or simulated.

This module never triggers a live GMGN call itself - it only reads what
collectors have already written to SQLite, so analyzing a token stays fast
(~70ms for 50 tokens, each running all 15 sub-modules).

## 2. Participant Scoring Philosophy

Participant Score answers: *who is accumulating, distributing, entering,
exiting - and are they credible?* It is the **primary and only driver** of
the BUY/HOLD/AVOID action tier (`scoreToAction()` reads Participant Score
alone; Market Health cannot raise the tier, only a hard safety veto can
lower it - see §4).

**Combination is a renormalized average, not a flat sum.** This was a real
bug found during live-data validation: summing all 10 categories with
missing ones defaulting to a neutral floor meant 60% of the weight
(accumulation/whale/developer/sniper/bundle/insider - everything gated on
`gmgn_trenches`, which only covers ~90 tokens at a time) was permanently
stuck near-neutral for any token outside that narrow window, capping the
achievable score around 60 regardless of how strong its real smart-money
signal was. Fixed by renormalizing across whatever categories genuinely
have data, so the score reflects what's actually known - with the resulting
lower data completeness handled separately, in confidence (§4), never by
silently suppressing the score.

**Volume significance gate.** Also found live: a 3-trade, $55, "100% buy"
sample scored identically to a $50,000 one, because the direction ratio
(buys vs. sells) was the only thing checked. `smartMoney.js`, `kol.js`, and
`accumulation.js` now blend the direction score toward neutral in proportion
to how far short of a minimum USD threshold the sample is
(`config.participant.minSignificantVolumeUsd`), and the generated reason
text is honest about it ("...but sample is small ($55 ... below the $300
significance threshold)"). A token with a real, large accumulation signal
still scores fully; a token with statistical noise no longer looks
identical to one.

**Earliness discount (the core "prefer early over late" mechanism).**
`accumulation.js`, `smartMoney.js`, and `kol.js` are timing-sensitive: their
direction score is multiplied by `config.participant.earlinessCurve`, keyed
on `price_change_1h`. Real buying detected while a token is still flat
(≤10% in 1h) gets full credit; the identical buying pattern after the token
has already run 300%+ is discounted to 10% credit, because it is far more
likely to be late FOMO than genuine early conviction. This is deliberately
NOT applied to composition signals (whale/developer/sniper/bundle/insider/
walletQuality) - those are about **who** is involved, not **when**, so a
legitimate smart wallet is still a legitimate smart wallet regardless of
recent price action.

**Verified against live data:** a token with a real $709 smart-money buy
signal at -41% (i.e. hasn't pumped) scored STRONG BUY; the same "activity
detected" signal on tokens already up 468-1294% scored AVOID/HOLD despite
superficially similar raw activity - because the earliness discount and the
security/stability risk flags both independently penalized the late-stage
tokens.

## 3. Market Health Philosophy

Market Health answers: *do current market conditions actually support the
participant signal, or work against it?* It never drives the action tier by
itself - `config.market` weights (liquidity 30, security 30, holder
distribution 15, volume 10, price stability 15) only feed into confidence
and risk (§4/§5), plus one hard exception: **the safety veto**
(`applySafetyVeto()`), which can force AVOID regardless of Participant Score
on a honeypot flag, critical illiquidity (<$2,000), critically thin backing
(<1% liquidity/valuation), or too few holders (<15). This is the one and
only way market data overrides the participant-driven action, and it can
only ever push toward AVOID, never toward BUY - directly implementing "do
NOT generate BUY simply because market conditions look healthy."

`priceStability.js` is Market Health's own counterpart to the participant
earliness curve: a token that has already moved a lot is scored as less
"stable" (more reversal risk) regardless of direction, via
`config.market.priceStabilityCurve`. This independently reinforces the
early-over-late philosophy from a volatility-risk angle, on top of (not
instead of) the participant-side discount.

## 4. Confidence Calculation

```
blended = 100 * (0.6 * participantPct + 0.4 * marketPct)
mismatchPenalty = |participantPct - marketPct| * 100 * 0.15
completenessPenalty = (1 - realDataFraction) * 25   // realDataFraction = hasData modules / 15 total
confidence = clamp(blended - mismatchPenalty - completenessPenalty, 15, 99)
```

Three independent forces, matching the brief's examples:
- **Participant 95 / Market 90** → both high, no mismatch, high completeness → confidence very high.
- **Participant 90 / Market 35** → action stays BUY-tier (participant-driven), but the mismatch penalty pulls confidence down meaningfully - "may still be BUY, but risk increases" is realized as lower confidence + (separately) more risk flags from the weak Market Health.
- **Participant 25 / Market 95** → action never reaches BUY at all, because action is computed from Participant Score alone (§2) - market health being excellent is structurally incapable of overriding that.

Confidence is capped at 99 (never 100 - CRAB never claims certainty) and
floored at 15 (a signal that fails everything still gets *some* confidence
number, since "0% confidence" reads as an error state, not a real low-
confidence AVOID).

## 5. Risk Calculation

Risk is a count of real risk-reason strings raised by **any** module (both
systems contribute), plus hard triggers (safety veto fired, or
`price_change_1h >= 500%`):

- 0 risk reasons, no hard trigger → LOW
- ≥1 → MEDIUM
- ≥4, or any hard trigger → HIGH

Risk and confidence are independent axes on purpose: a token can be
"BUY, low confidence, low risk" (weak/sparse data but nothing alarming) or
"BUY, moderate confidence, high risk" (strong participant signal, but real
red flags present) - collapsing them into one number would hide exactly the
distinction the brief asked for ("risk should increase significantly" while
action stays BUY).

## 6. Reasons Generation

Two separate arrays, enforced at the type level (participant modules return
`reasons`, market modules return `confirmations` - it is not possible to
accidentally put a market observation in the reasons list):

- **`reasons`** - participant-driven, the actual "why" (e.g. "Smart money
  accumulation detected ($709 bought vs $468 sold recently)"). Only
  generated from real `hasData:true` modules; a module with no data
  contributes zero reason strings, never a placeholder.
- **`confirmations`** - market-driven, phrased as support, never as a
  primary cause (e.g. "Liquidity confirms accumulation" - it *confirms*,
  per the brief's explicit example, it is not listed as a reason).
- **`riskReasons`** - from both systems, always phrased as a concrete
  concern with the real number attached (e.g. "Price has already moved
  sharply (1294% in 1h) - elevated reversal risk").

If `reasons` ends up empty (no participant module found anything to say),
the engine states that plainly - `"No strong participant signal detected
yet"` - rather than either fabricating a reason or leaving the array empty
and unexplained.

## 7. Remaining Limitations Caused by Unavailable Data

- **`gmgn_trenches` coverage is narrow** (~90 rows, refreshed every cycle)
  and only covers Solana `new_creation`/`near_completion`/`completed`
  launches - most tokens in `gmgn_tokens` (found via the broader
  `market/rank` trending endpoint) never appear there. Six of ten
  participant categories (accumulation, whale, developer, sniper, bundle,
  insider) depend on it; for tokens outside that window they're honestly
  `hasData:false`, not degraded guesses - but it does mean the engine's
  richest participant signal is only available for a minority of tracked
  tokens today.
- **`walletQuality`/`walletProfitability` are real but structurally sparse.**
  They only have data when a maker wallet's `wallet_stats` happens to
  already be cached from a prior on-demand lookup (`GET
  /v1/gmgn/wallet/:address/stats`) - there is no systematic background
  collector populating this for every wallet seen in the activity feed.
  The modules are fully functional (verified live), just rarely triggered
  today.
- **The activity feed is a small rolling sample** (~50 most recent trades
  system-wide per feed type), not exhaustive per-token history. An empty
  match means "not in our recent sample," which the engine treats as
  `hasData:false` - correct, but it means real accumulation happening
  slightly outside that recent window is invisible to the engine.
- **No systematic on-chain holder-quality data.** `holderDistribution.js`
  only has real concentration data (`top_10_holder_rate`) when the token is
  also in trenches; otherwise it only knows the raw holder *count*.
  "Holder Quality" (a participant-side concept, per the brief) is not a
  separate module - it's approximated via `whale.js`'s smart/degen wallet
  count, since there is no other real per-holder data source today. This
  is a conscious consolidation, not an oversight - a literally separate
  `holderQuality.js` would have had no real data source beyond what
  `whale.js` already captures.
- **The earliness curve and priceStability curve breakpoints are
  first-pass estimates**, not tuned against historical outcome data (there
  is no historical price-after-signal dataset yet to calibrate against).
  They are fully configurable in `scoringConfig.js` for exactly this reason.
- **`launchpad` platform names don't reliably cross-reference.**
  `/v1/trenches` returns human-readable names ("Pump.fun") while
  `/v1/cooking/statistics` returns lowercase slugs ("pump") - without a
  confirmed mapping table for all 9 platforms, `totalTokensOnPlatform`
  honestly returns `null` on a naming mismatch rather than guessing.

## 8. Suggestions for Future Improvements

- Add a scheduled collector for `wallet_stats` on every unique maker
  address seen in the KOL/smart-money activity feed, so
  `walletQuality`/`walletProfitability` stop depending on incidental
  on-demand cache hits and become systematically populated.
- Widen (or add a second, separate) trenches-style collector pass to cover
  more of the `gmgn_tokens` population, so participant categories that
  currently depend on trenches aren't structurally unavailable for most
  tracked tokens.
- Once real outcome data exists (token price N hours after a given
  signal), retune `earlinessCurve`, `priceStabilityCurve`, and the tier
  boundaries in `scoringConfig.js` against actual results instead of
  first-pass estimates.
- Build a real (not string-matched) launchpad name-normalization table once
  more real examples across all 9 platforms are observed.
- Consider a dedicated `holderQuality.js` if a real per-holder wallet-tag
  data source becomes available (e.g. systematically fetching
  `token_top_holders` and cross-referencing each holder's own
  `wallet_stats`) - currently no such systematic source exists.
