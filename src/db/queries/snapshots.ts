import { sql, desc, eq } from "drizzle-orm";
import type { NodePgDatabase } from "drizzle-orm/node-postgres";
import * as schema from "../schema.js";
import { orderBookSnapshots } from "../schema.js";
import type { OrderBook, TokenId } from "../../events/types.js";

type Db = NodePgDatabase<typeof schema>;

export interface SnapshotRecord {
  tokenId: TokenId;
  conditionId: string;
  bids: Array<{ price: string; size: string }>;
  asks: Array<{ price: string; size: string }>;
  bidDepthUsdc?: number | null;
  askDepthUsdc?: number | null;
  imbalanceRatio?: number | null;
  mid?: number | null;
  spread?: number | null;
  bookHash?: string | null;
  snapshotTrigger?: string | null;
  capturedAt: Date;
}

export async function insertBookSnapshot(db: Db, snap: SnapshotRecord): Promise<void> {
  await db.execute(sql`
    INSERT INTO order_book_snapshots (
      token_id, condition_id, bids, asks,
      bid_depth_usdc, ask_depth_usdc, imbalance_ratio,
      mid, spread, book_hash, snapshot_trigger, captured_at
    ) VALUES (
      ${snap.tokenId}, ${snap.conditionId},
      ${JSON.stringify(snap.bids)}::jsonb, ${JSON.stringify(snap.asks)}::jsonb,
      ${snap.bidDepthUsdc?.toString() ?? null},
      ${snap.askDepthUsdc?.toString() ?? null},
      ${snap.imbalanceRatio?.toString() ?? null},
      ${snap.mid?.toString() ?? null},
      ${snap.spread?.toString() ?? null},
      ${snap.bookHash ?? null},
      ${snap.snapshotTrigger ?? "rest_timer"},
      ${snap.capturedAt.toISOString()}
    )
  `);
}

export async function getLatestBook(db: Db, tokenId: TokenId): Promise<SnapshotRecord | null> {
  const rows = await db
    .select()
    .from(orderBookSnapshots)
    .where(eq(orderBookSnapshots.tokenId, tokenId))
    .orderBy(desc(orderBookSnapshots.capturedAt))
    .limit(1);

  if (rows.length === 0) return null;
  const row = rows[0];
  return {
    tokenId: row.tokenId,
    conditionId: row.conditionId,
    bids: row.bids as Array<{ price: string; size: string }>,
    asks: row.asks as Array<{ price: string; size: string }>,
    bidDepthUsdc: row.bidDepthUsdc ? Number(row.bidDepthUsdc) : null,
    askDepthUsdc: row.askDepthUsdc ? Number(row.askDepthUsdc) : null,
    imbalanceRatio: row.imbalanceRatio ? Number(row.imbalanceRatio) : null,
    mid: row.mid ? Number(row.mid) : null,
    spread: row.spread ? Number(row.spread) : null,
    bookHash: row.bookHash ?? null,
    snapshotTrigger: row.snapshotTrigger ?? null,
    capturedAt: row.capturedAt,
  };
}
