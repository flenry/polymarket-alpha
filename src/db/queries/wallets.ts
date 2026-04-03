import { sql, eq } from "drizzle-orm";
import type { NodePgDatabase } from "drizzle-orm/node-postgres";
import * as schema from "../schema.js";
import { walletProfiles } from "../schema.js";

type Db = NodePgDatabase<typeof schema>;

export interface WalletProfileInput {
  proxyWallet: string;
  totalVolumeUsdc: number;
  tradeCount: number;
  whaleTradeCount: number;
  firstSeenAt: Date;
  lastSeenAt: Date;
}

export async function upsertWalletProfile(db: Db, profile: WalletProfileInput): Promise<void> {
  await db
    .insert(walletProfiles)
    .values({
      proxyWallet: profile.proxyWallet,
      totalVolumeUsdc: profile.totalVolumeUsdc.toString(),
      tradeCount: profile.tradeCount,
      whaleTradeCount: profile.whaleTradeCount,
      firstSeenAt: profile.firstSeenAt,
      lastSeenAt: profile.lastSeenAt,
      lastEnrichedAt: new Date(),
    })
    .onConflictDoUpdate({
      target: walletProfiles.proxyWallet,
      set: {
        totalVolumeUsdc: profile.totalVolumeUsdc.toString(),
        tradeCount: profile.tradeCount,
        whaleTradeCount: profile.whaleTradeCount,
        firstSeenAt: profile.firstSeenAt,
        lastSeenAt: profile.lastSeenAt,
        lastEnrichedAt: new Date(),
      },
    });
}

export interface WalletProfileRow {
  proxyWallet: string;
  totalVolumeUsdc: number | null;
  tradeCount: number | null;
  whaleTradeCount: number | null;
  firstSeenAt: Date | null;
  lastSeenAt: Date | null;
  lastEnrichedAt: Date | null;
}

export async function getWalletProfile(db: Db, proxyWallet: string): Promise<WalletProfileRow | null> {
  const rows = await db
    .select()
    .from(walletProfiles)
    .where(eq(walletProfiles.proxyWallet, proxyWallet))
    .limit(1);

  if (rows.length === 0) return null;
  const row = rows[0];
  return {
    proxyWallet: row.proxyWallet,
    totalVolumeUsdc: row.totalVolumeUsdc ? Number(row.totalVolumeUsdc) : null,
    tradeCount: row.tradeCount,
    whaleTradeCount: row.whaleTradeCount,
    firstSeenAt: row.firstSeenAt,
    lastSeenAt: row.lastSeenAt,
    lastEnrichedAt: row.lastEnrichedAt,
  };
}
