import {
  pgTable,
  text,
  integer,
  bigint,
  numeric,
  boolean,
  timestamp,
  jsonb,
  index,
  varchar,
  smallint,
} from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";

// ─────────────────────────────────────────────────────────────────────────────
// MARKETS — one row per outcome token (Yes/No = 2 rows per binary market)
// ─────────────────────────────────────────────────────────────────────────────
export const markets = pgTable(
  "markets",
  {
    tokenId: varchar("token_id", { length: 80 }).primaryKey(),
    conditionId: varchar("condition_id", { length: 66 }).notNull(),
    gammaMarketId: varchar("gamma_market_id", { length: 20 }),

    question: text("question").notNull().default(""),
    slug: varchar("slug", { length: 200 }),
    eventSlug: varchar("event_slug", { length: 200 }),
    category: varchar("category", { length: 100 }),
    outcome: varchar("outcome", { length: 50 }).notNull().default(""),
    outcomeIndex: smallint("outcome_index").notNull().default(0),

    minimumOrderSize: numeric("minimum_order_size", { precision: 18, scale: 6 }),
    minimumTickSize: numeric("minimum_tick_size", { precision: 10, scale: 6 }),

    // negRisk: true → excluded from watchlist and signal processing in Phase 1
    negRisk: boolean("neg_risk").default(false),
    watchlisted: boolean("watchlisted").default(false),

    acceptingOrders: boolean("accepting_orders").default(false),
    active: boolean("active").default(true),
    closed: boolean("closed").default(false),

    endDate: timestamp("end_date", { withTimezone: true }),
    closedTime: timestamp("closed_time", { withTimezone: true }),
    winner: boolean("winner"),

    iconUrl: text("icon_url"),
    createdAt: timestamp("created_at", { withTimezone: true })
      .default(sql`NOW()`)
      .notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .default(sql`NOW()`)
      .notNull(),
  },
  (t) => ({
    conditionIdx: index("markets_condition_id_idx").on(t.conditionId),
    activeWatchlistIdx: index("markets_active_watchlist_idx").on(t.active, t.watchlisted),
    negRiskIdx: index("markets_neg_risk_idx").on(t.negRisk),
    slugIdx: index("markets_slug_idx").on(t.slug),
  })
);

// ─────────────────────────────────────────────────────────────────────────────
// MARKET_STATS — aggregated stats per market
// ─────────────────────────────────────────────────────────────────────────────
export const marketStats = pgTable(
  "market_stats",
  {
    tokenId: varchar("token_id", { length: 80 })
      .primaryKey()
      .references(() => markets.tokenId),
    conditionId: varchar("condition_id", { length: 66 }).notNull(),

    bestBid: numeric("best_bid", { precision: 10, scale: 6 }),
    bestAsk: numeric("best_ask", { precision: 10, scale: 6 }),
    mid: numeric("mid", { precision: 10, scale: 6 }),
    spread: numeric("spread", { precision: 10, scale: 6 }),
    lastTradePrice: numeric("last_trade_price", { precision: 10, scale: 6 }),

    volume24hr: numeric("volume_24hr", { precision: 20, scale: 6 }),
    volume1wk: numeric("volume_1wk", { precision: 20, scale: 6 }),
    volume1mo: numeric("volume_1mo", { precision: 20, scale: 6 }),
    volumeTotal: numeric("volume_total", { precision: 20, scale: 6 }),
    liquidityUsdc: numeric("liquidity_usdc", { precision: 20, scale: 6 }),
    openInterest: numeric("open_interest", { precision: 20, scale: 6 }),

    // Used by WhaleDetector — computed via stats bootstrap + rolling accumulation
    avgTradeSize24h: numeric("avg_trade_size_24h", { precision: 20, scale: 6 }),
    stddevTradeSize24h: numeric("stddev_trade_size_24h", { precision: 20, scale: 6 }),

    // calibrated=false when tradeCount24h < 30 — sigma branch suppressed in WhaleDetector
    calibrated: boolean("calibrated").default(false).notNull(),
    bootstrapTradeCount: integer("bootstrap_trade_count").default(0),
    tradeCount24h: integer("trade_count_24h").default(0),

    oneDayPriceChange: numeric("one_day_price_change", { precision: 10, scale: 6 }),
    oneHourPriceChange: numeric("one_hour_price_change", { precision: 10, scale: 6 }),
    oneWeekPriceChange: numeric("one_week_price_change", { precision: 10, scale: 6 }),
    competitive: numeric("competitive", { precision: 10, scale: 4 }),

    refreshedAt: timestamp("refreshed_at", { withTimezone: true })
      .default(sql`NOW()`)
      .notNull(),
  },
  (t) => ({
    conditionIdx: index("market_stats_condition_id_idx").on(t.conditionId),
    volumeIdx: index("market_stats_volume_idx").on(t.volume24hr),
  })
);

