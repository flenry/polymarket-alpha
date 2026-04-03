import { EventEmitter } from "node:events";
import WebSocket from "ws";
import type { NodePgDatabase } from "drizzle-orm/node-postgres";
import * as schema from "../db/schema.js";
import type { TokenId, OrderBook, BookUpdateEvent, PriceChangeEvent, BestBidAskEvent, LastTradePriceEvent } from "../events/types.js";
import { ZClobBookEvent, ZClobPriceChangeEvent, ZClobBestBidAskEvent, ZClobLastTradePriceEvent } from "../validation/schemas.js";
import { markMarketClosed } from "../db/queries/markets.js";
import { logger } from "../logger.js";

type Db = NodePgDatabase<typeof schema>;

const KEEPALIVE_INTERVAL_MS = 50_000;
const SILENT_SHARD_THRESHOLD_MS = 60_000;

const DEFAULT_CLOB_WS_URL = "wss://ws-subscriptions-clob.polymarket.com/ws/market";

export interface ClobWsPoolOptions {
  url?: string;
  shardSize?: number;
  reconnectBaseMs?: number;
  reconnectMaxMs?: number;
  WsConstructor?: typeof WebSocket;
  silentShardThresholdMs?: number;
  db?: Db;
}

interface Shard {
  index: number;
  tokenIds: TokenId[];
  ws: WebSocket | null;
  reconnectDelay: number;
  lastEventTs: number;
  stopped: boolean;
  keepaliveTimer: ReturnType<typeof setInterval> | null;
  reconnectTimer: ReturnType<typeof setTimeout> | null;
}

export class ClobWsPool extends EventEmitter {
  private readonly url: string;
  private readonly shardSize: number;
  private readonly reconnectBaseMs: number;
  private readonly reconnectMaxMs: number;
  private readonly WsConstructor: typeof WebSocket;
  private readonly silentThresholdMs: number;
  private readonly db: Db | undefined;
  private shards: Shard[] = [];
  private stopped = false;

  constructor(opts: ClobWsPoolOptions = {}) {
    super();
    this.url = opts.url ?? DEFAULT_CLOB_WS_URL;
    this.shardSize = opts.shardSize ?? 150;
    this.reconnectBaseMs = opts.reconnectBaseMs ?? 1_000;
    this.reconnectMaxMs = opts.reconnectMaxMs ?? 30_000;
    this.WsConstructor = opts.WsConstructor ?? WebSocket;
    this.silentThresholdMs = opts.silentShardThresholdMs ?? SILENT_SHARD_THRESHOLD_MS;
    this.db = opts.db;
  }

  async connect(tokenIds: TokenId[]): Promise<void> {
    this.stopped = false;
    const chunks = this.chunk(tokenIds, this.shardSize);
    for (let i = 0; i < chunks.length; i++) {
      const shard = this.createShard(i, chunks[i]);
      this.shards.push(shard);
      this.openShard(shard);
    }
  }

  async addTokenIds(newIds: TokenId[]): Promise<void> {
    for (const id of newIds) {
      // Find an existing shard with room
      const shard = this.shards.find((s) => s.tokenIds.length < this.shardSize);
      if (shard) {
        shard.tokenIds.push(id);
        // Re-subscribe shard with updated token list (if connected)
        if (shard.ws?.readyState === WebSocket.OPEN) {
          this.subscribe(shard);
        }
      } else {
        // Open new shard
        const newIndex = this.shards.length;
        const newShard = this.createShard(newIndex, [id]);
        this.shards.push(newShard);
        this.openShard(newShard);
      }
    }
  }

  disconnect(): void {
    this.stopped = true;
    for (const shard of this.shards) {
      shard.stopped = true;
      if (shard.keepaliveTimer) {
        clearInterval(shard.keepaliveTimer);
        shard.keepaliveTimer = null;
      }
      if (shard.reconnectTimer) {
        clearTimeout(shard.reconnectTimer);
        shard.reconnectTimer = null;
      }
      shard.ws?.close();
      shard.ws = null;
    }
    this.shards = [];
  }

  getShardCount(): number {
    return this.shards.length;
  }

  private createShard(index: number, tokenIds: TokenId[]): Shard {
    return {
      index,
      tokenIds: [...tokenIds],
      ws: null,
      reconnectDelay: this.reconnectBaseMs,
      lastEventTs: Date.now(),
      stopped: false,
      keepaliveTimer: null,
      reconnectTimer: null,
    };
  }

