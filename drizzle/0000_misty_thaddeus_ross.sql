CREATE TABLE "market_stats" (
	"token_id" varchar(80) PRIMARY KEY NOT NULL,
	"condition_id" varchar(66) NOT NULL,
	"best_bid" numeric(10, 6),
	"best_ask" numeric(10, 6),
	"mid" numeric(10, 6),
	"spread" numeric(10, 6),
	"last_trade_price" numeric(10, 6),
	"volume_24hr" numeric(20, 6),
	"volume_1wk" numeric(20, 6),
	"volume_1mo" numeric(20, 6),
	"volume_total" numeric(20, 6),
	"liquidity_usdc" numeric(20, 6),
	"open_interest" numeric(20, 6),
	"avg_trade_size_24h" numeric(20, 6),
	"stddev_trade_size_24h" numeric(20, 6),
	"calibrated" boolean DEFAULT false NOT NULL,
	"bootstrap_trade_count" integer DEFAULT 0,
	"trade_count_24h" integer DEFAULT 0,
	"one_day_price_change" numeric(10, 6),
	"one_hour_price_change" numeric(10, 6),
	"one_week_price_change" numeric(10, 6),
	"competitive" numeric(10, 4),
	"refreshed_at" timestamp with time zone DEFAULT NOW() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "markets" (
	"token_id" varchar(80) PRIMARY KEY NOT NULL,
	"condition_id" varchar(66) NOT NULL,
	"gamma_market_id" varchar(20),
	"question" text DEFAULT '' NOT NULL,
	"slug" varchar(200),
	"event_slug" varchar(200),
	"category" varchar(100),
	"outcome" varchar(50) DEFAULT '' NOT NULL,
	"outcome_index" smallint DEFAULT 0 NOT NULL,
	"minimum_order_size" numeric(18, 6),
	"minimum_tick_size" numeric(10, 6),
	"neg_risk" boolean DEFAULT false,
	"watchlisted" boolean DEFAULT false,
	"accepting_orders" boolean DEFAULT false,
	"active" boolean DEFAULT true,
	"closed" boolean DEFAULT false,
	"end_date" timestamp with time zone,
	"closed_time" timestamp with time zone,
	"winner" boolean,
	"icon_url" text,
	"created_at" timestamp with time zone DEFAULT NOW() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT NOW() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "order_book_snapshots" (
	"id" bigint NOT NULL,
	"token_id" varchar(80) NOT NULL,
	"condition_id" varchar(66) NOT NULL,
	"bids" jsonb NOT NULL,
	"asks" jsonb NOT NULL,
	"bid_depth_usdc" numeric(20, 2),
	"ask_depth_usdc" numeric(20, 2),
	"imbalance_ratio" numeric(10, 4),
	"mid" numeric(10, 6),
	"spread" numeric(10, 6),
	"book_hash" varchar(40),
	"snapshot_trigger" varchar(20),
	"captured_at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
CREATE TABLE "price_history" (
	"id" bigint PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "price_history_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 9223372036854775807 START WITH 1 CACHE 1),
	"token_id" varchar(80) NOT NULL,
	"condition_id" varchar(66) NOT NULL,
	"price" numeric(10, 6) NOT NULL,
	"side" varchar(4),
	"event_type" varchar(30) NOT NULL,
	"recorded_at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
CREATE TABLE "signals" (
	"id" bigint PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "signals_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 9223372036854775807 START WITH 1 CACHE 1),
	"token_id" varchar(80) NOT NULL,
	"condition_id" varchar(66) NOT NULL,
	"signal_type" varchar(40) NOT NULL,
	"direction" varchar(10),
	"confidence" numeric(6, 4) NOT NULL,
	"strength" numeric(10, 4),
	"price_at_signal" numeric(10, 6),
	"spread_at_signal" numeric(10, 6),
	"volume_at_signal" numeric(20, 6),
	"whale_alert_id" bigint,
	"order_book_snapshot_id" bigint,
	"payload" jsonb,
	"created_at" timestamp with time zone DEFAULT NOW() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "trades" (
	"id" bigint NOT NULL,
	"token_id" varchar(80) NOT NULL,
	"condition_id" varchar(66) NOT NULL,
	"outcome" varchar(50) DEFAULT '' NOT NULL,
	"side" varchar(4) NOT NULL,
	"size_tokens" numeric(20, 6) NOT NULL,
	"price_usdc" numeric(10, 6) NOT NULL,
	"value_usdc" numeric(20, 6) NOT NULL,
	"proxy_wallet" varchar(42) NOT NULL,
	"transaction_hash" varchar(66) NOT NULL,
	"traded_at" timestamp with time zone NOT NULL,
	"market_slug" varchar(200),
	"event_slug" varchar(200),
	"market_title" text,
	"trader_name" varchar(100),
	"trader_pseudonym" varchar(100),
	"source" varchar(20) DEFAULT 'live_ws',
	"created_at" timestamp with time zone DEFAULT NOW() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "wallet_profiles" (
	"proxy_wallet" varchar(42) PRIMARY KEY NOT NULL,
	"total_volume_usdc" numeric(20, 2),
	"trade_count" integer DEFAULT 0,
	"whale_trade_count" integer DEFAULT 0,
	"first_seen_at" timestamp with time zone,
	"last_seen_at" timestamp with time zone,
	"resolved_trade_count" integer DEFAULT 0,
	"win_count" integer DEFAULT 0,
	"win_ratio" numeric(6, 4),
	"display_name" varchar(100),
	"pseudonym" varchar(100),
	"last_enriched_at" timestamp with time zone,
	"enrichment_version" smallint DEFAULT 0
);
--> statement-breakpoint
CREATE TABLE "whale_alerts" (
	"id" bigint PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "whale_alerts_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 9223372036854775807 START WITH 1 CACHE 1),
	"trade_lookup_key" varchar(200) NOT NULL,
	"token_id" varchar(80) NOT NULL,
	"condition_id" varchar(66) NOT NULL,
	"usdc_value" numeric(20, 2) NOT NULL,
	"absolute_min_usdc" integer NOT NULL,
	"avg_trade_size_24h_at_alert" numeric(20, 6),
	"stddev_24h_at_alert" numeric(20, 6),
	"volume_24h_at_alert" numeric(20, 6),
	"sigmas_above_mean" numeric(8, 4),
	"pct_of_daily_volume" numeric(8, 4),
	"price_at_alert" numeric(10, 6),
	"price_impact_estimate_usdc" numeric(10, 6),
	"book_depth_consumed_pct" numeric(6, 2),
	"book_snapshot_age_ms" integer,
	"wallet_total_volume_usdc" numeric(20, 2),
	"wallet_trade_count" integer,
	"wallet_first_seen_at" timestamp with time zone,
	"wallet_win_ratio" numeric(6, 4),
	"enriched_at" timestamp with time zone,
	"alerted_at" timestamp with time zone DEFAULT NOW() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "market_stats" ADD CONSTRAINT "market_stats_token_id_markets_token_id_fk" FOREIGN KEY ("token_id") REFERENCES "public"."markets"("token_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "signals" ADD CONSTRAINT "signals_whale_alert_id_whale_alerts_id_fk" FOREIGN KEY ("whale_alert_id") REFERENCES "public"."whale_alerts"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "market_stats_condition_id_idx" ON "market_stats" USING btree ("condition_id");--> statement-breakpoint
CREATE INDEX "market_stats_volume_idx" ON "market_stats" USING btree ("volume_24hr");--> statement-breakpoint
CREATE INDEX "markets_condition_id_idx" ON "markets" USING btree ("condition_id");--> statement-breakpoint
CREATE INDEX "markets_active_watchlist_idx" ON "markets" USING btree ("active","watchlisted");--> statement-breakpoint
CREATE INDEX "markets_neg_risk_idx" ON "markets" USING btree ("neg_risk");--> statement-breakpoint
CREATE INDEX "markets_slug_idx" ON "markets" USING btree ("slug");--> statement-breakpoint
CREATE INDEX "obs_token_time_idx" ON "order_book_snapshots" USING btree ("token_id","captured_at");--> statement-breakpoint
CREATE INDEX "obs_condition_idx" ON "order_book_snapshots" USING btree ("condition_id");--> statement-breakpoint
CREATE INDEX "obs_imbalance_idx" ON "order_book_snapshots" USING btree ("imbalance_ratio");--> statement-breakpoint
CREATE INDEX "ph_token_time_idx" ON "price_history" USING btree ("token_id","recorded_at");--> statement-breakpoint
CREATE INDEX "ph_condition_idx" ON "price_history" USING btree ("condition_id");--> statement-breakpoint
CREATE INDEX "ph_recent_idx" ON "price_history" USING btree ("recorded_at");--> statement-breakpoint
CREATE INDEX "signals_token_time_idx" ON "signals" USING btree ("token_id","created_at");--> statement-breakpoint
CREATE INDEX "signals_type_time_idx" ON "signals" USING btree ("signal_type","created_at");--> statement-breakpoint
CREATE INDEX "signals_confidence_idx" ON "signals" USING btree ("confidence");--> statement-breakpoint
CREATE INDEX "signals_condition_idx" ON "signals" USING btree ("condition_id");--> statement-breakpoint
CREATE INDEX "trades_tx_hash_idx" ON "trades" USING btree ("transaction_hash");--> statement-breakpoint
CREATE INDEX "trades_token_time_idx" ON "trades" USING btree ("token_id","traded_at");--> statement-breakpoint
CREATE INDEX "trades_condition_time_idx" ON "trades" USING btree ("condition_id","traded_at");--> statement-breakpoint
CREATE INDEX "trades_wallet_idx" ON "trades" USING btree ("proxy_wallet");--> statement-breakpoint
CREATE INDEX "trades_value_idx" ON "trades" USING btree ("value_usdc");--> statement-breakpoint
CREATE INDEX "trades_time_idx" ON "trades" USING btree ("traded_at");--> statement-breakpoint
CREATE INDEX "wp_volume_idx" ON "wallet_profiles" USING btree ("total_volume_usdc");--> statement-breakpoint
CREATE INDEX "wp_win_ratio_idx" ON "wallet_profiles" USING btree ("win_ratio");--> statement-breakpoint
CREATE INDEX "wa_token_time_idx" ON "whale_alerts" USING btree ("token_id","alerted_at");--> statement-breakpoint
CREATE INDEX "wa_value_idx" ON "whale_alerts" USING btree ("usdc_value");--> statement-breakpoint
CREATE INDEX "wa_condition_idx" ON "whale_alerts" USING btree ("condition_id");--> statement-breakpoint
CREATE INDEX "wa_lookup_key_idx" ON "whale_alerts" USING btree ("trade_lookup_key");