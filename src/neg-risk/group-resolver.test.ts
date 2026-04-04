import { describe, it, expect, vi, beforeEach } from "vitest";
import { GroupResolver } from "./group-resolver.js";

// ── Helpers ───────────────────────────────────────────────────────────────────

function makeDb(rows: object[]) {
  const where = vi.fn().mockResolvedValue(rows);
  const from = vi.fn().mockReturnValue({ where });
  const select = vi.fn().mockReturnValue({ from });
  return { select } as unknown as ConstructorParameters<typeof GroupResolver>[0];
}

function makeBook(tokenId: string, asks: Array<{ price: number; size: number }>, bids: Array<{ price: number; size: number }> = []) {
  return {
    tokenId,
    conditionId: "cond1",
    bids,
    asks,
    timestamp: Date.now(),
    hash: "hash",
    capturedAt: new Date(),
  };
}

function makeClob(books: ReturnType<typeof makeBook>[]) {
  return { batchGetBooks: vi.fn().mockResolvedValue(books) } as unknown as ConstructorParameters<typeof GroupResolver>[1];
}

const rows3 = [
  { tokenId: "tok1", conditionId: "cond1", question: "Outcome A", slug: "a" },
  { tokenId: "tok2", conditionId: "cond1", question: "Outcome B", slug: "b" },
  { tokenId: "tok3", conditionId: "cond1", question: "Outcome C", slug: "c" },
];

// ── Tests ─────────────────────────────────────────────────────────────────────