  private openShard(shard: Shard): void {
    const ws = new this.WsConstructor(this.url);
    shard.ws = ws;

    ws.on("open", () => {
      logger.info({ shardIndex: shard.index, tokenCount: shard.tokenIds.length }, "ClobWsPool: shard connected");
      shard.reconnectDelay = this.reconnectBaseMs; // reset on success
      this.subscribe(shard);
      this.startKeepalive(shard);
    });

    ws.on("message", (data: WebSocket.RawData) => {
      shard.lastEventTs = Date.now();
      try {
        const raw = JSON.parse(data.toString()) as unknown;
        const events = Array.isArray(raw) ? raw : [raw];
        for (const evt of events) {
          this.handleEvent(evt);
        }
      } catch (err) {
        logger.error({ err, shardIndex: shard.index }, "ClobWsPool: message parse error");
      }
    });

    ws.on("close", () => {
      if (shard.keepaliveTimer) {
        clearInterval(shard.keepaliveTimer);
        shard.keepaliveTimer = null;
      }
      if (!shard.stopped && !this.stopped) {
        logger.warn({ shardIndex: shard.index, nextMs: shard.reconnectDelay }, "ClobWsPool: shard disconnected");
        this.scheduleShardReconnect(shard);
      }
    });

    ws.on("error", (err) => {
      logger.error({ err, shardIndex: shard.index }, "ClobWsPool: shard error");
      this.emit("error", err, shard.index);
    });

    // Silent shard detection
    const silentCheck = setInterval(() => {
      if (Date.now() - shard.lastEventTs > this.silentThresholdMs) {
        logger.warn({ shardIndex: shard.index }, "ClobWsPool: shard silent > threshold");
        this.emit("error", new Error("shard_silent"), shard.index);
      }
    }, this.silentThresholdMs);

    // Store alongside keepalive
    shard.keepaliveTimer = silentCheck;
  }

  private subscribe(shard: Shard): void {
    if (shard.ws?.readyState !== WebSocket.OPEN) return;
    shard.ws.send(
      JSON.stringify({
        type: "market",
        assets_ids: shard.tokenIds,
        initial_dump: true,
      })
    );
  }

  private startKeepalive(shard: Shard): void {
    if (shard.keepaliveTimer) {
      clearInterval(shard.keepaliveTimer);
    }
    shard.keepaliveTimer = setInterval(() => {
      if (shard.ws?.readyState === WebSocket.OPEN) {
        shard.ws.send("PING");
      }
    }, KEEPALIVE_INTERVAL_MS);
  }

  private scheduleShardReconnect(shard: Shard): void {
    const rawDelay = shard.reconnectDelay;
    shard.reconnectDelay = Math.min(shard.reconnectDelay * 2, this.reconnectMaxMs);
    // Jitter: ±20% of base delay, capped at reconnectMaxMs
    const jittered = rawDelay * (0.8 + Math.random() * 0.4);
    const delay = Math.min(jittered, this.reconnectMaxMs);

    shard.reconnectTimer = setTimeout(() => {
      if (!shard.stopped && !this.stopped) {
        logger.info({ shardIndex: shard.index, delay }, "ClobWsPool: reconnecting shard");
        this.openShard(shard);
        this.emit("shard_reconnect", shard.index);
      }
    }, delay);
  }

  private handleEvent(raw: unknown): void {
    if (typeof raw !== "object" || raw === null) return;
    const typed = raw as { event?: string; type?: string };

    switch (typed.event ?? typed.type) {
      case "book": {
        const parsed = ZClobBookEvent.safeParse(raw);
        if (!parsed.success) return;
        const d = parsed.data;
        const book: OrderBook = {
          tokenId: d.asset_id,
          conditionId: d.market ?? "",
          bids: d.bids.map((b) => ({ price: parseFloat(b.price), size: parseFloat(b.size) }))
            .sort((a, b) => b.price - a.price),
          asks: d.asks.map((a) => ({ price: parseFloat(a.price), size: parseFloat(a.size) }))
            .sort((a, b) => a.price - b.price),
          timestamp: parseInt(d.timestamp, 10),
          hash: d.hash,
          capturedAt: new Date(),
        };
        this.emit("book", { type: "book", book } satisfies BookUpdateEvent);
        break;
      }
      case "price_change": {
        const parsed = ZClobPriceChangeEvent.safeParse(raw);
        if (!parsed.success) return;
        const d = parsed.data;
        this.emit("price_change", {
          type: "price_change",
          tokenId: d.asset_id,
          price: d.price,
          side: d.side,
          timestamp: d.timestamp,
        } satisfies PriceChangeEvent);
        break;
      }
      case "best_bid_ask": {
        const parsed = ZClobBestBidAskEvent.safeParse(raw);
        if (!parsed.success) return;
        const d = parsed.data;
        this.emit("best_bid_ask", {
          type: "best_bid_ask",
          tokenId: d.asset_id,
          bid: d.bid,
          ask: d.ask,
          timestamp: d.timestamp ?? Date.now(),
        } satisfies BestBidAskEvent);
        break;
      }
      case "last_trade_price": {
        const parsed = ZClobLastTradePriceEvent.safeParse(raw);
        if (!parsed.success) return;
        const d = parsed.data;
        this.emit("last_trade_price", {
          type: "last_trade_price",
          tokenId: d.asset_id,
          price: d.price,
          side: (d.side ?? "BUY") as "BUY" | "SELL",
          timestamp: d.timestamp ?? Date.now(),
        } satisfies LastTradePriceEvent);
        break;
      }
      case "market_resolved": {
        const evt = raw as { market?: string; asset_id?: string };
        const tokenId = evt.asset_id ?? evt.market ?? "";
        logger.info({ tokenId }, "ClobWsPool: market resolved");
        this.emit("market_resolved", { tokenId });
        if (this.db) {
          markMarketClosed(this.db, tokenId).catch((err) => {
            logger.error({ err, tokenId }, "ClobWsPool: failed to mark market closed");
          });
        }
        break;
      }
    }
  }

  private chunk<T>(arr: T[], size: number): T[][] {
    const chunks: T[][] = [];
    for (let i = 0; i < arr.length; i += size) {
      chunks.push(arr.slice(i, i + size));
    }
    return chunks;
  }
}