// ─────────────────────────────────────────────────────────────────────────────
// TRADES — template table; partition migration converts to PARTITION BY RANGE
//
// IMPORTANT: Drizzle schema is the column/index template only.
// The raw migration in drizzle/0002_partition_trades.sql:
//   1. Renames this to trades_legacy
//   2. Creates a new PARTITION BY RANGE (traded_at) table with PRIMARY KEY (id, traded_at)
//   3. Creates unique index for dedup: (transaction_hash, token_id, proxy_wallet, traded_at, price_usdc, size_tokens)
//   4. Migrates data and drops legacy table
//
// DO NOT add PRIMARY KEY in this Drizzle schema — it will be recreated
// with the partition key included in the raw migration.
// ─────────────────────────────────────────────────────────────────────────────
export const trades = pgTable(
  "trades",
  {
    id: bigint("id", { mode: "number" }).notNull(),

    tokenId: varchar("token_id", { length: 80 }).notNull(),
    conditionId: varchar("condition_id", { length: 66 }).notNull(),
    outcome: varchar("outcome", { length: 50 }).notNull().default(""),

    side: varchar("side", { length: 4 }).notNull(), // "BUY" | "SELL"
    sizeTokens: numeric("size_tokens", { precision: 20, scale: 6 }).notNull(),
    priceUsdc: numeric("price_usdc", { precision: 10, scale: 6 }).notNull(),
    valueUsdc: numeric("value_usdc", { precision: 20, scale: 6 }).notNull(),

    proxyWallet: varchar("proxy_wallet", { length: 42 }).notNull(),

    // Non-unique: multiple trade rows can share a tx hash (partial fills).
    // Dedup: unique index on (transaction_hash, token_id, proxy_wallet, traded_at, price_usdc, size_tokens)
    transactionHash: varchar("transaction_hash", { length: 66 }).notNull(),
    tradedAt: timestamp("traded_at", { withTimezone: true }).notNull(),

    marketSlug: varchar("market_slug", { length: 200 }),
    eventSlug: varchar("event_slug", { length: 200 }),
    marketTitle: text("market_title"),
    traderName: varchar("trader_name", { length: 100 }),
    traderPseudonym: varchar("trader_pseudonym", { length: 100 }),

    source: varchar("source", { length: 20 }).default("live_ws"),
    createdAt: timestamp("created_at", { withTimezone: true })
      .default(sql`NOW()`)
      .notNull(),
  },
  (t) => ({
    // Non-unique index on tx hash — dedup is via DB unique composite index
    txHashIdx: index("trades_tx_hash_idx").on(t.transactionHash),
    tokenTimeIdx: index("trades_token_time_idx").on(t.tokenId, t.tradedAt),
    conditionTimeIdx: index("trades_condition_time_idx").on(t.conditionId, t.tradedAt),
    walletIdx: index("trades_wallet_idx").on(t.proxyWallet),
    valueIdx: index("trades_value_idx").on(t.valueUsdc),
    timeIdx: index("trades_time_idx").on(t.tradedAt),
  })
);

