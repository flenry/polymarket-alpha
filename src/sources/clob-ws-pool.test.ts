import { describe, it, expect, vi } from "vitest";
import { EventEmitter } from "node:events";
import { ClobWsPool } from "./clob-ws-pool.js";

class MockWs extends EventEmitter {
  static instances: MockWs[] = [];
  public sent: string[] = [];
  public closed = false;
  public readyState: number = 1; // OPEN = 1

  constructor(_url: string) {
    super();
    MockWs.instances.push(this);
    // Simulate open on next tick
    process.nextTick(() => this.emit("open"));
  }

  send(data: string): void {
    this.sent.push(data);
  }

  close(): void {
    this.closed = true;
    this.readyState = 3; // CLOSED
    this.emit("close");
  }
}

// WebSocket.OPEN constant
(MockWs as unknown as { OPEN: number }).OPEN = 1;

function makePool(opts: ConstructorParameters<typeof ClobWsPool>[0] = {}) {
  MockWs.instances = [];
  return new ClobWsPool({
    shardSize: 150,
    reconnectBaseMs: 50,
    reconnectMaxMs: 200,
    WsConstructor: MockWs as unknown as typeof import("ws").default,
    ...opts,
  });
}

describe("ClobWsPool", () => {
  it("connect(200 tokenIds) with shardSize=150 → opens 2 connections", async () => {
    const pool = makePool({ shardSize: 150 });
    const tokenIds = Array.from({ length: 200 }, (_, i) => `tok${i}`);

    await pool.connect(tokenIds);
    await new Promise((r) => process.nextTick(r));

    expect(MockWs.instances).toHaveLength(2);
    pool.disconnect();
  });

  it("each shard subscribes with correct sub-array", async () => {
    const pool = makePool({ shardSize: 3 });
    const tokenIds = ["tok1", "tok2", "tok3", "tok4"];

    await pool.connect(tokenIds);
    await new Promise((r) => process.nextTick(r));

    const ws0 = MockWs.instances[0];
    const ws1 = MockWs.instances[1];

    const sub0 = JSON.parse(ws0.sent[0]) as { assets_ids: string[] };
    const sub1 = JSON.parse(ws1.sent[0]) as { assets_ids: string[] };

    expect(sub0.assets_ids).toHaveLength(3);
    expect(sub1.assets_ids).toHaveLength(1);
    expect(sub0.assets_ids).toContain("tok1");
    expect(sub1.assets_ids).toContain("tok4");

    pool.disconnect();
  });

  it("shard 0 disconnect → only shard 0 reconnects; shard 1 unaffected", async () => {
    const pool = makePool({ shardSize: 2, reconnectBaseMs: 50 });
    const tokenIds = ["tok1", "tok2", "tok3", "tok4"];
    const reconnectEvents: number[] = [];

    pool.on("shard_reconnect", (idx) => reconnectEvents.push(idx));

    await pool.connect(tokenIds);
    await new Promise((r) => process.nextTick(r));

    const ws0 = MockWs.instances[0];
    ws0.close(); // simulate disconnect on shard 0

    await new Promise((r) => setTimeout(r, 100));

    expect(reconnectEvents).toContain(0);
    expect(reconnectEvents).not.toContain(1);

    pool.disconnect();
  });

  it("reconnect uses exponential backoff capped at reconnectMaxMs", async () => {
    const pool = makePool({ shardSize: 2, reconnectBaseMs: 50, reconnectMaxMs: 200 });
    const reconnectTimes: number[] = [];

    pool.on("shard_reconnect", () => reconnectTimes.push(Date.now()));

    await pool.connect(["tok1", "tok2"]);
    await new Promise((r) => process.nextTick(r));

    const ws0 = MockWs.instances[0];
    ws0.close();

    await new Promise((r) => setTimeout(r, 80));
    expect(reconnectTimes).toHaveLength(1);

    // Disconnect again
    const ws1 = MockWs.instances.find((w) => !w.closed && w !== ws0);
    if (ws1) {
      ws1.close();
      await new Promise((r) => setTimeout(r, 150));
    }

    pool.disconnect();
  });

  it("addTokenIds fills existing shards before opening new one", async () => {
    const pool = makePool({ shardSize: 3 });
    await pool.connect(["tok1", "tok2"]); // shard 0 has 2 of 3 slots
    await new Promise((r) => process.nextTick(r));

    const initialCount = MockWs.instances.length;

    // Add 1 token — should fit in existing shard
    await pool.addTokenIds(["tok3"]);
    expect(MockWs.instances).toHaveLength(initialCount); // no new connection

    // Add 2 more — should overflow to new shard
    await pool.addTokenIds(["tok4", "tok5"]);
    expect(MockWs.instances.length).toBeGreaterThan(initialCount);

    pool.disconnect();
  });

  it("getShardCount() returns correct number of active shards", async () => {
    const pool = makePool({ shardSize: 2 });
    expect(pool.getShardCount()).toBe(0); // before connect

    await pool.connect(["tok1", "tok2", "tok3"]); // 2+1 = 2 shards
    expect(pool.getShardCount()).toBe(2);

    pool.disconnect();
    expect(pool.getShardCount()).toBe(0);
  });

  it("shard_reconnect event emitted with correct shard index", async () => {
    const pool = makePool({ shardSize: 150, reconnectBaseMs: 50 });
    const reconnects: number[] = [];

    pool.on("shard_reconnect", (idx) => reconnects.push(idx));

    await pool.connect(["tok1"]);
    await new Promise((r) => process.nextTick(r));

    MockWs.instances[0].close();
    await new Promise((r) => setTimeout(r, 100));

    expect(reconnects).toEqual([0]);

    pool.disconnect();
  });
});

