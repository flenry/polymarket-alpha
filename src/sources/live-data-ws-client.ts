import { EventEmitter } from "node:events";
import WebSocket from "ws";
import { ZLiveTradeEvent } from "../validation/schemas.js";
import type { TradeEvent, TokenId } from "../events/types.js";
import type { TypedEventBus } from "../events/bus.js";
import { logger } from "../logger.js";

const LIVE_DATA_WS_URL = "wss://ws-live-data.polymarket.com";

export interface LiveDataWsClientOptions {
  bus: TypedEventBus;
  negRiskSet: Set<TokenId>;
  reconnectBaseMs?: number;
  reconnectMaxMs?: number;
  WsConstructor?: typeof WebSocket;
}

export class LiveDataWsClient extends EventEmitter {
  private ws: WebSocket | null = null;
  private reconnectDelay: number;
  private readonly reconnectBaseMs: number;
  private readonly reconnectMaxMs: number;
  private stopped = false;
  private lastEventTs: number = Date.now();
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private readonly WsConstructor: typeof WebSocket;

  constructor(private readonly options: LiveDataWsClientOptions) {
    super();
    this.reconnectBaseMs = options.reconnectBaseMs ?? 1000;
    this.reconnectMaxMs = options.reconnectMaxMs ?? 30000;
    this.reconnectDelay = this.reconnectBaseMs;
    this.WsConstructor = options.WsConstructor ?? WebSocket;
  }

  connect(): void {
    this.stopped = false;
    this.openConnection();
  }

  disconnect(): void {
    this.stopped = true;
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    this.ws?.close();
    this.ws = null;
  }

  private openConnection(): void {
    const ws = new this.WsConstructor(LIVE_DATA_WS_URL);
    this.ws = ws;

    ws.on("open", () => {
      logger.info("LiveDataWsClient: connected");
      this.reconnectDelay = this.reconnectBaseMs; // reset on success
      ws.send(
        JSON.stringify({
          subscriptions: [{ topic: "activity", type: "trades" }],
        })
      );
    });

    ws.on("message", (data: WebSocket.RawData) => {
      this.lastEventTs = Date.now();
      try {
        const raw = JSON.parse(data.toString()) as unknown;
        this.handleMessage(raw);
      } catch (err) {
        logger.error({ err }, "LiveDataWsClient: failed to parse message");
        // Do not crash — continue
      }
    });

    ws.on("close", () => {
      if (!this.stopped) {
        logger.warn(
          { nextAttemptMs: this.reconnectDelay },
          "LiveDataWsClient: disconnected, scheduling reconnect"
        );
        this.scheduleReconnect();
      }
    });

    ws.on("error", (err) => {
      logger.error({ err }, "LiveDataWsClient: WS error");
      // close event will follow and trigger reconnect
    });
  }

  private scheduleReconnect(): void {
    const delay = this.reconnectDelay;
    this.reconnectDelay = Math.min(this.reconnectDelay * 2, this.reconnectMaxMs);

    this.reconnectTimer = setTimeout(() => {
      if (!this.stopped) {
        logger.info({ delay }, "LiveDataWsClient: reconnecting");
        this.openConnection();
        this.emit("reconnecting");
      }
    }, delay);
  }

  private handleMessage(raw: unknown): void {
    // Live-Data WS may send arrays or single objects
    const events = Array.isArray(raw) ? raw : [raw];

    for (const evt of events) {
      const parsed = ZLiveTradeEvent.safeParse(evt);
      if (!parsed.success) {
        logger.debug({ errors: parsed.error.errors }, "LiveDataWsClient: skipping invalid trade");
        continue;
      }

      const d = parsed.data;
      const tokenId = d.asset;

      // Phase 4: neg-risk filter removed — trades flow through for persistence
      // Signal evaluation for neg-risk is handled by NegRiskEngine

      const valueUsdc = d.size * d.price;
      const trade: TradeEvent = {
        tokenId,
        conditionId: d.conditionId,
        side: d.side,
        sizeTokens: d.size,
        priceUsdc: d.price,
        valueUsdc,
        proxyWallet: d.proxyWallet,
        transactionHash: d.transactionHash,
        tradedAt: new Date(d.timestamp * 1000),
        outcome: d.outcome ?? "",
        marketSlug: d.slug ?? "",
        eventSlug: d.eventSlug ?? "",
        marketTitle: d.title ?? "",
        traderPseudonym: d.pseudonym ?? undefined,
        traderName: d.name ?? undefined,
        source: "live_ws",
      };

      this.options.bus.emit("trade", trade);
    }
  }

  getLastEventTs(): number {
    return this.lastEventTs;
  }
}