// ─────────────────────────────────────────────────────────────────────────────
// ORDER_BOOK_SNAPSHOTS — template; same partition strategy as trades
//
// See TRADES comment above. Raw migration converts this to
// PARTITION BY RANGE (captured_at) with PRIMARY KEY (id, captured_at).
// ─────────────────────────────────────────────────────────────────────────────
export const orderBookSnapshots = pgTable(
  "order_book_snapshots",
  {
    id: bigint("id", { mode: "number" }).notNull(),

    tokenId: varchar("token_id", { length: 80 }).notNull(),
    conditionId: varchar("condition_id", { length: 66 }).notNull(),

    // Top 20 levels per side: [{ price: string, size: string }]
    bids: jsonb("bids").notNull(),
    asks: jsonb("asks").notNull(),

    bidDepthUsdc: numeric("bid_depth_usdc", { precision: 20, scale: 2 }),
    askDepthUsdc: numeric("ask_depth_usdc", { precision: 20, scale: 2 }),
    imbalanceRatio: numeric("imbalance_ratio", { precision: 10, scale: 4 }),
    mid: numeric("mid", { precision: 10, scale: 6 }),
    spread: numeric("spread", { precision: 10, scale: 6 }),
    bookHash: varchar("book_hash", { length: 40 }),

    // "rest_timer" (Phase 1) | "ws_event" (Phase 2+)
    snapshotTrigger: varchar("snapshot_trigger", { length: 20 }),
    capturedAt: timestamp("captured_at", { withTimezone: true }).notNull(),
  },
  (t) => ({
    tokenTimeIdx: index("obs_token_time_idx").on(t.tokenId, t.capturedAt),
    conditionIdx: index("obs_condition_idx").on(t.conditionId),
    imbalanceIdx: index("obs_imbalance_idx").on(t.imbalanceRatio),
  })
);

// ─────────────────────────────────────────────────────────────────────────────
// PRICE_HISTORY — lightweight price series for velocity calculations
// ─────────────────────────────────────────────────────────────────────────────
export const priceHistory = pgTable(
  "price_history",
  {
    id: bigint("id", { mode: "number" })
      .primaryKey()
      .generatedAlwaysAsIdentity(),

    tokenId: varchar("token_id", { length: 80 }).notNull(),
    conditionId: varchar("condition_id", { length: 66 }).notNull(),

    price: numeric("price", { precision: 10, scale: 6 }).notNull(),
    side: varchar("side", { length: 4 }),
    // "last_trade" | "best_bid" | "best_ask" | "mid"
    eventType: varchar("event_type", { length: 30 }).notNull(),

    recordedAt: timestamp("recorded_at", { withTimezone: true }).notNull(),
  },
  (t) => ({
    tokenTimeIdx: index("ph_token_time_idx").on(t.tokenId, t.recordedAt),
    conditionIdx: index("ph_condition_idx").on(t.conditionId),
    recentIdx: index("ph_recent_idx").on(t.recordedAt),
  })
);

// ─────────────────────────────────────────────────────────────────────────────
// WHALE_ALERTS — detected big bets (permanent retention)
//
// Law finding: FK to trades.id removed (FK across partition boundary unsupported).
// Use tradeLookupKey (serialized dedup key) for app-layer join instead.
// tradeLookupKey format: "txHash|tokenId|proxyWallet|tradedAt|priceUsdc|sizeTokens"
// ─────────────────────────────────────────────────────────────────────────────
export const whaleAlerts = pgTable(
  "whale_alerts",
  {
    id: bigint("id", { mode: "number" })
      .primaryKey()
      .generatedAlwaysAsIdentity(),

    // App-layer join key (no FK to partitioned trades table)
    tradeLookupKey: varchar("trade_lookup_key", { length: 200 }).notNull(),

    tokenId: varchar("token_id", { length: 80 }).notNull(),
    conditionId: varchar("condition_id", { length: 66 }).notNull(),

    usdcValue: numeric("usdc_value", { precision: 20, scale: 2 }).notNull(),

    // Threshold state at detection time
    absoluteMinUsdc: integer("absolute_min_usdc").notNull(),
    avgTradeSize24hAtAlert: numeric("avg_trade_size_24h_at_alert", { precision: 20, scale: 6 }),
    stddev24hAtAlert: numeric("stddev_24h_at_alert", { precision: 20, scale: 6 }),
    volume24hAtAlert: numeric("volume_24h_at_alert", { precision: 20, scale: 6 }),
    sigmasAboveMean: numeric("sigmas_above_mean", { precision: 8, scale: 4 }),
    pctOfDailyVolume: numeric("pct_of_daily_volume", { precision: 8, scale: 4 }),

    priceAtAlert: numeric("price_at_alert", { precision: 10, scale: 6 }),
    priceImpactEstimateUsdc: numeric("price_impact_estimate_usdc", { precision: 10, scale: 6 }),
    bookDepthConsumedPct: numeric("book_depth_consumed_pct", { precision: 6, scale: 2 }),
    bookSnapshotAgeMs: integer("book_snapshot_age_ms"),

    // Wallet enrichment (filled async)
    walletTotalVolumeUsdc: numeric("wallet_total_volume_usdc", { precision: 20, scale: 2 }),
    walletTradeCount: integer("wallet_trade_count"),
    walletFirstSeenAt: timestamp("wallet_first_seen_at", { withTimezone: true }),
    walletWinRatio: numeric("wallet_win_ratio", { precision: 6, scale: 4 }),
    enrichedAt: timestamp("enriched_at", { withTimezone: true }),

    alertedAt: timestamp("alerted_at", { withTimezone: true })
      .default(sql`NOW()`)
      .notNull(),
  },
  (t) => ({
    tokenTimeIdx: index("wa_token_time_idx").on(t.tokenId, t.alertedAt),
    valueIdx: index("wa_value_idx").on(t.usdcValue),
    conditionIdx: index("wa_condition_idx").on(t.conditionId),
    lookupKeyIdx: index("wa_lookup_key_idx").on(t.tradeLookupKey),
  })
);

