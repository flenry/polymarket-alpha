import { describe, it, expect, vi, beforeEach } from "vitest";
import { EventEmitter } from "node:events";
import { LiveDataWsClient } from "./live-data-ws-client.js";
import { TypedEventBus } from "../events/bus.js";

// Mock WebSocket that allows us to simulate events
class MockWs extends EventEmitter {
  static instances: MockWs[] = [];
  public sent: string[] = [];
  public closed = false;

  constructor(_url: string) {
    super();
    MockWs.instances.push(this);
  }

  send(data: string): void {
    this.sent.push(data);
  }

  close(): void {
    this.closed = true;
    this.emit("close");
  }
}

function makeClient(options: {
  negRiskSet?: Set<string>;
  reconnectBaseMs?: number;
  reconnectMaxMs?: number;
} = {}) {
  MockWs.instances = [];
  const bus = new TypedEventBus();
  const client = new LiveDataWsClient({
    bus,
    negRiskSet: options.negRiskSet ?? new Set(),
    reconnectBaseMs: options.reconnectBaseMs ?? 50,
    reconnectMaxMs: options.reconnectMaxMs ?? 200,
    WsConstructor: MockWs as unknown as typeof import("ws").default,
  });
  return { client, bus };
}

function validTrade(tokenId = "tok1") {
  return {
    asset: tokenId,
    conditionId: "cond1",
    side: "BUY",
    size: 100,
    price: 0.65,
    proxyWallet: "0xwallet",
    transactionHash: "0xtx",
    timestamp: 1700000000,
    outcome: "Yes",
    slug: "test-market",
    eventSlug: "test-event",
    title: "Test Market",
  };
}

describe("LiveDataWsClient", () => {
  it("valid trade event parsed and emitted as TradeEvent", async () => {
    const { client, bus } = makeClient();
    const received: unknown[] = [];

    bus.on("trade", (t) => received.push(t));
    client.connect();

    const ws = MockWs.instances[0];
    ws.emit("open");
    ws.emit("message", Buffer.from(JSON.stringify(validTrade())));

    expect(received).toHaveLength(1);
    const trade = received[0] as { tokenId: string; valueUsdc: number };
    expect(trade.tokenId).toBe("tok1");
    expect(trade.valueUsdc).toBeCloseTo(65, 1); // 100 * 0.65
  });

  it("neg_risk token ID NOT filtered — trade event emitted (Phase 4: neg-risk trades flow through)", () => {
    const negRiskSet = new Set(["tok-neg"]);
    const { client, bus } = makeClient({ negRiskSet });
    const received: unknown[] = [];

    bus.on("trade", (t) => received.push(t));
    client.connect();

    const ws = MockWs.instances[0];
    ws.emit("open");
    ws.emit("message", Buffer.from(JSON.stringify(validTrade("tok-neg"))));

    // Phase 4: neg-risk filter removed — trade events flow through for persistence
    expect(received).toHaveLength(1);
  });

  it("malformed JSON payload: logs error, does not crash, continues", () => {
    const { client, bus } = makeClient();
    const received: unknown[] = [];

    bus.on("trade", (t) => received.push(t));
    client.connect();

    const ws = MockWs.instances[0];
    ws.emit("open");

    // Malformed JSON — should not throw
    expect(() => {
      ws.emit("message", Buffer.from("{invalid json}"));
    }).not.toThrow();

    // After bad message, valid trade still works
    ws.emit("message", Buffer.from(JSON.stringify(validTrade())));
    expect(received).toHaveLength(1);
  });

  it("disconnect triggers reconnect attempt after reconnectBaseMs", async () => {
    const { client } = makeClient({ reconnectBaseMs: 50 });
    const reconnectEvents: number[] = [];

    client.on("reconnecting", () => reconnectEvents.push(Date.now()));
    client.connect();

    const ws = MockWs.instances[0];
    ws.emit("open");
    ws.emit("close"); // simulates disconnect

    // Wait for reconnect
    await new Promise((r) => setTimeout(r, 100));

    expect(reconnectEvents).toHaveLength(1);
    client.disconnect();
  });

  it("reconnect uses exponential backoff, capped at reconnectMaxMs", async () => {
    const { client } = makeClient({ reconnectBaseMs: 50, reconnectMaxMs: 200 });
    const reconnectTimes: number[] = [];

    client.on("reconnecting", () => reconnectTimes.push(Date.now()));
    client.connect();

    const ws0 = MockWs.instances[0];
    ws0.emit("open");
    ws0.emit("close");

    // Wait for first reconnect
    await new Promise((r) => setTimeout(r, 80));
    expect(reconnectTimes).toHaveLength(1);

    // Second disconnect — delay should be 100ms (50*2) 
    const ws1 = MockWs.instances[1];
    ws1.emit("close");

    await new Promise((r) => setTimeout(r, 150));
    expect(reconnectTimes).toHaveLength(2);

    client.disconnect();
  });

  it("valueUsdc calculated correctly (size × price)", () => {
    const { client, bus } = makeClient();
    const received: Array<{ valueUsdc: number; sizeTokens: number; priceUsdc: number }> = [];

    bus.on("trade", (t) => received.push(t as { valueUsdc: number; sizeTokens: number; priceUsdc: number }));
    client.connect();

    const ws = MockWs.instances[0];
    ws.emit("open");
    ws.emit("message", Buffer.from(JSON.stringify({
      ...validTrade(),
      size: 200,
      price: 0.75,
    })));

    expect(received[0].valueUsdc).toBeCloseTo(150, 1); // 200 * 0.75
    expect(received[0].sizeTokens).toBe(200);
    expect(received[0].priceUsdc).toBe(0.75);
  });

  it("disconnect() stops reconnect loop", async () => {
    const { client } = makeClient({ reconnectBaseMs: 50 });
    const reconnectCount = { value: 0 };

    client.on("reconnecting", () => reconnectCount.value++);
    client.connect();

    const ws = MockWs.instances[0];
    ws.emit("open");
    ws.emit("close"); // triggers reconnect scheduling

    // Disconnect immediately after
    client.disconnect();

    // Wait — no reconnect should happen
    await new Promise((r) => setTimeout(r, 150));
    expect(reconnectCount.value).toBe(0);
  });
});
