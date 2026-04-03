import type { TypedEventBus } from "../events/bus.js";
import type { NodePgDatabase } from "drizzle-orm/node-postgres";
import * as schema from "../db/schema.js";
import { sql } from "drizzle-orm";
import { logger } from "../logger.js";
import { config } from "../config.js";

type Db = NodePgDatabase<typeof schema>;

interface PriceRecord {
  tokenId: string;
  conditionId: string;
  price: number;
  side?: string | null;
  eventType: string;
  recordedAt: Date;
}

export class PriceHistoryWriter {
  private batch: PriceRecord[] = [];
  private flushTimer: ReturnType<typeof setInterval> | null = null;

  constructor(
    private readonly bus: TypedEventBus,
    private readonly db: Db,
    private readonly batchSize = config.tradeBatchSize,
    private readonly flushMs = config.tradeBatchFlushMs
  ) {}

  start(): void {
    this.bus.on("last_trade_price", (evt) => {
      this.batch.push({
        tokenId: evt.tokenId,
        conditionId: "",
        price: evt.price,
        side: evt.side,
        eventType: "last_trade",
        recordedAt: new Date(evt.timestamp),
      });
      this.maybeFlush();
    });

    this.bus.on("best_bid_ask", (evt) => {
      // Two rows: best_bid and best_ask
      this.batch.push({
        tokenId: evt.tokenId,
        conditionId: "",
        price: evt.bid,
        side: "BUY",
        eventType: "best_bid",
        recordedAt: new Date(evt.timestamp ?? Date.now()),
      });
      this.batch.push({
        tokenId: evt.tokenId,
        conditionId: "",
        price: evt.ask,
        side: "SELL",
        eventType: "best_ask",
        recordedAt: new Date(evt.timestamp ?? Date.now()),
      });
      this.maybeFlush();
    });

    this.flushTimer = setInterval(() => {
      if (this.batch.length > 0) {
        this.flush().catch((err) =>
          logger.error({ err }, "PriceHistoryWriter: flush error")
        );
      }
    }, this.flushMs);
  }

  stop(): void {
    if (this.flushTimer) {
      clearInterval(this.flushTimer);
      this.flushTimer = null;
    }
  }

  private maybeFlush(): void {
    if (this.batch.length >= this.batchSize) {
      this.flush().catch((err) =>
        logger.error({ err }, "PriceHistoryWriter: flush error")
      );
    }
  }

  async flush(): Promise<number> {
    if (this.batch.length === 0) return 0;

    const records = this.batch.splice(0, this.batch.length);
    let count = 0;

    for (const r of records) {
      try {
        await this.db.execute(sql`
          INSERT INTO price_history (token_id, condition_id, price, side, event_type, recorded_at)
          VALUES (
            ${r.tokenId}, ${r.conditionId}, ${r.price.toString()},
            ${r.side ?? null}, ${r.eventType}, ${r.recordedAt.toISOString()}
          )
        `);
        count++;
      } catch (err) {
        logger.error({ err, tokenId: r.tokenId }, "PriceHistoryWriter: insert failed");
      }
    }

    return count;
  }

  getBatchSize(): number {
    return this.batch.length;
  }
}