describe("GroupResolver.resolveGroups", () => {
  it("valid group (3 tokens, adequate ask sizes): sumBid≤1.05, sumAsk≥0.95 and ≤1.20 → isValid=true", async () => {
    const db = makeDb(rows3);
    const books = [
      makeBook("tok1", [{ price: 0.40, size: 20 }], [{ price: 0.38, size: 20 }]),
      makeBook("tok2", [{ price: 0.35, size: 20 }], [{ price: 0.33, size: 20 }]),
      makeBook("tok3", [{ price: 0.30, size: 20 }], [{ price: 0.28, size: 20 }]),
    ];
    const clob = makeClob(books);
    const resolver = new GroupResolver(db, clob);
    const groups = await resolver.resolveGroups();
    expect(groups).toHaveLength(1);
    const g = groups[0];
    expect(g.isValid).toBe(true);
    expect(g.sumAsk).toBeCloseTo(1.05, 4);
    expect(g.sumBid).toBeCloseTo(0.99, 4);
    expect(g.tokens).toHaveLength(3);
  });

  it("invalid group — sumBid > 1.05 → isValid=false", async () => {
    const db = makeDb(rows3);
    // Bids that sum to > 1.05: 0.40+0.38+0.30 = 1.08
    const books = [
      makeBook("tok1", [{ price: 0.42, size: 20 }], [{ price: 0.40, size: 20 }]),
      makeBook("tok2", [{ price: 0.39, size: 20 }], [{ price: 0.38, size: 20 }]),
      makeBook("tok3", [{ price: 0.31, size: 20 }], [{ price: 0.30, size: 20 }]),
    ];
    const clob = makeClob(books);
    const resolver = new GroupResolver(db, clob);
    const groups = await resolver.resolveGroups();
    expect(groups[0].isValid).toBe(false);
  });

  it("invalid group — sumAsk > 1.20 (LAW-MINOR-3 upper bound) → isValid=false", async () => {
    const db = makeDb(rows3);
    // Asks sum > 1.20: 0.50+0.45+0.35 = 1.30
    const books = [
      makeBook("tok1", [{ price: 0.50, size: 20 }], [{ price: 0.48, size: 20 }]),
      makeBook("tok2", [{ price: 0.45, size: 20 }], [{ price: 0.43, size: 20 }]),
      makeBook("tok3", [{ price: 0.35, size: 20 }], [{ price: 0.33, size: 20 }]),
    ];
    const clob = makeClob(books);
    const resolver = new GroupResolver(db, clob);
    const groups = await resolver.resolveGroups();
    expect(groups[0].isValid).toBe(false);
  });

  it("invalid group — single token → isValid=false", async () => {
    const singleRow = [{ tokenId: "tok1", conditionId: "condX", question: "Only", slug: null }];
    const db = makeDb(singleRow);
    const books = [makeBook("tok1", [{ price: 0.90, size: 20 }])];
    const clob = makeClob(books);
    const resolver = new GroupResolver(db, clob);
    const groups = await resolver.resolveGroups();
    expect(groups[0].isValid).toBe(false);
    expect(groups[0].tokens).toHaveLength(1);
  });

  it("groups correctly by conditionId: 2 conditionIds → 2 groups", async () => {
    const rows = [
      { tokenId: "tok1", conditionId: "condA", question: "A1", slug: null },
      { tokenId: "tok2", conditionId: "condA", question: "A2", slug: null },
      { tokenId: "tok3", conditionId: "condB", question: "B1", slug: null },
      { tokenId: "tok4", conditionId: "condB", question: "B2", slug: null },
    ];
    const db = makeDb(rows);
    const books = [
      makeBook("tok1", [{ price: 0.50, size: 20 }], [{ price: 0.48, size: 20 }]),
      makeBook("tok2", [{ price: 0.55, size: 20 }], [{ price: 0.53, size: 20 }]),
      makeBook("tok3", [{ price: 0.45, size: 20 }], [{ price: 0.43, size: 20 }]),
      makeBook("tok4", [{ price: 0.50, size: 20 }], [{ price: 0.48, size: 20 }]),
    ];
    // clob returns all books regardless of which tokenIds are requested
    const clob = { batchGetBooks: vi.fn()
      .mockResolvedValueOnce([books[0], books[1]])
      .mockResolvedValueOnce([books[2], books[3]]) } as unknown as ConstructorParameters<typeof GroupResolver>[1];

    const resolver = new GroupResolver(db, clob);
    const groups = await resolver.resolveGroups();
    expect(groups).toHaveLength(2);
    const condIds = groups.map((g) => g.conditionId).sort();
    expect(condIds).toEqual(["condA", "condB"]);
  });

  it("empty book for a token: defaults to bestBid=0, bestAsk=1.0", async () => {
    const rows = [
      { tokenId: "tok1", conditionId: "cond1", question: "Q", slug: null },
      { tokenId: "tok2", conditionId: "cond1", question: "Q", slug: null },
    ];
    const db = makeDb(rows);
    // tok2 has no book returned
    const books = [makeBook("tok1", [{ price: 0.55, size: 20 }], [{ price: 0.53, size: 20 }])];
    const clob = makeClob(books);
    const resolver = new GroupResolver(db, clob);
    const groups = await resolver.resolveGroups();
    const tok2 = groups[0].tokens.find((t) => t.tokenId === "tok2")!;
    expect(tok2.bestAsk).toBe(1.0);
    expect(tok2.bestBid).toBe(0);
  });

  it("dust quote filter: ask with size < 10 skipped, walk to next level", async () => {
    const rows = [
      { tokenId: "tok1", conditionId: "cond1", question: "Q", slug: null },
      { tokenId: "tok2", conditionId: "cond1", question: "Q", slug: null },
    ];
    const db = makeDb(rows);
    const books = [
      makeBook(
        "tok1",
        // First ask has size=2 (dust), second has size=15 (tradeable)
        [{ price: 0.40, size: 2 }, { price: 0.45, size: 15 }],
        [{ price: 0.38, size: 20 }]
      ),
      makeBook("tok2", [{ price: 0.60, size: 20 }], [{ price: 0.58, size: 20 }]),
    ];
    const clob = makeClob(books);
    const resolver = new GroupResolver(db, clob);
    const groups = await resolver.resolveGroups();
    const tok1 = groups[0].tokens.find((t) => t.tokenId === "tok1")!;
    // Should use the 0.45 price (size 15 ≥ 10), not 0.40 (size 2)
    expect(tok1.bestAsk).toBeCloseTo(0.45, 4);
  });

  it("dust quote filter: no tradeable ask on ladder → bestAsk=1.0", async () => {
    const rows = [
      { tokenId: "tok1", conditionId: "cond1", question: "Q", slug: null },
      { tokenId: "tok2", conditionId: "cond1", question: "Q", slug: null },
    ];
    const db = makeDb(rows);
    const books = [
      makeBook("tok1", [{ price: 0.40, size: 5 }, { price: 0.45, size: 5 }]),  // all dust
      makeBook("tok2", [{ price: 0.60, size: 20 }]),
    ];
    const clob = makeClob(books);
    const resolver = new GroupResolver(db, clob);
    const groups = await resolver.resolveGroups();
    const tok1 = groups[0].tokens.find((t) => t.tokenId === "tok1")!;
    expect(tok1.bestAsk).toBe(1.0);
  });

  it("valid group at sumAsk boundary: sumAsk=1.20 → isValid=true; 1.21 → isValid=false", async () => {
    const rows = [
      { tokenId: "tok1", conditionId: "cond1", question: "Q", slug: null },
      { tokenId: "tok2", conditionId: "cond1", question: "Q", slug: null },
    ];
    const db1 = makeDb(rows);
    // sumAsk = 0.60 + 0.60 = 1.20 exactly; sumBid = 0.50 + 0.50 = 1.00 ≤ 1.05
    const books120 = [
      makeBook("tok1", [{ price: 0.60, size: 20 }], [{ price: 0.50, size: 20 }]),
      makeBook("tok2", [{ price: 0.60, size: 20 }], [{ price: 0.50, size: 20 }]),
    ];
    const clob1 = makeClob(books120);
    const r1 = new GroupResolver(db1, clob1);
    const g1 = await r1.resolveGroups();
    expect(g1[0].sumAsk).toBeCloseTo(1.20, 4);
    expect(g1[0].isValid).toBe(true);

    const db2 = makeDb(rows);
    // sumAsk = 0.61 + 0.61 = 1.22 > 1.20
    const books121 = [
      makeBook("tok1", [{ price: 0.61, size: 20 }], [{ price: 0.59, size: 20 }]),
      makeBook("tok2", [{ price: 0.61, size: 20 }], [{ price: 0.59, size: 20 }]),
    ];
    const clob2 = makeClob(books121);
    const r2 = new GroupResolver(db2, clob2);
    const g2 = await r2.resolveGroups();
    expect(g2[0].sumAsk).toBeGreaterThan(1.20);
    expect(g2[0].isValid).toBe(false);
  });

  it("returns empty array when no neg-risk markets in DB", async () => {
    const db = makeDb([]);
    const clob = makeClob([]);
    const resolver = new GroupResolver(db, clob);
    const groups = await resolver.resolveGroups();
    expect(groups).toHaveLength(0);
  });
});
