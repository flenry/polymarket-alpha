import { describe, it, expect } from "vitest";
import { ALERT_TRADE_JOIN_SQL } from "../lib/alert-hydration";

describe("ALERT_TRADE_JOIN_SQL", () => {
  it("contains all 6 split_part fields for the full-tuple join", () => {
    expect(ALERT_TRADE_JOIN_SQL).toContain("split_part(wa.trade_lookup_key, '|', 1)");
    expect(ALERT_TRADE_JOIN_SQL).toContain("split_part(wa.trade_lookup_key, '|', 2)");
    expect(ALERT_TRADE_JOIN_SQL).toContain("split_part(wa.trade_lookup_key, '|', 3)");
    expect(ALERT_TRADE_JOIN_SQL).toContain("split_part(wa.trade_lookup_key, '|', 4)");
    expect(ALERT_TRADE_JOIN_SQL).toContain("split_part(wa.trade_lookup_key, '|', 5)");
    expect(ALERT_TRADE_JOIN_SQL).toContain("split_part(wa.trade_lookup_key, '|', 6)");
  });

  it("joins on proxy_wallet (field 3) — not just transaction_hash + token_id", () => {
    // The partial 2-field join would only check fields 1 and 2
    // This test asserts field 3 (proxy_wallet) is present as a guard
    expect(ALERT_TRADE_JOIN_SQL).toContain("split_part(wa.trade_lookup_key, '|', 3)");
  });

  it("includes partition-pruning bound on traded_at", () => {
    expect(ALERT_TRADE_JOIN_SQL).toContain("90 days");
  });

  it("starts with LEFT JOIN trades", () => {
    expect(ALERT_TRADE_JOIN_SQL.trim()).toMatch(/^LEFT JOIN trades/i);
  });

  it("casts traded_at to timestamptz", () => {
    expect(ALERT_TRADE_JOIN_SQL).toContain("::timestamptz");
  });

  it("casts price_usdc to numeric", () => {
    expect(ALERT_TRADE_JOIN_SQL).toContain("::numeric");
  });
});