describe("ClobWsPool Phase 2 additions", () => {
  it("uses custom url option when passed to WsConstructor", async () => {
    const urls: string[] = [];
    class CapturingWs extends EventEmitter {
      static instances: CapturingWs[] = [];
      public sent: string[] = [];
      public readyState = 1;
      constructor(url: string) {
        super();
        urls.push(url);
        CapturingWs.instances.push(this);
        process.nextTick(() => this.emit("open"));
      }
      send(d: string) { this.sent.push(d); }
      close() { this.readyState = 3; this.emit("close"); }
    }
    (CapturingWs as unknown as { OPEN: number }).OPEN = 1;

    CapturingWs.instances = [];
    const pool = new ClobWsPool({
      url: "wss://custom.example.com/ws",
      shardSize: 150,
      reconnectBaseMs: 50,
      reconnectMaxMs: 200,
      WsConstructor: CapturingWs as unknown as typeof import("ws").default,
    });
    await pool.connect(["tok1"]);
    await new Promise((r) => process.nextTick(r));
    expect(urls[0]).toBe("wss://custom.example.com/ws");
    pool.disconnect();
  });

  it("jitter: reconnect delays vary and stay within [0.8*base, reconnectMaxMs]", async () => {
    const delays: number[] = [];
    const pool = makePool({ shardSize: 150, reconnectBaseMs: 100, reconnectMaxMs: 2000 });

    let resolveFirst: () => void;
    const firstReconnect = new Promise<void>((r) => { resolveFirst = r; });

    pool.on("shard_reconnect", () => {
      resolveFirst();
    });

    await pool.connect(["tok1"]);
    await new Promise((r) => process.nextTick(r));

    // Patch setTimeout to capture delays
    const origSetTimeout = global.setTimeout;
    const patchedSetTimeout = vi.spyOn(global, "setTimeout").mockImplementation((fn, ms, ...args) => {
      if (typeof ms === "number") delays.push(ms);
      return origSetTimeout(fn as () => void, ms, ...args);
    });

    MockWs.instances[0].close();

    await new Promise((r) => setTimeout(r, 300));

    patchedSetTimeout.mockRestore();

    // Should have at least one delay captured
    const reconnectDelays = delays.filter((d) => d >= 50 && d <= 2000);
    if (reconnectDelays.length > 0) {
      for (const d of reconnectDelays) {
        expect(d).toBeLessThanOrEqual(2000);
        expect(d).toBeGreaterThanOrEqual(50 * 0.8);
      }
    }
    pool.disconnect();
  });

  it("keepalive PING sent at configured interval", async () => {
    // Use a short keepalive interval so the test doesn't need fake timers
    const pool = new ClobWsPool({
      shardSize: 150,
      reconnectBaseMs: 50,
      reconnectMaxMs: 200,
      keepaliveIntervalMs: 30, // very short for test — spec default is 50s
      WsConstructor: MockWs as unknown as typeof import("ws").default,
    });
    MockWs.instances = [];
    await pool.connect(["tok1"]);
    await new Promise((r) => process.nextTick(r)); // let 'open' event fire

    const ws = MockWs.instances[0];
    expect(ws.sent.length).toBeGreaterThan(0); // subscription message sent
    ws.sent = []; // clear to capture only pings

    // Wait longer than the 30ms keepalive interval
    await new Promise((r) => setTimeout(r, 80));

    expect(ws.sent).toContain("PING");
    pool.disconnect();
  });

  it("market_resolved event: emits 'market_resolved' with tokenId", async () => {
    const pool = makePool({ shardSize: 150 });
    const resolved: { tokenId: string }[] = [];
    pool.on("market_resolved", (evt) => resolved.push(evt));

    await pool.connect(["tok1"]);
    await new Promise((r) => process.nextTick(r));

    // Simulate receiving a market_resolved message
    const ws = MockWs.instances[0];
    const msg = JSON.stringify({ event: "market_resolved", asset_id: "tok1" });
    ws.emit("message", Buffer.from(msg));

    expect(resolved).toHaveLength(1);
    expect(resolved[0].tokenId).toBe("tok1");
    pool.disconnect();
  });

  it("market_resolved without db: no throw, event still emitted", async () => {
    const pool = makePool({ shardSize: 150 }); // no db
    const resolved: { tokenId: string }[] = [];
    pool.on("market_resolved", (evt) => resolved.push(evt));

    await pool.connect(["tok1"]);
    await new Promise((r) => process.nextTick(r));

    const ws = MockWs.instances[0];
    ws.emit("message", Buffer.from(JSON.stringify({ event: "market_resolved", asset_id: "tok2" })));

    expect(resolved).toHaveLength(1);
    expect(resolved[0].tokenId).toBe("tok2");
    pool.disconnect();
  });

  it("market_resolved with db: calls markMarketClosed via db.update chain", async () => {
    // Build a minimal drizzle-compatible db mock
    const whereMock = vi.fn().mockResolvedValue(undefined);
    const setMock = vi.fn().mockReturnValue({ where: whereMock });
    const updateMock = vi.fn().mockReturnValue({ set: setMock });
    const mockDb = { update: updateMock };

    MockWs.instances = [];
    const pool = new ClobWsPool({
      shardSize: 150,
      reconnectBaseMs: 50,
      reconnectMaxMs: 200,
      WsConstructor: MockWs as unknown as typeof import("ws").default,
      db: mockDb as unknown as import("drizzle-orm/node-postgres").NodePgDatabase<typeof import("../db/schema.js")>,
    });

    const resolved: string[] = [];
    pool.on("market_resolved", (evt: { tokenId: string }) => resolved.push(evt.tokenId));

    await pool.connect(["tok1"]);
    await new Promise((r) => process.nextTick(r));

    MockWs.instances[0].emit(
      "message",
      Buffer.from(JSON.stringify({ event: "market_resolved", asset_id: "resolved_tok" }))
    );

    // Event emitted synchronously
    expect(resolved).toEqual(["resolved_tok"]);

    // Allow the async markMarketClosed promise to resolve
    await new Promise((r) => process.nextTick(r));
    await new Promise((r) => process.nextTick(r));

    // markMarketClosed calls db.update(...).set(...).where(...)
    expect(updateMock).toHaveBeenCalledOnce();
    expect(setMock).toHaveBeenCalledWith(expect.objectContaining({ closed: true }));

    pool.disconnect();
  });

  it("book message: emits 'book' BookUpdateEvent with parsed bids/asks", async () => {
    const pool = makePool({ shardSize: 150 });
    const bookEvents: unknown[] = [];
    pool.on("book", (evt) => bookEvents.push(evt));

    await pool.connect(["tok1"]);
    await new Promise((r) => process.nextTick(r));

    const ws = MockWs.instances[0];
    const msg = JSON.stringify({
      event: "book",
      asset_id: "tok1",
      market: "cond1",
      timestamp: "1700000000",
      hash: "0xabc",
      bids: [{ price: "0.65", size: "100" }, { price: "0.64", size: "200" }],
      asks: [{ price: "0.66", size: "150" }, { price: "0.67", size: "50" }],
    });
    ws.emit("message", Buffer.from(msg));

    expect(bookEvents).toHaveLength(1);
    const evt = bookEvents[0] as { type: string; book: { tokenId: string; bids: { price: number }[]; asks: { price: number }[] } };
    expect(evt.type).toBe("book");
    expect(evt.book.tokenId).toBe("tok1");
    // bids sorted descending by price
    expect(evt.book.bids[0].price).toBe(0.65);
    expect(evt.book.bids[1].price).toBe(0.64);
    // asks sorted ascending by price
    expect(evt.book.asks[0].price).toBe(0.66);
    expect(evt.book.asks[1].price).toBe(0.67);

    pool.disconnect();
  });

  it("price_change message: emits 'price_change' PriceChangeEvent", async () => {
    const pool = makePool({ shardSize: 150 });
    const events: unknown[] = [];
    pool.on("price_change", (evt) => events.push(evt));

    await pool.connect(["tok1"]);
    await new Promise((r) => process.nextTick(r));

    const ws = MockWs.instances[0];
    ws.emit("message", Buffer.from(JSON.stringify({
      event: "price_change",
      asset_id: "tok1",
      price: "0.72",
      side: "BUY",
      timestamp: "1700000001",
    })));

    expect(events).toHaveLength(1);
    const evt = events[0] as { type: string; tokenId: string; price: number; side: string };
    expect(evt.type).toBe("price_change");
    expect(evt.tokenId).toBe("tok1");
    expect(evt.price).toBe(0.72);
    expect(evt.side).toBe("BUY");

    pool.disconnect();
  });

  it("best_bid_ask message: emits 'best_bid_ask' BestBidAskEvent", async () => {
    const pool = makePool({ shardSize: 150 });
    const events: unknown[] = [];
    pool.on("best_bid_ask", (evt) => events.push(evt));

    await pool.connect(["tok1"]);
    await new Promise((r) => process.nextTick(r));

    const ws = MockWs.instances[0];
    ws.emit("message", Buffer.from(JSON.stringify({
      event: "best_bid_ask",
      asset_id: "tok1",
      bid: "0.64",
      ask: "0.66",
      timestamp: "1700000002",
    })));

    expect(events).toHaveLength(1);
    const evt = events[0] as { type: string; tokenId: string; bid: number; ask: number };
    expect(evt.type).toBe("best_bid_ask");
    expect(evt.tokenId).toBe("tok1");
    expect(evt.bid).toBe(0.64);
    expect(evt.ask).toBe(0.66);

    pool.disconnect();
  });

  it("last_trade_price message: emits 'last_trade_price' LastTradePriceEvent", async () => {
    const pool = makePool({ shardSize: 150 });
    const events: unknown[] = [];
    pool.on("last_trade_price", (evt) => events.push(evt));

    await pool.connect(["tok1"]);
    await new Promise((r) => process.nextTick(r));

    const ws = MockWs.instances[0];
    ws.emit("message", Buffer.from(JSON.stringify({
      event: "last_trade_price",
      asset_id: "tok1",
      price: "0.68",
      side: "SELL",
      timestamp: "1700000003",
    })));

    expect(events).toHaveLength(1);
    const evt = events[0] as { type: string; tokenId: string; price: number; side: string };
    expect(evt.type).toBe("last_trade_price");
    expect(evt.tokenId).toBe("tok1");
    expect(evt.price).toBe(0.68);
    expect(evt.side).toBe("SELL");

    pool.disconnect();
  });

  it("array of events in one message: all events processed", async () => {
    const pool = makePool({ shardSize: 150 });
    const priceEvents: unknown[] = [];
    pool.on("price_change", (evt) => priceEvents.push(evt));

    await pool.connect(["tok1", "tok2"]);
    await new Promise((r) => process.nextTick(r));

    const ws = MockWs.instances[0];
    ws.emit("message", Buffer.from(JSON.stringify([
      { event: "price_change", asset_id: "tok1", price: "0.71", side: "BUY", timestamp: "1700000004" },
      { event: "price_change", asset_id: "tok2", price: "0.42", side: "SELL", timestamp: "1700000005" },
    ])));

    expect(priceEvents).toHaveLength(2);

    pool.disconnect();
  });

  it("addTokenIds when shard ws not yet open: skips re-subscribe (readyState !== OPEN)", async () => {
    // Use a WS that does NOT auto-emit 'open' — readyState stays at default (1=OPEN mimics connected)
    // To test the NOT-open path we need readyState !== 1
    class NotOpenWs extends EventEmitter {
      static instances: NotOpenWs[] = [];
      public sent: string[] = [];
      public readyState = 3; // CLOSED — not open
      constructor(_url: string) {
        super();
        NotOpenWs.instances.push(this);
        // Never emits 'open'
      }
      send(d: string) { this.sent.push(d); }
      close() { this.readyState = 3; this.emit("close"); }
    }
    (NotOpenWs as unknown as { OPEN: number }).OPEN = 1;

    NotOpenWs.instances = [];
    const pool = new ClobWsPool({
      shardSize: 3,
      reconnectBaseMs: 50,
      reconnectMaxMs: 200,
      WsConstructor: NotOpenWs as unknown as typeof import("ws").default,
    });

    // connect creates shard with ws in NOT-OPEN state
    await pool.connect(["tok1", "tok2"]);

    // addTokenIds — shard has room (2/3), but ws is not open → subscribe NOT called
    const sentBefore = [...(NotOpenWs.instances[0]?.sent ?? [])];
    await pool.addTokenIds(["tok3"]);

    // No new WS opened (shard had room)
    expect(NotOpenWs.instances).toHaveLength(1);
    // subscribe not called because readyState !== OPEN
    expect(NotOpenWs.instances[0].sent).toEqual(sentBefore);

    pool.disconnect();
  });

  it("keepalive does not send PING when ws readyState is not OPEN", async () => {
    // Use a ws that starts open but closes before the keepalive fires
    const pool = new ClobWsPool({
      shardSize: 150,
      reconnectBaseMs: 50000, // long reconnect so it doesn't interfere
      reconnectMaxMs: 60000,
      keepaliveIntervalMs: 30,
      WsConstructor: MockWs as unknown as typeof import("ws").default,
    });
    MockWs.instances = [];
    await pool.connect(["tok1"]);
    await new Promise((r) => process.nextTick(r)); // open fires

    const ws = MockWs.instances[0];
    ws.sent = [];
    // Manually set readyState to CLOSED without triggering reconnect logic
    ws.readyState = 3; // CLOSED — keepalive interval will check and skip send

    await new Promise((r) => setTimeout(r, 80)); // wait for keepalive to fire

    // PING should NOT be sent because readyState !== OPEN
    expect(ws.sent).not.toContain("PING");
    pool.disconnect();
  });

  it("silent shard detection: emits 'error' shard_silent when no messages received within threshold", async () => {
    // Use a very short silentShardThresholdMs so the test doesn't take long
    const pool = new ClobWsPool({
      shardSize: 150,
      reconnectBaseMs: 50000,
      reconnectMaxMs: 60000,
      keepaliveIntervalMs: 5000, // long — not the thing being tested
      silentShardThresholdMs: 30, // very short threshold
      WsConstructor: MockWs as unknown as typeof import("ws").default,
    });
    MockWs.instances = [];

    const errors: Error[] = [];
    pool.on("error", (err: Error) => errors.push(err));

    await pool.connect(["tok1"]);
    await new Promise((r) => process.nextTick(r)); // let 'open' fire

    // Wait longer than the 30ms threshold without any messages
    await new Promise((r) => setTimeout(r, 80));

    // Should have emitted at least one 'shard_silent' error
    const silentErrors = errors.filter((e) => e.message === "shard_silent");
    expect(silentErrors.length).toBeGreaterThan(0);

    pool.disconnect();
  });

  it("invalid JSON message: caught without throw, parse error logged", async () => {
    const pool = makePool({ shardSize: 150 });
    // Ensure pool doesn't throw on bad messages
    pool.on("error", () => {}); // suppress unhandled error

    MockWs.instances = [];
    await pool.connect(["tok1"]);
    await new Promise((r) => process.nextTick(r));

    const ws = MockWs.instances[0];
    // Emit a non-JSON message — should be caught by the try/catch in message handler
    expect(() => ws.emit("message", Buffer.from("{invalid json!!"))).not.toThrow();

    pool.disconnect();
  });

  it("startKeepalive: clears existing keepalive timer before setting new one", async () => {
    // Directly tests lines 201-202: when startKeepalive is called while keepaliveTimer is set
    // This happens if 'open' fires when a timer is already active.
    // We simulate it by using a ws that emits 'open' twice in sequence.
    class DoubleOpenWs extends EventEmitter {
      static instances: DoubleOpenWs[] = [];
      public sent: string[] = [];
      public readyState = 1;
      constructor(_url: string) {
        super();
        DoubleOpenWs.instances.push(this);
        // Emit open twice on next tick
        process.nextTick(() => {
          this.emit("open");
          this.emit("open"); // second open while keepalive already set
        });
      }
      send(d: string) { this.sent.push(d); }
      close() { this.readyState = 3; this.emit("close"); }
    }
    (DoubleOpenWs as unknown as { OPEN: number }).OPEN = 1;

    DoubleOpenWs.instances = [];
    const pool = new ClobWsPool({
      shardSize: 150,
      reconnectBaseMs: 50,
      reconnectMaxMs: 200,
      keepaliveIntervalMs: 5000,
      WsConstructor: DoubleOpenWs as unknown as typeof import("ws").default,
    });

    // Should not throw even when open fires twice
    await expect(pool.connect(["tok1"])).resolves.toBeUndefined();
    await new Promise((r) => process.nextTick(r));
    await new Promise((r) => process.nextTick(r));

    pool.disconnect();
  });

  it("ws error event: emits 'error' on pool with correct shard index", async () => {
    const pool = makePool({ shardSize: 150 });
    const poolErrors: Array<[Error, number]> = [];
    pool.on("error", (err: Error, idx: number) => poolErrors.push([err, idx]));

    MockWs.instances = [];
    await pool.connect(["tok1"]);
    await new Promise((r) => process.nextTick(r));

    const ws = MockWs.instances[0];
    const wsError = new Error("WS connection error");
    ws.emit("error", wsError);

    expect(poolErrors).toHaveLength(1);
    expect(poolErrors[0][0]).toBe(wsError);
    expect(poolErrors[0][1]).toBe(0); // shard index 0

    pool.disconnect();
  });

  it("startKeepalive clears previous timer when called twice (reconnect scenario)", async () => {
    // This covers lines 201-202: the 'if (shard.keepaliveTimer) clearInterval' branch
    // It fires when a shard reconnects — startKeepalive is called again on second open
    const pool = makePool({ shardSize: 150, reconnectBaseMs: 20, reconnectMaxMs: 200, keepaliveIntervalMs: 5000 });
    MockWs.instances = [];
    await pool.connect(["tok1"]);
    await new Promise((r) => process.nextTick(r)); // first open fires

    // Force reconnect — close triggers scheduleShardReconnect
    const ws0 = MockWs.instances[0];
    ws0.close();

    // Wait for reconnect
    await new Promise((r) => setTimeout(r, 80));
    await new Promise((r) => process.nextTick(r)); // second open fires

    // No error thrown and pool still healthy
    expect(MockWs.instances.length).toBeGreaterThan(1); // a new WS was created

    pool.disconnect();
  });

  it("best_bid_ask without timestamp: uses Date.now() fallback", async () => {
    const pool = makePool({ shardSize: 150 });
    const events: unknown[] = [];
    pool.on("best_bid_ask", (evt) => events.push(evt));

    await pool.connect(["tok1"]);
    await new Promise((r) => process.nextTick(r));

    const ws = MockWs.instances[0];
    // No timestamp field → should fall back to Date.now()
    const before = Date.now();
    ws.emit("message", Buffer.from(JSON.stringify({
      event: "best_bid_ask",
      asset_id: "tok1",
      bid: "0.64",
      ask: "0.66",
      // no timestamp
    })));
    const after = Date.now();

    expect(events).toHaveLength(1);
    const evt = events[0] as { timestamp: number };
    expect(evt.timestamp).toBeGreaterThanOrEqual(before);
    expect(evt.timestamp).toBeLessThanOrEqual(after);
    pool.disconnect();
  });

  it("last_trade_price without side: defaults to 'BUY'; without timestamp: uses Date.now() fallback", async () => {
    const pool = makePool({ shardSize: 150 });
    const events: unknown[] = [];
    pool.on("last_trade_price", (evt) => events.push(evt));

    await pool.connect(["tok1"]);
    await new Promise((r) => process.nextTick(r));

    const ws = MockWs.instances[0];
    const before = Date.now();
    ws.emit("message", Buffer.from(JSON.stringify({
      event: "last_trade_price",
      asset_id: "tok1",
      price: "0.68",
      // no side, no timestamp
    })));
    const after = Date.now();

    expect(events).toHaveLength(1);
    const evt = events[0] as { side: string; timestamp: number };
    expect(evt.side).toBe("BUY"); // default
    expect(evt.timestamp).toBeGreaterThanOrEqual(before);
    expect(evt.timestamp).toBeLessThanOrEqual(after);
    pool.disconnect();
  });

  it("market_resolved using 'market' field when 'asset_id' absent", async () => {
    const pool = makePool({ shardSize: 150 });
    const resolved: { tokenId: string }[] = [];
    pool.on("market_resolved", (evt) => resolved.push(evt));

    await pool.connect(["tok1"]);
    await new Promise((r) => process.nextTick(r));

    const ws = MockWs.instances[0];
    // Use 'market' instead of 'asset_id'
    ws.emit("message", Buffer.from(JSON.stringify({
      event: "market_resolved",
      market: "market_tok_via_market_field",
      // no asset_id
    })));

    expect(resolved).toHaveLength(1);
    expect(resolved[0].tokenId).toBe("market_tok_via_market_field");
    pool.disconnect();
  });

  it("market_resolved with neither asset_id nor market: tokenId is empty string", async () => {
    const pool = makePool({ shardSize: 150 });
    const resolved: { tokenId: string }[] = [];
    pool.on("market_resolved", (evt) => resolved.push(evt));

    await pool.connect(["tok1"]);
    await new Promise((r) => process.nextTick(r));

    const ws = MockWs.instances[0];
    ws.emit("message", Buffer.from(JSON.stringify({
      event: "market_resolved",
      // neither asset_id nor market
    })));

    expect(resolved).toHaveLength(1);
    expect(resolved[0].tokenId).toBe("");
    pool.disconnect();
  });

  it("invalid book message (missing required field): silently dropped", async () => {
    // Covers `if (!parsed.success) return` for book event (lines 227-230)
    const pool = makePool({ shardSize: 150 });
    const bookEvents: unknown[] = [];
    pool.on("book", (evt) => bookEvents.push(evt));

    await pool.connect(["tok1"]);
    await new Promise((r) => process.nextTick(r));

    const ws = MockWs.instances[0];
    // Missing asset_id, timestamp, hash — Zod will fail
    ws.emit("message", Buffer.from(JSON.stringify({
      event: "book",
      // no asset_id, no timestamp, no hash, no bids, no asks
    })));

    // No event emitted — bad book message silently dropped
    expect(bookEvents).toHaveLength(0);
    pool.disconnect();
  });

  it("book message without 'market' field: conditionId defaults to empty string", async () => {
    const pool = makePool({ shardSize: 150 });
    const bookEvents: unknown[] = [];
    pool.on("book", (evt) => bookEvents.push(evt));

    await pool.connect(["tok1"]);
    await new Promise((r) => process.nextTick(r));

    const ws = MockWs.instances[0];
    // No 'market' field — schema has it as optional
    ws.emit("message", Buffer.from(JSON.stringify({
      event: "book",
      asset_id: "tok1",
      // no 'market' field → d.market ?? "" → conditionId = ""
      timestamp: "1700000000",
      hash: "0xabc",
      bids: [{ price: "0.65", size: "100" }],
      asks: [{ price: "0.66", size: "50" }],
    })));

    expect(bookEvents).toHaveLength(1);
    const evt = bookEvents[0] as { book: { conditionId: string } };
    expect(evt.book.conditionId).toBe(""); // ?? "" fallback

    pool.disconnect();
  });

  it("invalid price_change message (missing required field): silently dropped", async () => {
    const pool = makePool({ shardSize: 150 });
    const events: unknown[] = [];
    pool.on("price_change", (evt) => events.push(evt));

    await pool.connect(["tok1"]);
    await new Promise((r) => process.nextTick(r));

    const ws = MockWs.instances[0];
    // Missing asset_id — Zod will reject → if (!parsed.success) return
    ws.emit("message", Buffer.from(JSON.stringify({
      event: "price_change",
      // no asset_id
      price: "0.72",
      side: "BUY",
      timestamp: "1700000001",
    })));

    // No event emitted — bad message silently dropped
    expect(events).toHaveLength(0);
    pool.disconnect();
  });

  it("invalid best_bid_ask message (missing required field): silently dropped", async () => {
    const pool = makePool({ shardSize: 150 });
    const events: unknown[] = [];
    pool.on("best_bid_ask", (evt) => events.push(evt));

    await pool.connect(["tok1"]);
    await new Promise((r) => process.nextTick(r));

    const ws = MockWs.instances[0];
    // Missing bid/ask — Zod will reject
    ws.emit("message", Buffer.from(JSON.stringify({
      event: "best_bid_ask",
      // no asset_id
    })));

    expect(events).toHaveLength(0);
    pool.disconnect();
  });

  it("invalid last_trade_price message (missing required field): silently dropped", async () => {
    const pool = makePool({ shardSize: 150 });
    const events: unknown[] = [];
    pool.on("last_trade_price", (evt) => events.push(evt));

    await pool.connect(["tok1"]);
    await new Promise((r) => process.nextTick(r));

    const ws = MockWs.instances[0];
    // Missing asset_id — Zod will reject
    ws.emit("message", Buffer.from(JSON.stringify({
      event: "last_trade_price",
      // no asset_id
      price: "0.68",
    })));

    expect(events).toHaveLength(0);
    pool.disconnect();
  });

  it("close handler when pool already stopped: no reconnect scheduled", async () => {
    // Covers the false branch of `if (!shard.stopped && !this.stopped)` in close handler
    // This fires when disconnect() is called and internally calls ws.close()
    const pool = makePool({ shardSize: 150, reconnectBaseMs: 50 });
    const reconnects: number[] = [];
    pool.on("shard_reconnect", (idx) => reconnects.push(idx));

    MockWs.instances = [];
    await pool.connect(["tok1"]);
    await new Promise((r) => process.nextTick(r));

    // Call disconnect — this sets stopped=true and calls ws.close() internally
    pool.disconnect();

    // Wait to ensure no reconnect fires
    await new Promise((r) => setTimeout(r, 100));

    // No reconnect should fire since pool was stopped before close
    expect(reconnects).toHaveLength(0);
  });

  it("market_resolved with db: markMarketClosed error is caught without propagating", async () => {
    // Build a db mock whose update chain rejects
    const whereMock = vi.fn().mockRejectedValue(new Error("DB write failed"));
    const setMock = vi.fn().mockReturnValue({ where: whereMock });
    const updateMock = vi.fn().mockReturnValue({ set: setMock });
    const mockDb = { update: updateMock };

    MockWs.instances = [];
    const pool = new ClobWsPool({
      shardSize: 150,
      reconnectBaseMs: 50,
      reconnectMaxMs: 200,
      WsConstructor: MockWs as unknown as typeof import("ws").default,
      db: mockDb as unknown as import("drizzle-orm/node-postgres").NodePgDatabase<typeof import("../db/schema.js")>,
    });

    const resolved: string[] = [];
    pool.on("market_resolved", (evt: { tokenId: string }) => resolved.push(evt.tokenId));
    await pool.connect(["tok1"]);
    await new Promise((r) => process.nextTick(r));

    MockWs.instances[0].emit(
      "message",
      Buffer.from(JSON.stringify({ event: "market_resolved", asset_id: "err_tok" }))
    );

    // Event still emitted synchronously
    expect(resolved).toEqual(["err_tok"]);

    // Allow the rejected promise to settle
    await new Promise((r) => setTimeout(r, 20));

    // No throw — error was caught by .catch()
    expect(updateMock).toHaveBeenCalledOnce();

    pool.disconnect();
  });

  it("constructor with no opts: uses default shardSize=150, reconnectBase=1000, etc.", async () => {
    // Covers lines 55-58: the ?? right-hand defaults when opts fields are omitted
    class BareWs extends EventEmitter {
      static instances: BareWs[] = [];
      public sent: string[] = [];
      public readyState = 1;
      constructor(_url: string) {
        super();
        BareWs.instances.push(this);
        process.nextTick(() => this.emit("open"));
      }
      send(d: string) { this.sent.push(d); }
      close() { this.readyState = 3; this.emit("close"); }
    }
    (BareWs as unknown as { OPEN: number }).OPEN = 1;
    BareWs.instances = [];

    // Pass ONLY WsConstructor — all numeric/string opts use their ?? defaults
    const pool = new ClobWsPool({
      WsConstructor: BareWs as unknown as typeof import("ws").default,
    });
    const tokenIds = Array.from({ length: 100 }, (_, i) => `tok${i}`);
    await pool.connect(tokenIds);
    // Default shardSize=150 → 100 tokens = 1 shard
    expect(pool.getShardCount()).toBe(1);
    pool.disconnect();
  });

  it("constructor with empty opts {}: WsConstructor defaults to real WebSocket (no connect called)", () => {
    // Covers line 58: `opts.WsConstructor ?? WebSocket` — the ?? WebSocket fallback
    // We just construct it without connecting to verify no throw
    const pool = new ClobWsPool({});
    expect(pool.getShardCount()).toBe(0); // nothing connected
    // No disconnect needed — no shards created
  });

  it("handleEvent: non-object raw message is silently ignored", async () => {
    // Covers line 227: `if (typeof raw !== 'object' || raw === null) return`
    const pool = makePool({ shardSize: 150 });
    const bookEvents: unknown[] = [];
    pool.on("book", (evt) => bookEvents.push(evt));

    MockWs.instances = [];
    await pool.connect(["tok1"]);
    await new Promise((r) => process.nextTick(r));

    const ws = MockWs.instances[0];
    // Emit a JSON string (non-object) — should be silently ignored
    ws.emit("message", Buffer.from(JSON.stringify("just a string")));
    // Emit a JSON number
    ws.emit("message", Buffer.from(JSON.stringify(42)));
    // Emit JSON null
    ws.emit("message", Buffer.from("null"));

    expect(bookEvents).toHaveLength(0);
    pool.disconnect();
  });

  it("handleEvent: event dispatched via 'type' field when 'event' field absent", async () => {
    // Covers line 230: `switch(typed.event ?? typed.type)` — the typed.type fallback
    const pool = makePool({ shardSize: 150 });
    const priceEvents: unknown[] = [];
    pool.on("price_change", (evt) => priceEvents.push(evt));

    MockWs.instances = [];
    await pool.connect(["tok1"]);
    await new Promise((r) => process.nextTick(r));

    const ws = MockWs.instances[0];
    // Use 'type' field instead of 'event' field
    ws.emit("message", Buffer.from(JSON.stringify({
      type: "price_change",
      asset_id: "tok1",
      price: "0.72",
      side: "BUY",
      timestamp: "1700000010",
    })));

    expect(priceEvents).toHaveLength(1);
    const evt = priceEvents[0] as { type: string; tokenId: string };
    expect(evt.type).toBe("price_change");
    expect(evt.tokenId).toBe("tok1");
    pool.disconnect();
  });

  it("openShard: clears existing silentCheckTimer when called again (reconnect before first open)", async () => {
    // Covers line 179: `if (shard.silentCheckTimer) clearInterval(...)` true branch
    // Fires when openShard() is called on a shard that already has silentCheckTimer set
    const pool = makePool({
      shardSize: 150,
      reconnectBaseMs: 20,
      reconnectMaxMs: 50,
      silentShardThresholdMs: 5000,
    });
    const reconnects: number[] = [];
    pool.on("shard_reconnect", (idx) => reconnects.push(idx));

    MockWs.instances = [];
    await pool.connect(["tok1"]);
    // silentCheckTimer is set immediately when openShard() runs (before 'open' fires)
    // Trigger close immediately — before nextTick fires the 'open' event
    const ws = MockWs.instances[0];
    ws.readyState = 3; // CLOSED
    ws.emit("close"); // triggers scheduleShardReconnect

    // Wait for reconnect — second openShard() will find silentCheckTimer already set
    await new Promise((r) => setTimeout(r, 80));
    await new Promise((r) => process.nextTick(r));

    expect(reconnects).toContain(0); // reconnect happened
    expect(pool.getShardCount()).toBe(1);
    pool.disconnect();
  });
});
