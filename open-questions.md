# Open Questions & Blockers

Newest first. Resolve or convert to a `decisions.md` entry when answered.

## 2026-06-20 — Cross-venue lead-lag: how do we actually USE it? (open)

The probe confirmed **Binance leads 01 by ≤100 ms** (ETH peak +100 ms corr 0.395,
HYPE +100 ms corr 0.326; full results in `docs/binance-crossvenue-plan.md` §3b).
Edge exists — but "Binance leads" ≠ "we can capture it". Open design questions:

1. **Reactive arbitrage vs. passive quote-ahead — which model?**
   Two ways to monetize the lead:
   - *Reactive (taker):* see a Binance move → fire an order at 01 before it catches
     up. Requires our **end-to-end reaction latency < the lead**.
   - *Passive (maker / follow-the-leader MM):* keep resting quotes on 01 skewed
     toward Binance's microprice, so we're *already* positioned when 01 converges —
     no race, we earn the spread + the drift. Extends `microprice-mm`.
   Leaning **passive** (see risk below), but undecided.

2. **What's our true reaction latency to 01?** Unmeasured. Need: Binance
   recv → our box → signal compute → order on 01's book → matched. On a
   Solana-based venue this is plausibly **tens–hundreds of ms**. Until measured we
   can't size the reactive opportunity.

3. **Which Binance signal?** microprice, OFI, short-horizon momentum, or basis vs
   01 `mark` funding? The probe only proved *price* lead-lag, not which feature is
   most predictive of the *next* 01 move.

4. **Does the edge survive costs?** 100 ms-return corr ~0.4 is a *statistical* lead,
   not a net-of-fees/slippage PnL. Needs a backtest through `src/sim/` with 01 fees,
   queue position, and adverse selection.

## 2026-06-20 — RISK: is a ~100 ms lead too small to arbitrage? (open, likely YES for reactive)

User's concern — and it's the right one: **a 100 ms lead (sub-100 ms for ETH) is
very tight for classic reactive cross-venue arbitrage.**

- To take the edge reactively, the whole chain (detect Binance tick → decide → land
  an order on 01 that fills) must complete **inside the lead window**. If our
  round-trip to 01 is ≥100 ms (likely), **the edge is gone before our order rests** —
  we'd be the one getting adversely selected, not capturing it.
- For **ETH specifically** the true lead is *sub-100 ms* (corr@0 0.392 ≈ corr@+100
  0.395), so reactive arb is almost certainly **not capturable** — treat ETH as
  passive-MM-only.
- **HYPE** has a cleaner, more concentrated +100 ms lead and a thinner 01 book →
  marginally more room, but the same latency test gates it.

**Implication / working stance:** assume the lead is **NOT directly arbitrageable
reactively**. Use it as a **passive signal** — bias resting quotes / inventory toward
the Binance leader so we collect the drift without racing. Reconsider reactive only
if measured 01 latency turns out well under the lead.

**To close this question:** (a) measure end-to-end latency to 01; (b) re-reduce the
probe at **20 ms grid** to pin the real lead horizon (the 100 ms grid is a resolution
floor); (c) compare lead horizon vs. measured latency. If lead < latency → passive only.
