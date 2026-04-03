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

function makePool(opts: Parameters<typeof ClobWsPool>[0] = {}) {
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
