import { z } from "zod";

// ─── Gamma API ────────────────────────────────────────────────────────────────
export const ZGammaMarket = z
  .object({
    id: z.string().optional(),
    conditionId: z.string(),
    clobTokenIds: z.array(z.string()).optional(),
    question: z.string().optional().default(""),
    slug: z.string().optional().nullable(),
    eventSlug: z.string().optional().nullable(),
    category: z.string().optional().nullable(),
    outcomes: z.string().optional().nullable(), // JSON string
    outcomePrices: z.string().optional().nullable(), // JSON string
    bestBid: z.coerce.number().optional().nullable(),
    bestAsk: z.coerce.number().optional().nullable(),
    spread: z.coerce.number().optional().nullable(),
    lastTradePrice: z.coerce.number().optional().nullable(),
    volume: z.coerce.number().optional().nullable(),
    volume24hr: z.coerce.number().optional().nullable(),
    volume1wk: z.coerce.number().optional().nullable(),
    liquidity: z.coerce.number().optional().nullable(),
    oneDayPriceChange: z.coerce.number().optional().nullable(),
    negRisk: z.boolean().optional().default(false),
    active: z.boolean().optional().default(true),
    closed: z.boolean().optional().default(false),
    acceptingOrders: z.boolean().optional().nullable(),
    endDateIso: z.string().optional().nullable(),
    startDateIso: z.string().optional().nullable(),
    minimumOrderSize: z.coerce.number().optional().nullable(),
    minimumTickSize: z.coerce.number().optional().nullable(),
    icon: z.string().optional().nullable(),
    image: z.string().optional().nullable(),
    description: z.string().optional().nullable(),
  })
  .passthrough()
  .strip();

export type GammaMarket = z.infer<typeof ZGammaMarket>;

// ─── Live-Data WS trade event ─────────────────────────────────────────────────
export const ZLiveTradeEvent = z
  .object({
    asset: z.string(), // tokenId
    conditionId: z.string(),
    side: z.enum(["BUY", "SELL"]),
    size: z.coerce.number(),
    price: z.coerce.number(),
    proxyWallet: z.string(),
    transactionHash: z.string(),
    timestamp: z.coerce.number(),
    outcome: z.string().optional().default(""),
    slug: z.string().optional().default(""),
    eventSlug: z.string().optional().default(""),
    title: z.string().optional().default(""),
    pseudonym: z.string().optional().nullable(),
    name: z.string().optional().nullable(),
  })
  .passthrough()
  .strip();

export type LiveTradeEvent = z.infer<typeof ZLiveTradeEvent>;

// ─── CLOB WS events ───────────────────────────────────────────────────────────
const ZPriceLevel = z.object({
  price: z.string(),
  size: z.string(),
});

export const ZClobBookEvent = z
  .object({
    asset_id: z.string(),
    market: z.string().optional(),
    timestamp: z.string(),
    hash: z.string(),
    bids: z.array(ZPriceLevel),
    asks: z.array(ZPriceLevel),
  })
  .passthrough()
  .strip();

export type ClobBookEvent = z.infer<typeof ZClobBookEvent>;

export const ZClobPriceChangeEvent = z
  .object({
    asset_id: z.string(),
    price: z.coerce.number(),
    side: z.enum(["BUY", "SELL"]),
    timestamp: z.coerce.number(),
  })
  .passthrough()
  .strip();

export const ZClobBestBidAskEvent = z
  .object({
    asset_id: z.string(),
    bid: z.coerce.number(),
    ask: z.coerce.number(),
    timestamp: z.coerce.number().optional(),
  })
  .passthrough()
  .strip();

export const ZClobLastTradePriceEvent = z
  .object({
    asset_id: z.string(),
    price: z.coerce.number(),
    side: z.enum(["BUY", "SELL"]).optional(),
    timestamp: z.coerce.number().optional(),
  })
  .passthrough()
  .strip();

// ─── Data API trade (for bootstrap / enrichment) ──────────────────────────────
export const ZDataApiTrade = z
  .object({
    proxyWallet: z.string(),
    side: z.enum(["BUY", "SELL"]),
    asset: z.string(), // tokenId
    conditionId: z.string(),
    size: z.coerce.number(),
    price: z.coerce.number(),
    timestamp: z.coerce.number(),
    transactionHash: z.string().optional().default(""),
    outcome: z.string().optional().default(""),
    title: z.string().optional().default(""),
    slug: z.string().optional().default(""),
    pseudonym: z.string().optional().nullable(),
    name: z.string().optional().nullable(),
  })
  .passthrough()
  .strip();

export type DataApiTrade = z.infer<typeof ZDataApiTrade>;
