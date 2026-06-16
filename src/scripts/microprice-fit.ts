/**
 * Stoikov (2018) micro-price: IS fit + OOS validation.
 *
 * Reconstructs L1 from native01 snapshot+delta parquet data, builds Markov
 * transition matrices (Q, T, rk) on the IS window, solves for G* (the
 * micro-price adjustment over imbalance × spread states), then reports OOS
 * direction accuracy and Spearman IC vs mid and weighted-mid baselines.
 *
 * Usage:
 *   npm run microprice -- [--market ETHUSD] [--is-hours 5] [--dir data] [--env mainnet]
 */

import { OrderBook } from "../sim/book.js";
import { loadNative01Market } from "../sim/sources/native01.js";

// ── cli ──────────────────────────────────────────────────────────────────────

function flag(name: string): string | undefined {
  const i = process.argv.indexOf(name);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

const DIR    = flag("--dir")      ?? "data";
const ENV    = flag("--env")      ?? "mainnet";
const MARKET = flag("--market")   ?? "ETHUSD";
const IS_H   = Number(flag("--is-hours") ?? "5");
const N_I    = 10;   // imbalance bins  (uniform 0.0–1.0)
const N_S    = 4;    // spread bins     (quantile-cut from IS)
const NS     = N_I * N_S;
const EPS_DM = 1e-9; // threshold for "mid did not change"

// ── L1 reconstruction ────────────────────────────────────────────────────────

interface Tick {
  ts:       number;
  mid:      number;
  bidSize:  number;
  askSize:  number;
  spread:   number;
}

function buildTicks(events: Awaited<ReturnType<typeof loadNative01Market>>): Tick[] {
  const book = new OrderBook();
  const out: Tick[] = [];

  for (const ev of events) {
    if (ev.kind === "trade") continue;

    if (ev.kind === "snapshot") book.clear();
    for (const [p, s] of ev.bids) book.setLevel("bid", p, s);
    for (const [p, s] of ev.asks) book.setLevel("ask", p, s);

    const { bestBid, bestAsk } = book;
    if (bestBid === -Infinity || bestAsk === Infinity || bestBid >= bestAsk) continue;

    const bidSize = book.depthAt("bid", bestBid);
    const askSize = book.depthAt("ask", bestAsk);
    if (bidSize <= 0 || askSize <= 0) continue;

    out.push({
      ts:      ev.ts,
      mid:     (bestBid + bestAsk) / 2,
      bidSize,
      askSize,
      spread:  bestAsk - bestBid,
    });
  }
  return out;
}

// ── state indexing ────────────────────────────────────────────────────────────

function iBin(bidSize: number, askSize: number): number {
  const imb = bidSize / (bidSize + askSize);
  return Math.min(Math.floor(imb * N_I), N_I - 1);
}

function sBin(spread: number, thresh: number[]): number {
  for (let i = 0; i < thresh.length; i++) if (spread <= thresh[i]) return i;
  return thresh.length;
}

const stateOf = (i: number, s: number) => i * N_S + s;

// ── matrix math ───────────────────────────────────────────────────────────────

/**
 * Solve A·x = b via Gauss–Jordan with partial pivoting. Returns x.
 * If a pivot column is singular (<1e-14), leaves that variable at 0.
 */
function solve(A: Float64Array, b: Float64Array): Float64Array {
  const n = b.length;
  const M = new Float64Array(n * (n + 1));
  for (let i = 0; i < n; i++) {
    for (let j = 0; j < n; j++) M[i * (n + 1) + j] = A[i * n + j];
    M[i * (n + 1) + n] = b[i];
  }
  for (let col = 0; col < n; col++) {
    let piv = col;
    let best = Math.abs(M[col * (n + 1) + col]);
    for (let r = col + 1; r < n; r++) {
      const v = Math.abs(M[r * (n + 1) + col]);
      if (v > best) { best = v; piv = r; }
    }
    if (best < 1e-14) continue;
    if (piv !== col) {
      for (let j = 0; j <= n; j++) {
        const t = M[col * (n + 1) + j];
        M[col * (n + 1) + j] = M[piv * (n + 1) + j];
        M[piv * (n + 1) + j] = t;
      }
    }
    const pivot = M[col * (n + 1) + col];
    for (let r = 0; r < n; r++) {
      if (r === col) continue;
      const f = M[r * (n + 1) + col] / pivot;
      if (f === 0) continue;
      for (let j = col; j <= n; j++) M[r * (n + 1) + j] -= f * M[col * (n + 1) + j];
    }
  }
  const x = new Float64Array(n);
  for (let i = 0; i < n; i++) {
    const d = M[i * (n + 1) + i];
    x[i] = d === 0 ? 0 : M[i * (n + 1) + n] / d;
  }
  return x;
}

/** Solve A·X = B column-by-column; B is n×k row-major, returns X n×k row-major. */
function solveMulti(A: Float64Array, B: Float64Array, n: number, k: number): Float64Array {
  const X = new Float64Array(n * k);
  const col = new Float64Array(n);
  for (let c = 0; c < k; c++) {
    for (let i = 0; i < n; i++) col[i] = B[i * k + c];
    const xc = solve(A, col);
    for (let i = 0; i < n; i++) X[i * k + c] = xc[i];
  }
  return X;
}

/** Matrix × vector, n×n * n. */
function matVec(A: Float64Array, v: Float64Array, n: number): Float64Array {
  const out = new Float64Array(n);
  for (let i = 0; i < n; i++) {
    let s = 0;
    for (let j = 0; j < n; j++) s += A[i * n + j] * v[j];
    out[i] = s;
  }
  return out;
}

// ── Spearman IC ───────────────────────────────────────────────────────────────

function rankIC(pred: number[], label: number[]): number {
  const n = pred.length;
  if (n < 2) return 0;
  const rp = ranks(pred), rl = ranks(label);
  const mean = (n + 1) / 2;
  let cov = 0, vp = 0, vl = 0;
  for (let i = 0; i < n; i++) {
    const dp = rp[i] - mean, dl = rl[i] - mean;
    cov += dp * dl; vp += dp * dp; vl += dl * dl;
  }
  return vp === 0 || vl === 0 ? 0 : cov / Math.sqrt(vp * vl);
}

function ranks(a: number[]): number[] {
  const idx = a.map((v, i) => [v, i] as [number, number]).sort((x, y) => x[0] - y[0]);
  const r = new Array<number>(a.length);
  for (let i = 0; i < idx.length; i++) r[idx[i][1]] = i + 1;
  return r;
}

// ── main ──────────────────────────────────────────────────────────────────────

console.log(`\nMicro-price fit — ${MARKET}  IS=${IS_H}h`);
console.log(`Loading ${DIR}/${ENV}/${MARKET}…`);

const events = await loadNative01Market({ dir: DIR, env: ENV, market: MARKET });
console.log(`  ${events.length} raw events`);

const ticks = buildTicks(events);
console.log(`  ${ticks.length} valid L1 ticks`);

if (ticks.length < 200) {
  console.error("Too few ticks — check data directory");
  process.exit(1);
}

// ── IS / OOS split ────────────────────────────────────────────────────────────

const tsStart  = ticks[0].ts;
const tsCutoff = tsStart + IS_H * 3_600_000;
const IS  = ticks.filter(t => t.ts <  tsCutoff);
const OOS = ticks.filter(t => t.ts >= tsCutoff);

const isH   = (IS[IS.length - 1].ts  - IS[0].ts)  / 3_600_000;
const oosH  = OOS.length > 0 ? (OOS[OOS.length - 1].ts - OOS[0].ts) / 3_600_000 : 0;

console.log(`\nIS : ${IS.length.toLocaleString()} ticks  ${isH.toFixed(2)}h`);
console.log(`OOS: ${OOS.length.toLocaleString()} ticks  ${oosH.toFixed(2)}h`);

if (IS.length < 100) { console.error("IS too short"); process.exit(1); }

// ── spread quantile thresholds from IS ───────────────────────────────────────

const isSpreads = IS.map(t => t.spread).sort((a, b) => a - b);
const spreadThresh: number[] = [];
for (let i = 1; i < N_S; i++)
  spreadThresh.push(isSpreads[Math.floor(isSpreads.length * i / N_S)]);

console.log(`\nSpread bins (IS quantiles): 0–${spreadThresh.map(v => v.toFixed(4)).join(" | ")}–∞`);

// ── build transition counts from IS ──────────────────────────────────────────
//
// For each consecutive pair (t, t+1):
//   x  = state at t,  y = state at t+1
//   dM = mid_{t+1} - mid_t
//
// Q[x][y]  = P(dM ≈ 0  AND next state = y | state = x)   [transient]
// T[x][y]  = P(dM ≠ 0  AND next state = y | state = x)   [absorbing]
// rk[x]    = E[dM at next event | state = x]              (used to build G1)
//
// Symmetrize every observation with its mirror (1-I, S, -(dM)) to guarantee
// the stationary distribution ⊥ G1 → Theorem 3.1 convergence condition.

const Q_cnt   = new Float64Array(NS * NS);
const T_cnt   = new Float64Array(NS * NS);
const rk_sum  = new Float64Array(NS);
const cnt_tot = new Float64Array(NS);

function addObs(xi: number, xs: number, yi: number, ys: number, dM: number) {
  const x = stateOf(xi, xs), y = stateOf(yi, ys);
  cnt_tot[x]++;
  rk_sum[x] += dM;
  if (Math.abs(dM) < EPS_DM) Q_cnt[x * NS + y]++;
  else                         T_cnt[x * NS + y]++;
}

for (let k = 0; k < IS.length - 1; k++) {
  const cur  = IS[k];
  const nxt  = IS[k + 1];
  const dM   = nxt.mid - cur.mid;
  const xi   = iBin(cur.bidSize, cur.askSize);
  const xs   = sBin(cur.spread, spreadThresh);
  const yi   = iBin(nxt.bidSize, nxt.askSize);
  const ys   = sBin(nxt.spread, spreadThresh);

  addObs(xi, xs, yi, ys,  dM);
  addObs(N_I - 1 - xi, xs, N_I - 1 - yi, ys, -dM); // mirror
}

// ── normalize ─────────────────────────────────────────────────────────────────

const Q  = new Float64Array(NS * NS);
const T  = new Float64Array(NS * NS);
const rk = new Float64Array(NS);

for (let x = 0; x < NS; x++) {
  const tot = cnt_tot[x];
  if (tot === 0) continue;
  rk[x] = rk_sum[x] / tot;
  for (let y = 0; y < NS; y++) {
    Q[x * NS + y] = Q_cnt[x * NS + y] / tot;
    T[x * NS + y] = T_cnt[x * NS + y] / tot;
  }
}

// ── solve for G* ─────────────────────────────────────────────────────────────
//
// G1    = (I-Q)^{-1} · rk           [expected first mid-change starting from x]
// B     = (I-Q)^{-1} · T            [state distribution after first mid-change]
// G*    = (I-B)^{-1} · G1           [limit: micro-price adjustment]

const IminusQ = new Float64Array(NS * NS);
for (let i = 0; i < NS; i++) {
  for (let j = 0; j < NS; j++)
    IminusQ[i * NS + j] = (i === j ? 1 : 0) - Q[i * NS + j];
}

const G1   = solve(IminusQ, rk);
const B    = solveMulti(IminusQ, T, NS, NS);

const IminusB = new Float64Array(NS * NS);
for (let i = 0; i < NS; i++) {
  for (let j = 0; j < NS; j++)
    IminusB[i * NS + j] = (i === j ? 1 : 0) - B[i * NS + j];
}

const Gstar = solve(IminusB, G1);

// verify convergence: iterate B^k · G1 and check last increment is tiny
let Bk = G1.slice();
let residual = 0;
for (let iter = 0; iter < 200; iter++) {
  Bk = matVec(B, Bk, NS);
  residual = Math.max(...Bk.map(Math.abs));
  if (residual < 1e-12) break;
}
const converged = residual < 1e-8;

// ── print G* table ────────────────────────────────────────────────────────────

const iBinLabels = Array.from({ length: N_I }, (_, i) => `${((i + 0.5) / N_I).toFixed(2)}`);
const sBinLabels = [
  `≤${spreadThresh[0]?.toFixed(3) ?? "?"}`,
  ...spreadThresh.slice(1).map((v, i) => `${spreadThresh[i].toFixed(3)}–${v.toFixed(3)}`),
  `>${spreadThresh[spreadThresh.length - 1]?.toFixed(3) ?? "?"}`,
];

console.log(`\n── G* = P_micro − mid  (${converged ? "converged" : "WARNING: did not converge"}) ──`);
const hdr = "            " + iBinLabels.map(l => l.padStart(8)).join("");
console.log(hdr);
for (let s = 0; s < N_S; s++) {
  const row = sBinLabels[s].padEnd(12) +
    Array.from({ length: N_I }, (_, i) => Gstar[stateOf(i, s)].toFixed(4).padStart(8)).join("");
  console.log(row);
}

// sanity: G*[I=0.95, s=0] should be positive (buy pressure → micro > mid)
//         G*[I=0.05, s=0] should be negative
const g_high = Gstar[stateOf(N_I - 1, 0)];
const g_low  = Gstar[stateOf(0, 0)];
console.log(`\nSanity: G*[I≈1.0, tight] = ${g_high.toFixed(5)}  (expect > 0)`);
console.log(`        G*[I≈0.0, tight] = ${g_low.toFixed(5)}  (expect < 0)`);

// ── OOS evaluation ────────────────────────────────────────────────────────────

if (OOS.length < 10) {
  console.log("\nOOS window too short for evaluation.");
  process.exit(0);
}

let nDirTotal = 0, nDirMicro = 0, nDirWmp = 0;
const predMicro: number[] = [];
const predWmp:   number[] = [];
const labelsAll: number[] = [];  // next tick dM
const labelsChg: number[] = [];  // dM at next actual mid change
const predMicroChg: number[] = [];
const predWmpChg:   number[] = [];

// precompute "next mid change" label for each OOS tick
const nextChg = new Float64Array(OOS.length).fill(NaN);
for (let i = OOS.length - 2; i >= 0; i--) {
  const dm = OOS[i + 1].mid - OOS[i].mid;
  if (Math.abs(dm) >= EPS_DM) {
    nextChg[i] = dm;
  } else {
    nextChg[i] = nextChg[i + 1]; // inherit nearest future change
  }
}

for (let i = 0; i < OOS.length - 1; i++) {
  const t   = OOS[i];
  const dM  = OOS[i + 1].mid - t.mid;
  const imb = t.bidSize / (t.bidSize + t.askSize);
  const xi  = iBin(t.bidSize, t.askSize);
  const xs  = sBin(t.spread, spreadThresh);
  const gAdj  = Gstar[stateOf(xi, xs)];
  const wAdj  = (imb - 0.5) * t.spread; // WMP − mid = (I − 0.5) · S

  predMicro.push(gAdj);
  predWmp.push(wAdj);
  labelsAll.push(dM);

  if (Math.abs(dM) >= EPS_DM) {
    nDirTotal++;
    if (Math.sign(gAdj) === Math.sign(dM)) nDirMicro++;
    if (Math.sign(wAdj)  === Math.sign(dM)) nDirWmp++;
  }

  const nc = nextChg[i];
  if (!isNaN(nc)) {
    predMicroChg.push(gAdj);
    predWmpChg.push(wAdj);
    labelsChg.push(nc);
  }
}

const icMicroAll = rankIC(predMicro, labelsAll);
const icWmpAll   = rankIC(predWmp,   labelsAll);
const icMicroChg = rankIC(predMicroChg, labelsChg);
const icWmpChg   = rankIC(predWmpChg,   labelsChg);
const dirMicro   = nDirTotal > 0 ? (nDirMicro / nDirTotal * 100) : NaN;
const dirWmp     = nDirTotal > 0 ? (nDirWmp   / nDirTotal * 100) : NaN;

console.log(`\n── OOS results  (${OOS.length.toLocaleString()} ticks, ${nDirTotal.toLocaleString()} mid-change events) ──`);
console.log("");
console.log("Direction accuracy at mid-change events:");
console.log(`  Micro-price : ${dirMicro.toFixed(1)}%`);
console.log(`  WMP         : ${dirWmp.toFixed(1)}%`);
console.log(`  Mid (base)  : 50.0%`);
console.log("");
console.log("Spearman IC vs next-tick dM (all OOS ticks):");
console.log(`  Micro-price : ${icMicroAll.toFixed(4)}`);
console.log(`  WMP         : ${icWmpAll.toFixed(4)}`);
console.log(`  Mid (base)  : 0.0000`);
console.log("");
console.log("Spearman IC vs next mid-change (only change events):");
console.log(`  Micro-price : ${icMicroChg.toFixed(4)}`);
console.log(`  WMP         : ${icWmpChg.toFixed(4)}`);
console.log(`  Mid (base)  : 0.0000`);
