import type { NodePgDatabase } from "drizzle-orm/node-postgres";
import * as schema from "../db/schema.js";
import { GroupResolver } from "./group-resolver.js";
import { ArbDetector } from "./arb-detector.js";
import type { NegRiskGroup } from "./group-resolver.js";
import type { ClobRestClient } from "../sources/clob-rest-client.js";
import type { AlertEmitter } from "../alerts/alert-emitter.js";
import type { WebhookEmitter } from "../alerts/webhook-emitter.js";
import { insertSignal } from "../db/queries/signals.js";
import type { BookUpdateEvent, ConditionId, NegRiskSignal } from "../events/types.js";
import { logger } from "../logger.js";

type Db = NodePgDatabase<typeof schema>;

export interface NegRiskEngineOptions {
  refreshIntervalMs?: number;
}

const DEBOUNCE_MS = 2000;

export class NegRiskEngine {
  private readonly resolver: GroupResolver;
  private readonly detector: ArbDetector;
  private readonly groups = new Map<ConditionId, NegRiskGroup>();
  private readonly negRiskTokenIds = new Set<string>();
  private refreshTimer: ReturnType<typeof setInterval> | null = null;
  private debounceTimer: ReturnType<typeof setTimeout> | null = null;
  private readonly refreshIntervalMs: number;

  constructor(
    private readonly db: Db,
    clobClient: ClobRestClient,
    private readonly alertEmitter: AlertEmitter,
    private readonly webhookEmitter: WebhookEmitter,
    opts?: NegRiskEngineOptions
  ) {
    this.resolver = new GroupResolver(db, clobClient);
    this.detector = new ArbDetector(db);
    this.refreshIntervalMs = opts?.refreshIntervalMs ?? 120_000;
  }

  start(negRiskTokenIds: string[]): void {
    for (const id of negRiskTokenIds) {
      this.negRiskTokenIds.add(id);
    }

    // Immediate refresh on startup
    this.refresh().catch((err) => logger.error({ err }, "NegRiskEngine: startup refresh failed"));

    this.refreshTimer = setInterval(() => {
      this.refresh().catch((err) => logger.error({ err }, "NegRiskEngine: refresh failed"));
    }, this.refreshIntervalMs);
  }

  stop(): void {
    if (this.refreshTimer) {
      clearInterval(this.refreshTimer);
      this.refreshTimer = null;
    }
    if (this.debounceTimer) {
      clearTimeout(this.debounceTimer);
      this.debounceTimer = null;
    }
  }

  addTokenIds(ids: string[]): void {
    let changed = false;
    for (const id of ids) {
      if (!this.negRiskTokenIds.has(id)) {
        this.negRiskTokenIds.add(id);
        changed = true;
      }
    }

    if (!changed) return;

    // Debounced refresh
    if (this.debounceTimer) {
      clearTimeout(this.debounceTimer);
    }
    this.debounceTimer = setTimeout(() => {
      this.debounceTimer = null;
      this.refresh().catch((err) => logger.error({ err }, "NegRiskEngine: debounced refresh failed"));
    }, DEBOUNCE_MS);
  }

  handleBookUpdate(evt: BookUpdateEvent): void {
    const tokenId = evt.book.tokenId;
    if (!this.negRiskTokenIds.has(tokenId)) return;

    const conditionId = evt.book.conditionId;
    const group = this.groups.get(conditionId);

    if (!group) {
      logger.debug({ conditionId }, "NegRiskEngine: group not yet resolved, skipping BookUpdateEvent");
      return;
    }

    // Partial update: update token prices in the cached group
    const tokenIdx = group.tokens.findIndex((t) => t.tokenId === tokenId);
    if (tokenIdx !== -1) {
      const book = evt.book;

      // Size-aware ask
      const MIN_SIZE = 10.0;
      const tradeableAsk = book.asks.find((a) => a.size >= MIN_SIZE);
      const bestAsk = tradeableAsk?.price ?? 1.0;

      // Size-aware bid
      const bestBid = (book.bids[0]?.size ?? 0) >= MIN_SIZE ? book.bids[0].price : 0;

      group.tokens[tokenIdx].bestAsk = bestAsk;
      group.tokens[tokenIdx].bestBid = bestBid;
    }

    // Recompute sums and validity
    group.sumBid = group.tokens.reduce((s, t) => s + t.bestBid, 0);
    group.sumAsk = group.tokens.reduce((s, t) => s + t.bestAsk, 0);
    group.isValid =
      group.tokens.length >= 2 &&
      group.sumBid <= 1.05 &&
      group.sumAsk >= 0.95 &&
      group.sumAsk <= 1.20;

    // Fire-and-forget evaluate
    this.detector.evaluate(group).then((signals) => {
      for (const signal of signals) {
        this.emitAndPersist(signal);
      }
    }).catch((err) => logger.error({ err }, "NegRiskEngine: evaluate after book update failed"));
  }

  private async refresh(): Promise<void> {
    let groups: NegRiskGroup[];
    try {
      groups = await this.resolver.resolveGroups();
    } catch (err) {
      logger.error({ err }, "NegRiskEngine: resolveGroups failed");
      return;
    }

    // Update cache
    this.groups.clear();
    for (const group of groups) {
      this.groups.set(group.conditionId, group);
      // Ensure all tokens are in the tracking set
      for (const token of group.tokens) {
        this.negRiskTokenIds.add(token.tokenId);
      }
    }

    // Evaluate valid groups
    for (const group of groups) {
      if (!group.isValid) continue;
      try {
        const signals = await this.detector.evaluate(group);
        for (const signal of signals) {
          this.emitAndPersist(signal);
        }
      } catch (err) {
        logger.error({ err, conditionId: group.conditionId }, "NegRiskEngine: evaluate failed");
      }
    }
  }

  private emitAndPersist(signal: NegRiskSignal): void {
    // Stdout alert
    this.emitAlert(signal);

    // DB persist (fire-and-forget)
    insertSignal(this.db, signal).catch((err) =>
      logger.error({ err }, "NegRiskEngine: insertSignal failed")
    );

    // Webhook (fire-and-forget)
    this.webhookEmitter.send(signal);
  }

  private emitAlert(signal: NegRiskSignal): void {
    const msg = `[NEG-RISK] ${signal.signalType} conditionId=${signal.conditionIdGroup} conf=${signal.confidence.toFixed(2)}`;
    console.log(msg);
    logger.info({
      type: "neg_risk_signal",
      signalType: signal.signalType,
      conditionId: signal.conditionIdGroup,
      tokenId: signal.tokenId,
      direction: signal.direction,
      confidence: signal.confidence,
      negRiskSumAsk: signal.negRiskSumAsk,
    }, msg);
  }
}
