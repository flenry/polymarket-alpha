/**
 * Full 6-tuple trade join for whale_alerts.
 *
 * trade_lookup_key format: "txHash|tokenId|proxyWallet|tradedAt|priceUsdc|sizeTokens"
 *
 * LAW-MAJOR-1: transaction_hash alone is non-unique (partial fills share same hash).
 * This join must use all 6 parts of the lookup key to guarantee at-most-one match.
 *
 * The traded_at partition-pruning bound (90 days) is included for query performance.
 */
export const ALERT_TRADE_JOIN_SQL = `
LEFT JOIN trades t ON
  t.transaction_hash = split_part(wa.trade_lookup_key, '|', 1)
  AND t.token_id     = split_part(wa.trade_lookup_key, '|', 2)
  AND t.proxy_wallet = split_part(wa.trade_lookup_key, '|', 3)
  AND t.traded_at    = split_part(wa.trade_lookup_key, '|', 4)::timestamptz
  AND t.price_usdc   = split_part(wa.trade_lookup_key, '|', 5)::numeric
  AND t.size_tokens  = split_part(wa.trade_lookup_key, '|', 6)::numeric
  AND t.traded_at   >= NOW() - INTERVAL '90 days'
`.trim();
