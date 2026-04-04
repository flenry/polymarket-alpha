import { sql } from "drizzle-orm";
import { getDb, closeDb } from "../db/client.js";
import { config } from "../config.js";
import * as fs from "node:fs";
import * as path from "node:path";

interface LeaderboardRow extends Record<string, unknown> {
  proxy_wallet: string;
  total_volume_usdc: string | null;
  trade_count: number | null;
  win_count: number | null;
  win_ratio: string | null;
  resolved_trade_count: number | null;
  whale_trade_count: number | null;
}

interface LeaderboardEntry {
  rank: number;
  proxyWallet: string;
  totalVolumeUsdc: number;
  tradeCount: number;
  winCount: number;
  winRatio: number;
  resolvedTradeCount: number;
  whaleTrades: number;
}

function parseArg(argv: string[], flag: string, defaultVal: number): number {
  const prefix = `--${flag}=`;
  const arg = argv.find((a) => a.startsWith(prefix));
  if (!arg) return defaultVal;
  const raw = arg.slice(prefix.length);
  const n = parseInt(raw, 10);
  if (!Number.isFinite(n) || n <= 0) {
    console.error(`Error: --${flag} must be a positive integer, got: ${raw}`);
    process.exit(1);
  }
  return n;
}

function formatTable(entries: LeaderboardEntry[], minTrades: number, minVolume: number): string {
  const lines: string[] = [];
  const W = 84;
  const border = "═".repeat(W);
  lines.push(`╔${border}╗`);
  lines.push(`║  WHALE WALLET LEADERBOARD  (top ${entries.length} by win rate, min ${minTrades} trades, min $${minVolume.toLocaleString()} vol)${"".padStart(W - 70 - String(entries.length).length - String(minTrades).length - String(minVolume.toLocaleString()).length)}║`);
  lines.push(`╠${border}╣`);
  lines.push(`║  ${"Rank".padEnd(5)} ${"Wallet".padEnd(16)} ${"Vol (USDC)".padEnd(13)} ${"Trades".padEnd(7)} ${"Wins".padEnd(5)} ${"Win Rate".padEnd(9)} ${"Whale Trades".padEnd(12)} ║`);
  lines.push(`╠${border}╣`);
  lines.push(`║  # Source: wallet_profiles (enriched by WalletEnricher)${"".padStart(W - 55)}║`);
  lines.push(`╠${border}╣`);
  for (const e of entries) {
    const vol = `$${(e.totalVolumeUsdc).toLocaleString("en-US", { maximumFractionDigits: 0 })}`;
    const wr = `${(e.winRatio * 100).toFixed(1)}%`;
    const wallet = e.proxyWallet.length > 14
      ? `${e.proxyWallet.slice(0, 6)}…${e.proxyWallet.slice(-6)}`
      : e.proxyWallet;
    lines.push(`║  ${String(e.rank).padEnd(5)} ${wallet.padEnd(16)} ${vol.padEnd(13)} ${String(e.tradeCount).padEnd(7)} ${String(e.winCount).padEnd(5)} ${wr.padEnd(9)} ${String(e.whaleTrades).padEnd(12)} ║`);
  }
  lines.push(`╚${border}╝`);
  return lines.join("\n");
}

export async function runLeaderboard(opts: {
  minTrades?: number;
  minVolume?: number;
  topN?: number;
  json?: boolean;
  db?: ReturnType<typeof getDb>;
}): Promise<LeaderboardEntry[]> {
  const minTrades = opts.minTrades ?? config.leaderboardMinTrades;
  const minVolume = opts.minVolume ?? 10_000;
  const topN = opts.topN ?? config.leaderboardTopN;
  const db = opts.db ?? getDb();

  const rows = await db.execute<LeaderboardRow>(sql`
    SELECT
      proxy_wallet,
      total_volume_usdc,
      trade_count,
      win_count,
      win_ratio,
      resolved_trade_count,
      whale_trade_count
    FROM wallet_profiles
    WHERE trade_count >= ${minTrades}
      AND total_volume_usdc >= ${minVolume.toString()}
    ORDER BY win_ratio DESC NULLS LAST, total_volume_usdc DESC NULLS LAST
    LIMIT ${topN}
  `);

  const entries: LeaderboardEntry[] = (rows.rows as LeaderboardRow[]).map((r, i) => ({
    rank: i + 1,
    proxyWallet: r.proxy_wallet,
    totalVolumeUsdc: Number(r.total_volume_usdc ?? 0),
    tradeCount: r.trade_count ?? 0,
    winCount: r.win_count ?? 0,
    winRatio: Number(r.win_ratio ?? 0),
    resolvedTradeCount: r.resolved_trade_count ?? 0,
    whaleTrades: r.whale_trade_count ?? 0,
  }));

  return entries;
}

async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  const minTrades = parseArg(argv, "min-trades", config.leaderboardMinTrades);
  const minVolume = parseArg(argv, "min-volume", 10_000);
  const topN = parseArg(argv, "top", config.leaderboardTopN);
  const jsonFlag = argv.includes("--json");

  const db = getDb();

  try {
    const entries = await runLeaderboard({ minTrades, minVolume, topN, json: jsonFlag, db });

    // Write JSON to analytics-results/
    const dir = path.resolve("analytics-results");
    fs.mkdirSync(dir, { recursive: true });
    const filename = `leaderboard_${new Date().toISOString().replace(/[:.]/g, "-")}.json`;
    const outPath = path.join(dir, filename);
    const jsonData = JSON.stringify({ generatedAt: new Date().toISOString(), minTrades, minVolume, topN, entries }, null, 2);
    fs.writeFileSync(outPath, jsonData);

    if (jsonFlag) {
      process.stdout.write(jsonData + "\n");
    } else {
      console.log(formatTable(entries, minTrades, minVolume));
      console.log(`\nJSON saved to: ${outPath}`);
    }
  } finally {
    await closeDb();
  }
}

if (process.argv[1]?.endsWith("leaderboard.js") || process.argv[1]?.endsWith("leaderboard.ts")) {
  main().catch((err: unknown) => {
    console.error("Leaderboard failed:", err);
    process.exit(1);
  });
}