// ─────────────────────────────────────────────────────────────────────────────
// SIGNALS — all computed alpha signals (permanent retention)
// signalType constrained to SIGNAL_TYPES union via app-layer Zod validation.
// ─────────────────────────────────────────────────────────────────────────────
export const signals = pgTable(
  "signals",
  {
    id: bigint("id", { mode: "number" })
      .primaryKey()
      .generatedAlwaysAsIdentity(),

    tokenId: varchar("token_id", { length: 80 }).notNull(),
    conditionId: varchar("condition_id", { length: 66 }).notNull(),

    // Must be one of the four SignalType values
    signalType: varchar("signal_type", { length: 40 }).notNull(),
    // "WHALE_TRADE" | "ORDER_BOOK_IMBALANCE" | "PRICE_IMPACT_ANOMALY" | "SENTIMENT_VELOCITY"

    direction: varchar("direction", { length: 10 }),
    confidence: numeric("confidence", { precision: 6, scale: 4 }).notNull(),
    strength: numeric("strength", { precision: 10, scale: 4 }),

    priceAtSignal: numeric("price_at_signal", { precision: 10, scale: 6 }),
    spreadAtSignal: numeric("spread_at_signal", { precision: 10, scale: 6 }),
    volumeAtSignal: numeric("volume_at_signal", { precision: 20, scale: 6 }),

    whaleAlertId: bigint("whale_alert_id", { mode: "number" }).references(
      () => whaleAlerts.id
    ),
    orderBookSnapshotId: bigint("order_book_snapshot_id", { mode: "number" }),

    payload: jsonb("payload"),

    createdAt: timestamp("created_at", { withTimezone: true })
      .default(sql`NOW()`)
      .notNull(),
  },
  (t) => ({
    tokenTimeIdx: index("signals_token_time_idx").on(t.tokenId, t.createdAt),
    typeTimeIdx: index("signals_type_time_idx").on(t.signalType, t.createdAt),
    confidenceIdx: index("signals_confidence_idx").on(t.confidence),
    conditionIdx: index("signals_condition_idx").on(t.conditionId),
  })
);

// ─────────────────────────────────────────────────────────────────────────────
// WALLET_PROFILES — enriched whale wallet history
// ─────────────────────────────────────────────────────────────────────────────
export const walletProfiles = pgTable(
  "wallet_profiles",
  {
    proxyWallet: varchar("proxy_wallet", { length: 42 }).primaryKey(),

    totalVolumeUsdc: numeric("total_volume_usdc", { precision: 20, scale: 2 }),
    tradeCount: integer("trade_count").default(0),
    whaleTradeCount: integer("whale_trade_count").default(0),
    firstSeenAt: timestamp("first_seen_at", { withTimezone: true }),
    lastSeenAt: timestamp("last_seen_at", { withTimezone: true }),

    resolvedTradeCount: integer("resolved_trade_count").default(0),
    winCount: integer("win_count").default(0),
    winRatio: numeric("win_ratio", { precision: 6, scale: 4 }),

    displayName: varchar("display_name", { length: 100 }),
    pseudonym: varchar("pseudonym", { length: 100 }),

    lastEnrichedAt: timestamp("last_enriched_at", { withTimezone: true }),
    enrichmentVersion: smallint("enrichment_version").default(0),
  },
  (t) => ({
    volumeIdx: index("wp_volume_idx").on(t.totalVolumeUsdc),
    winRatioIdx: index("wp_win_ratio_idx").on(t.winRatio),
  })
);
