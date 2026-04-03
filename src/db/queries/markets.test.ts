import { describe, it, expect, vi } from "vitest";
import { upsertMarketStats } from "./markets.js";

function makeDb(overrides: { execute?: ReturnType<typeof vi.fn>; insert?: ReturnType<typeof vi.fn> } = {}) {
  const onConflictDoUpdate = vi.fn().mockResolvedValue(undefined);
  const values = vi.fn().mockReturnValue({ onConflictDoUpdate });
  const insert = vi.fn().mockReturnValue({ values });
  return {
    insert,
    _values: values,
    _onConflictDoUpdate: onConflictDoUpdate,
    ...overrides,
  } as unknown as Parameters<typeof upsertMarketStats>[0];
}

describe("upsertMarketStats", () => {
  it("sets calibrated=false when tradeCount24h=15", async () => {
    const db = makeDb();
    await upsertMarketStats(db, {
      tokenId: "tok1",
      conditionId: "cond1",
      tradeCount24h: 15,
      volume24hr: 100000,
    });

    const valuesCall = (db as unknown as { _values: ReturnType<typeof vi.fn> })._values.mock.calls[0][0];
    expect(valuesCall.calibrated).toBe(false);
    expect(valuesCall.tradeCount24h).toBe(15);
  });

  it("sets calibrated=true when tradeCount24h=35", async () => {
    const db = makeDb();
    await upsertMarketStats(db, {
      tokenId: "tok1",
      conditionId: "cond1",
      tradeCount24h: 35,
      volume24hr: 100000,
    });

    const valuesCall = (db as unknown as { _values: ReturnType<typeof vi.fn> })._values.mock.calls[0][0];
    expect(valuesCall.calibrated).toBe(true);
  });

  it("sets calibrated=false when tradeCount24h=30 (boundary — 30 is true)", async () => {
    const db = makeDb();
    await upsertMarketStats(db, {
      tokenId: "tok1",
      conditionId: "cond1",
      tradeCount24h: 30,
    });

    const valuesCall = (db as unknown as { _values: ReturnType<typeof vi.fn> })._values.mock.calls[0][0];
    expect(valuesCall.calibrated).toBe(true);
  });

  it("defaults tradeCount24h to 0 when not provided", async () => {
    const db = makeDb();
    await upsertMarketStats(db, {
      tokenId: "tok1",
      conditionId: "cond1",
    });

    const valuesCall = (db as unknown as { _values: ReturnType<typeof vi.fn> })._values.mock.calls[0][0];
    expect(valuesCall.tradeCount24h).toBe(0);
    expect(valuesCall.calibrated).toBe(false);
  });
});
