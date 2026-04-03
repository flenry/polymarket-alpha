import { describe, it, expect, vi } from "vitest";
import { upsertWalletProfile, getWalletProfile } from "./wallets.js";

function makeUpsertDb() {
  const onConflictDoUpdate = vi.fn().mockResolvedValue(undefined);
  const values = vi.fn().mockReturnValue({ onConflictDoUpdate });
  const insert = vi.fn().mockReturnValue({ values });
  return {
    insert,
    _values: values,
    _onConflictDoUpdate: onConflictDoUpdate,
  } as unknown as Parameters<typeof upsertWalletProfile>[0];
}

function makeSelectDb(rows: object[]) {
  const limit = vi.fn().mockResolvedValue(rows);
  const where = vi.fn().mockReturnValue({ limit });
  const from = vi.fn().mockReturnValue({ where });
  const select = vi.fn().mockReturnValue({ from });
  return { select } as unknown as Parameters<typeof getWalletProfile>[0];
}

const sampleProfile = {
  proxyWallet: "0xabc123",
  totalVolumeUsdc: 500_000,
  tradeCount: 120,
  whaleTradeCount: 5,
  firstSeenAt: new Date("2026-01-01T00:00:00.000Z"),
  lastSeenAt: new Date("2026-04-01T00:00:00.000Z"),
};

describe("upsertWalletProfile", () => {
  it("calls insert with correct field mapping", async () => {
    const db = makeUpsertDb();
    await upsertWalletProfile(db, sampleProfile);
    expect(db.insert).toHaveBeenCalledOnce();
    const valuesCall = (db as unknown as { _values: ReturnType<typeof vi.fn> })._values.mock
      .calls[0][0];
    expect(valuesCall.proxyWallet).toBe("0xabc123");
    expect(valuesCall.totalVolumeUsdc).toBe("500000");
    expect(valuesCall.tradeCount).toBe(120);
    expect(valuesCall.whaleTradeCount).toBe(5);
    expect(valuesCall.firstSeenAt).toEqual(sampleProfile.firstSeenAt);
    expect(valuesCall.lastSeenAt).toEqual(sampleProfile.lastSeenAt);
  });

  it("onConflictDoUpdate sets correct update fields", async () => {
    const db = makeUpsertDb();
    await upsertWalletProfile(db, sampleProfile);
    const onConflict = (
      db as unknown as { _onConflictDoUpdate: ReturnType<typeof vi.fn> }
    )._onConflictDoUpdate;
    expect(onConflict).toHaveBeenCalledOnce();
    const setArg = onConflict.mock.calls[0][0].set;
    expect(setArg.totalVolumeUsdc).toBe("500000");
    expect(setArg.tradeCount).toBe(120);
    expect(setArg.whaleTradeCount).toBe(5);
  });

  it("sets lastEnrichedAt to a Date", async () => {
    const db = makeUpsertDb();
    await upsertWalletProfile(db, sampleProfile);
    const valuesCall = (db as unknown as { _values: ReturnType<typeof vi.fn> })._values.mock
      .calls[0][0];
    expect(valuesCall.lastEnrichedAt).toBeInstanceOf(Date);
  });
});

describe("getWalletProfile", () => {
  it("returns null when no row found", async () => {
    const db = makeSelectDb([]);
    const result = await getWalletProfile(db, "0xabc123");
    expect(result).toBeNull();
  });

  it("returns mapped row when found", async () => {
    const row = {
      proxyWallet: "0xabc123",
      totalVolumeUsdc: "500000.00",
      tradeCount: 120,
      whaleTradeCount: 5,
      firstSeenAt: new Date("2026-01-01T00:00:00.000Z"),
      lastSeenAt: new Date("2026-04-01T00:00:00.000Z"),
      lastEnrichedAt: new Date("2026-04-03T00:00:00.000Z"),
    };
    const db = makeSelectDb([row]);
    const result = await getWalletProfile(db, "0xabc123");
    expect(result).not.toBeNull();
    expect(result!.proxyWallet).toBe("0xabc123");
    expect(result!.totalVolumeUsdc).toBe(500_000);
    expect(result!.tradeCount).toBe(120);
    expect(result!.lastEnrichedAt).toEqual(row.lastEnrichedAt);
  });

  it("returns null totalVolumeUsdc when DB column is null", async () => {
    const row = {
      proxyWallet: "0xabc123",
      totalVolumeUsdc: null,
      tradeCount: 0,
      whaleTradeCount: 0,
      firstSeenAt: null,
      lastSeenAt: null,
      lastEnrichedAt: null,
    };
    const db = makeSelectDb([row]);
    const result = await getWalletProfile(db, "0xabc123");
    expect(result!.totalVolumeUsdc).toBeNull();
  });
});
