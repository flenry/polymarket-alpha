import { describe, it, expect, beforeAll, afterAll, vi } from "vitest";
import { formatUSDC, formatAddress, timeAgo } from "../lib/utils";

describe("formatUSDC", () => {
  it("formats large values with 0 decimals", () => {
    expect(formatUSDC(127400)).toBe("$127,400");
  });

  it("formats values ≥1000 with 0 decimals", () => {
    expect(formatUSDC(1000)).toBe("$1,000");
  });

  it("formats values <1000 with 2 decimals", () => {
    expect(formatUSDC(500.5)).toBe("$500.50");
  });

  it("formats zero with 2 decimals", () => {
    expect(formatUSDC(0)).toBe("$0.00");
  });

  it("returns — for null", () => {
    expect(formatUSDC(null)).toBe("—");
  });

  it("returns — for undefined", () => {
    expect(formatUSDC(undefined)).toBe("—");
  });

  it("formats 999.99 with 2 decimals", () => {
    expect(formatUSDC(999.99)).toBe("$999.99");
  });
});

describe("formatAddress", () => {
  it("truncates a long address to first 6 + last 4 chars", () => {
    const addr = "0xABCDEF1234567890abcdef1234";
    const result = formatAddress(addr);
    expect(result).toBe("0xABCD…1234");
  });

  it("returns address unchanged if ≤12 chars", () => {
    expect(formatAddress("0xABCD")).toBe("0xABCD");       // 6 chars
    expect(formatAddress("0x1234567890")).toBe("0x1234567890"); // exactly 12 chars
  });

  it("returns — for null", () => {
    expect(formatAddress(null)).toBe("—");
  });

  it("returns — for undefined", () => {
    expect(formatAddress(undefined)).toBe("—");
  });

  it("truncates exactly 13-char address", () => {
    const addr = "0x12345678901";
    // length is 13, > 12, so truncated
    const result = formatAddress(addr);
    expect(result).toBe(`${addr.slice(0, 6)}…${addr.slice(-4)}`);
  });
});

describe("timeAgo", () => {
  beforeAll(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2024-01-01T12:00:00Z"));
  });

  afterAll(() => {
    vi.useRealTimers();
  });

  it('returns "just now" for recent dates (<30s)', () => {
    const d = new Date("2024-01-01T11:59:45Z"); // 15s ago
    expect(timeAgo(d)).toBe("just now");
  });

  it('returns "N min ago" for dates 30s–1h ago', () => {
    const d = new Date("2024-01-01T11:58:30Z"); // 90s ago
    expect(timeAgo(d)).toBe("1 min ago");
  });

  it('returns "Nh ago" for dates 1h–24h ago', () => {
    const d = new Date("2024-01-01T09:30:00Z"); // 2.5h ago
    expect(timeAgo(d)).toBe("2h ago");
  });

  it('returns "Nd ago" for dates ≥24h ago', () => {
    const d = new Date("2023-12-30T12:00:00Z"); // 2d ago
    expect(timeAgo(d)).toBe("2d ago");
  });

  it("accepts string date", () => {
    expect(timeAgo("2024-01-01T11:59:45Z")).toBe("just now");
  });

  it("returns — for null", () => {
    expect(timeAgo(null)).toBe("—");
  });

  it("returns — for undefined", () => {
    expect(timeAgo(undefined)).toBe("—");
  });

  it("returns — for invalid date string", () => {
    expect(timeAgo("not-a-date")).toBe("—");
  });
});
