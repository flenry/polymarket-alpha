import { describe, it, expect, vi } from "vitest";
import { upsertMarketStats, getWatchlistedTokenIds, getNegRiskTokenIds, getMarketStats } from "./markets.js";

function makeInsertDb() {
  const onConflictDoUpdate = vi.fn().mockResolvedValue(undefined);
  const values = vi.fn().mockReturnValue({ onConflictDoUpdate });
  const insert = vi.fn().mockReturnValue({ values });
  return {
    insert,
    _values: values,
    _onConflictDoUpdate: onConflictDoUpdate,
  } as unknown as Parameters<typeof upsertMarketStats>[0];
}

/** Build a db mock that returns `rows` from a select chain */
function makeSelectDb(rows: object[]) {
  // For getWatchlistedTokenIds / getNegRiskTokenIds: select().from().where() resolves directly
  // For getMarketStats: select().from().where().limit(1) resolves
  const limit = vi.fn().mockResolvedValue(rows);
  const orderBy = vi.fn().mockReturnValue({ limit });
  // where() can be called as a promise (for direct resolution) AND chain to .limit()
  const whereResult = { limit, orderBy, then: undefined as unknown };
  // Make whereResult thenable so `await where()` works:
  // Actually, mock it to resolve when used with await
  const where = vi.fn().mockReturnValue(Object.assign(
    Promise.resolve(rows),
    { limit, orderBy }
  ));
  const from = vi.fn().mockReturnValue({ where });
  const select = vi.fn().mockReturnValue({ from });
  const onConflictDoUpdate = vi.fn().mockResolvedValue(undefined);
  const values = vi.fn().mockReturnValue({ onConflictDoUpdate });
  const insert = vi.fn().mockReturnValue({ values });
  return { select, insert } as unknown as Parameters<typeof getWatchlistedTokenIds>[0];
}

describe("upsertMarketStats", () => {
  it("sets calibrated=false when tradeCount24h=15", async () => {
    const db = makeInsertDb();
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
    const db = makeInsertDb();
    await upsertMarketStats(db, {
      tokenId: "tok1",
      conditionId: "cond1",
      tradeCount24h: 35,
      volume24hr: 100000,
    });

    const valuesCall = (db as unknown as { _values: ReturnType<typeof vi.fn> })._values.mock.calls[0][0];
    expect(valuesCall.calibrated).toBe(true);
  });

  it("sets calibrated=true when tradeCount24h=30 (boundary)", async () => {
    const db = makeInsertDb();
    await upsertMarketStats(db, {
      tokenId: "tok1",
      conditionId: "cond1",
      tradeCount24h: 30,
    });

    const valuesCall = (db as unknown as { _values: ReturnType<typeof vi.fn> })._values.mock.calls[0][0];
    expect(valuesCall.calibrated).toBe(true);
  });

  it("defaults tradeCount24h to 0 when not provided", async () => {
    const db = makeInsertDb();
    await upsertMarketStats(db, {
      tokenId: "tok1",
      conditionId: "cond1",
    });

    const valuesCall = (db as unknown as { _values: ReturnType<typeof vi.fn> })._values.mock.calls[0][0];
    expect(valuesCall.tradeCount24h).toBe(0);
    expect(valuesCall.calibrated).toBe(false);
  });
});

describe("getWatchlistedTokenIds", () => {
  it("returns tokenIds from rows", async () => {
    const db = makeSelectDb([{ tokenId: "tok1" }, { tokenId: "tok2" }]);
    const result = await getWatchlistedTokenIds(db);
    expect(result).toEqual(["tok1", "tok2"]);
  });

  it("returns empty array when no watchlisted markets", async () => {
    const db = makeSelectDb([]);
    const result = await getWatchlistedTokenIds(db);
    expect(result).toEqual([]);
  });
});

describe("getNegRiskTokenIds", () => {
  it("returns tokenIds of neg_risk markets", async () => {
    const db = makeSelectDb([{ tokenId: "neg-tok1" }]);
    const result = await getNegRiskTokenIds(db);
    expect(result).toEqual(["neg-tok1"]);
  });

  it("returns empty array when no neg_risk markets", async () => {
    const db = makeSelectDb([]);
    const result = await getNegRiskTokenIds(db);
    expect(result).toEqual([]);
  });
});

describe("getMarketStats", () => {
  it("returns the first row when found", async () => {
    const row = { tokenId: "tok1", conditionId: "cond1", volume24hr: "100000" };
    const db = makeSelectDb([row]);
    const result = await getMarketStats(db, "tok1");
    expect(result).toEqual(row);
  });

  it("returns null when no row found", async () => {
    const db = makeSelectDb([]);
    const result = await getMarketStats(db, "tok-unknown");
    expect(result).toBeNull();
  });
});
