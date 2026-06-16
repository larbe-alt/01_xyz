#!/usr/bin/env tsx
/**
 * VPS recorder health summary.
 * Usage:  npx tsx src/scripts/recorder/health.ts
 *         VPS_HOST=myserver npx tsx src/scripts/recorder/health.ts
 */
import { execSync } from "child_process";

const HOST = process.env.VPS_HOST ?? "tokyo";
const BN_GLOBAL = "/root/data/binance_futures";
const O1_MAINNET = "/root/01_xyz/data/mainnet";
const BN_LEGACY = "/root/perpl/data/binance_trades";

function ssh(script: string): string {
  const b64 = Buffer.from(script).toString("base64");
  try {
    return execSync(`ssh ${HOST} "echo ${b64} | base64 -d | bash"`, {
      encoding: "utf8",
      timeout: 25_000,
    }).trim();
  } catch (e: any) {
    return ((e.stdout as string) ?? "").trim();
  }
}

function sec(raw: string, name: string): string {
  const lines = raw.split("\n");
  const i = lines.indexOf(`===${name}===`);
  if (i === -1) return "";
  const j = lines.findIndex((l, idx) => idx > i && l.startsWith("===") && l.endsWith("==="));
  return lines.slice(i + 1, j === -1 ? undefined : j).join("\n").trim();
}

// Input: "{epoch_secs} {path}" from find -printf "%T@ %p"
function parseFind(line: string): { path: string; ageDesc: string } {
  const sp = line.indexOf(" ");
  if (sp === -1) return { path: line, ageDesc: "?" };
  const mtime = parseFloat(line.slice(0, sp)) * 1000;
  const path = line.slice(sp + 1);
  const ageMs = Date.now() - mtime;
  const ageMin = Math.round(ageMs / 60_000);
  const ageDesc =
    ageMin < 2 ? "just now" :
    ageMin < 90 ? `${ageMin}m ago` :
    ageMin < 60 * 48 ? `${Math.round(ageMin / 60)}h ago` :
    `${Math.floor(ageMin / 1440)}d ago`;
  return { path, ageDesc };
}

function row(label: string, value: string, w = 20): string {
  return `  ${label.padEnd(w)} ${value}`;
}

async function main() {
  const now = new Date().toISOString().slice(0, 16).replace("T", " ");
  process.stdout.write(`Querying ${HOST}...\n`);

  const raw = ssh(`
echo ===O1_PID===
pgrep -f "tsx.*record.ts" 2>/dev/null | head -1
echo ===O1_PS===
pid=$(pgrep -f "tsx.*record.ts" 2>/dev/null | head -1)
[ -n "$pid" ] && ps -p $pid -o etime= 2>/dev/null || echo ""
echo ===O1_LOG===
tail -12 /var/log/recorder01.log 2>/dev/null
echo ===O1_FRESH===
find ${O1_MAINNET} -name "*.parquet" -printf "%T@ %p\\n" 2>/dev/null | sort -n | tail -1
echo ===BN_PID===
pgrep -f "binance_main" 2>/dev/null | head -1
echo ===BN_FRESH===
find ${BN_GLOBAL} -name "*.parquet" -printf "%T@ %p\\n" 2>/dev/null | sort -n | tail -1
find ${BN_LEGACY} -maxdepth 2 -name "dt=*" -type d 2>/dev/null | sort | tail -1
echo ===SYS===
df -h /root | tail -1
free -m | grep ^Mem
echo ===END===
`);

  // ── parse ──
  const o1Pid    = sec(raw, "O1_PID");
  const o1Ps     = sec(raw, "O1_PS").trim();
  const o1Log    = sec(raw, "O1_LOG");
  const o1Fresh  = parseFind(sec(raw, "O1_FRESH").split("\n")[0] ?? "");
  const bnPid    = sec(raw, "BN_PID");
  const bnFreshL = sec(raw, "BN_FRESH").split("\n");
  const bnFresh  = parseFind(bnFreshL[0] ?? "");
  const bnLegacy = bnFreshL[1] ?? "";
  const sys      = sec(raw, "SYS");

  const is01Up = o1Pid.length > 0;
  const isBnUp = bnPid.length > 0;

  // extract writer stats map from 01_xyz log
  const statsMap = new Map<string, number>();
  for (const line of o1Log.split("\n")) {
    const m = line.match(/"key":"([^"]+)","records":(\d+)/);
    if (m) statsMap.set(m[1], parseInt(m[2]));
  }

  // parse sys
  const dp = sys.split("\n")[0]?.split(/\s+/) ?? [];
  const mp = sys.split("\n")[1]?.split(/\s+/) ?? [];

  // ── display ──
  const W = 72;
  const up = (ok: boolean) => ok ? "✅ RUNNING" : "❌ DOWN   ";
  const HR = "─".repeat(W);
  const HR2 = "═".repeat(W);

  console.log(`\n${HR2}`);
  console.log(`  VPS RECORDER HEALTH  ·  ${now} UTC`);
  console.log(`${HR2}\n`);

  // 01_xyz
  console.log(`01_xyz          [Node.js / 01 Exchange]          ${up(is01Up)}`);
  if (is01Up) console.log(row("uptime", o1Ps || "—"));
  if (statsMap.size > 0) {
    const STREAMS = ["trade", "delta", "mark", "candle", "snapshot"] as const;
    for (const sym of ["ETHUSD", "HYPEUSD"]) {
      const parts = STREAMS.map(s => {
        const n = statsMap.get(`${s}:${sym}`);
        return n != null ? `${s}:${n.toLocaleString()}` : null;
      }).filter(Boolean);
      if (parts.length) console.log(`  ${sym}  ${parts.join("  ")}`);
    }
  }
  if (o1Fresh.path) {
    const fname = o1Fresh.path.split("/").pop() ?? o1Fresh.path;
    console.log(row("newest file", `${fname}  (${o1Fresh.ageDesc})`));
  }

  console.log();

  // Binance
  const bnFreshDisplay = bnFresh.path
    ? `${bnFresh.path.split("/").slice(-3).join("/")}  (${bnFresh.ageDesc})`
    : bnLegacy
      ? `[legacy] ${bnLegacy}  — nothing in global dir yet`
      : "no data";
  console.log(`perpl/binance   [Python / Binance Futures]       ${up(isBnUp)}`);
  console.log(row("pairs", "BTCUSDT  ETHUSDT  HYPEUSDT"));
  console.log(row("data dir", BN_GLOBAL));
  console.log(row("newest data", bnFreshDisplay));
  if (!isBnUp) console.log("  ⚠ no process running");

  // System
  console.log(`\n${HR}`);
  const diskUsed = dp[2] ?? "?";
  const diskSize = dp[1] ?? "?";
  const diskPct  = dp[4] ?? "?";
  const memUsed  = mp[2] ?? "?";
  const memTotal = mp[1] ?? "?";
  console.log(`SYSTEM  disk: ${diskUsed}/${diskSize} (${diskPct})   mem: ${memUsed}M/${memTotal}M`);
  console.log(`${HR2}\n`);

  // Remediation hints
  if (!isBnUp) {
    console.log("── BINANCE RECORDER — restart command ──────────────────────────────");
    console.log(`  ssh ${HOST} 'cd /root/perpl && tmux new -d -s binance \\`);
    console.log(`    "/root/perpl/.venv/bin/python -m recorder.binance_main -c binance_config.yaml 2>&1 | tee -a /var/log/binance.log"'`);
    console.log();
  }
}

main().catch(err => {
  console.error("Fatal:", err.message);
  process.exit(1);
});
