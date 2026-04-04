import { describe, it, expect, vi } from "vitest";
import { EventEmitter } from "node:events";
import { LiveDataWsClient } from "../src/sources/live-data-ws-client.js";
import { TypedEventBus } from "../src/events/bus.js";
import tradeFixture from "./fixtures/trade-event.json" assert { type: "json" };

// FROZEN: do not edit without updating consuming tests

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

function makeClient(negRiskSet = new Set<string>()) {
  MockWs.instances = [];
  const bus = new TypedEventBus();
  const client = new LiveDataWsClient({
    bus,
    negRiskSet,
    reconnectBaseMs: 50,
    reconnectMaxMs: 200,
    WsConstructor: MockWs as unknown as typeof import("ws").default,
  });
  return { client, bus };
}

describe("LiveDataWsClient (fixture-based)", () => {
  it("reconnect on disconnect with exponential backoff", async () => {
    const { client } = makeClient();
    const reconnectEvents: number[] = [];

    client.on("reconnecting", () => reconnectEvents.push(Date.now()));
    client.connect();

    const ws = MockWs.instances[0];
    ws.emit("open");
    ws.emit("close"); // disconnect

    await new Promise((r) => setTimeout(r, 120));
    expect(reconnectEvents).toHaveLength(1);

    client.disconnect();
  });

  it("neg_risk trade flows through (Phase 4: filter removed, NegRiskEngine handles routing)", () => {
    const negRiskSet = new Set([tradeFixture.asset]);
    const { client, bus } = makeClient(negRiskSet);
    const received: unknown[] = [];

    bus.on("trade", (t) => received.push(t));
    client.connect();

    const ws = MockWs.instances[0];
    ws.emit("open");
    ws.emit("message", Buffer.from(JSON.stringify(tradeFixture)));

    // Phase 4: neg-risk trades are no longer filtered at ingestion
    expect(received).toHaveLength(1);
    client.disconnect();
  });

  it("valid trade fixture parsed and emitted as TradeEvent", () => {
    const { client, bus } = makeClient();
    const received: unknown[] = [];

    bus.on("trade", (t) => received.push(t));
    client.connect();

    const ws = MockWs.instances[0];
    ws.emit("open");
    ws.emit("message", Buffer.from(JSON.stringify(tradeFixture)));

    expect(received).toHaveLength(1);
    const trade = received[0] as { tokenId: string; valueUsdc: number };
    expect(trade.tokenId).toBe(tradeFixture.asset);
    expect(trade.valueUsdc).toBeCloseTo(tradeFixture.size * tradeFixture.price, 2);

    client.disconnect();
  });
});
