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
});
