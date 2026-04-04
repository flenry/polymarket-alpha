import type { WhaleAlert, ImbalanceSignal, Signal, NegRiskSignal } from "../events/types.js";
import { config } from "../config.js";
import { logger } from "../logger.js";

type Payload = WhaleAlert | Signal;

function isWhaleAlert(p: Payload): p is WhaleAlert {
  return "trade" in p && "usdcValue" in p;
}

function isImbalanceSignal(p: Payload): p is ImbalanceSignal {
  return !isWhaleAlert(p) && (p as Signal).signalType === "ORDER_BOOK_IMBALANCE";
}

function isNegRiskSignal(p: Payload): p is NegRiskSignal {
  return !isWhaleAlert(p) &&
    ((p as Signal).signalType === "NEG_RISK_ARB" ||
     (p as Signal).signalType === "NEG_RISK_OUTLIER");
}

function truncateWallet(wallet: string, len = 12): string {
  return wallet.length > len ? wallet.slice(0, len) + "…" : wallet;
}

// ── Token bucket ──────────────────────────────────────────────────────────────

class TokenBucket {
  private tokens: number;
  private readonly max: number;
  private readonly refillMs: number;
  private lastRefill: number;

  constructor(maxTokens: number, rps: number) {
    this.max = maxTokens;
    this.tokens = maxTokens;
    this.refillMs = 1000 / rps;
    this.lastRefill = Date.now();
  }

  /** Returns a promise that resolves when a token is available */
  async acquire(): Promise<void> {
    return new Promise<void>((resolve) => {
      const attempt = () => {
        this.refill();
        if (this.tokens >= 1) {
          this.tokens -= 1;
          resolve();
        } else {
          const wait = this.refillMs - (Date.now() - this.lastRefill);
          setTimeout(attempt, Math.max(1, wait));
        }
      };
      attempt();
    });
  }

  private refill(): void {
    const now = Date.now();
    const elapsed = now - this.lastRefill;
    const newTokens = Math.floor(elapsed / this.refillMs);
    if (newTokens > 0) {
      this.tokens = Math.min(this.max, this.tokens + newTokens);
      this.lastRefill = now;
    }
  }
}

// ── Discord payload builders ──────────────────────────────────────────────────

function buildDiscordWhaleEmbed(alert: WhaleAlert): object {
  const { trade, usdcValue, signal } = alert;
  return {
    embeds: [
      {
        title: "🐋 Whale Trade Detected",
        description: trade.marketTitle || trade.marketSlug || trade.tokenId,
        color: 0xff4444,
        fields: [
          { name: "Market", value: trade.marketTitle || trade.tokenId, inline: true },
          {
            name: "Value (USDC)",
            value: `$${usdcValue.toLocaleString("en-US", { maximumFractionDigits: 0 })}`,
            inline: true,
          },
          { name: "Wallet", value: truncateWallet(trade.proxyWallet), inline: true },
          { name: "Sigma Score", value: signal.sigmasAboveMean.toFixed(2), inline: true },
          {
            name: "% Daily Volume",
            value: `${(signal.pctOfDailyVolume * 100).toFixed(2)}%`,
            inline: true,
          },
        ],
        timestamp: new Date().toISOString(),
      },
    ],
  };
}

function buildDiscordImbalanceEmbed(signal: ImbalanceSignal): object {
  return {
    embeds: [
      {
        title: "📊 Order Book Imbalance",
        description: `Token: ${signal.tokenId}`,
        color: 0xffaa00,
        fields: [
          { name: "Market", value: signal.tokenId, inline: true },
          { name: "Ratio", value: signal.imbalanceRatio.toFixed(3), inline: true },
          { name: "Direction", value: signal.direction, inline: true },
          {
            name: "Total Depth (USDC)",
            value: `$${(signal.bidDepthUsdc + signal.askDepthUsdc).toLocaleString("en-US", { maximumFractionDigits: 0 })}`,
            inline: true,
          },
        ],
        timestamp: new Date().toISOString(),
      },
    ],
  };
}

// ── Slack payload builders ────────────────────────────────────────────────────

function buildSlackWhalePayload(alert: WhaleAlert): object {
  const { trade, usdcValue, signal } = alert;
  const text =
    `*🐋 Whale Alert*\n` +
    `Market: ${trade.marketTitle || trade.tokenId}\n` +
    `Value: $${usdcValue.toLocaleString("en-US", { maximumFractionDigits: 0 })} USDC\n` +
    `Wallet: ${truncateWallet(trade.proxyWallet)}\n` +
    `Sigma: ${signal.sigmasAboveMean.toFixed(2)}σ  |  ` +
    `% Daily Vol: ${(signal.pctOfDailyVolume * 100).toFixed(2)}%`;

  return { blocks: [{ type: "section", text: { type: "mrkdwn", text } }] };
}

function buildSlackImbalancePayload(signal: ImbalanceSignal): object {
  const text =
    `*📊 Order Book Imbalance*\n` +
    `Market: ${signal.tokenId}\n` +
    `Ratio: ${signal.imbalanceRatio.toFixed(3)}  |  Direction: ${signal.direction}\n` +
    `Total Depth: $${(signal.bidDepthUsdc + signal.askDepthUsdc).toLocaleString("en-US", { maximumFractionDigits: 0 })} USDC`;

  return { blocks: [{ type: "section", text: { type: "mrkdwn", text } }] };
}

function buildDiscordNegRiskEmbed(signal: NegRiskSignal): object {
  const isArb = signal.signalType === "NEG_RISK_ARB";
  const deviationField = signal.arbSpread != null
    ? { name: "Arb Spread", value: signal.arbSpread.toFixed(4), inline: true }
    : { name: "Price Deviation", value: `${(signal.priceDeviation ?? 0).toFixed(2)}\u03c3`, inline: true };
  return {
    embeds: [{
      title: isArb ? "\u2697\ufe0f Neg-Risk Arb Detected" : "\ud83d\udcca Neg-Risk Outlier Detected",
      description: `Condition: ${signal.conditionIdGroup}`,
      color: 0x9B59B6,
      fields: [
        { name: "Direction", value: signal.direction, inline: true },
        { name: "Confidence", value: signal.confidence.toFixed(2), inline: true },
        { name: "Group Size", value: String(signal.negRiskGroupSize), inline: true },
        { name: "Sum Ask", value: signal.negRiskSumAsk.toFixed(4), inline: true },
        deviationField,
      ],
      timestamp: new Date().toISOString(),
    }],
  };
}

function buildSlackNegRiskPayload(signal: NegRiskSignal): object {
  const isArb = signal.signalType === "NEG_RISK_ARB";
  const devStr = signal.arbSpread != null
    ? `Arb Spread: ${signal.arbSpread.toFixed(4)}`
    : `Deviation: ${(signal.priceDeviation ?? 0).toFixed(2)}\u03c3`;
  const text =
    `*${isArb ? "\u2697\ufe0f Neg-Risk Arb" : "\ud83d\udcca Neg-Risk Outlier"}*\n` +
    `Condition: ${signal.conditionIdGroup}\n` +
    `Direction: ${signal.direction}  |  Confidence: ${signal.confidence.toFixed(2)}\n` +
    `Group Size: ${signal.negRiskGroupSize}  |  Sum Ask: ${signal.negRiskSumAsk.toFixed(4)}  |  ${devStr}`;
  return { blocks: [{ type: "section", text: { type: "mrkdwn", text } }] };
}

// ── WebhookEmitter ────────────────────────────────────────────────────────────

export class WebhookEmitter {
  private readonly discordUrl: string;
  private readonly slackUrl: string;
  private readonly bucket: TokenBucket;

  constructor(opts?: { discordUrl?: string; slackUrl?: string; rps?: number }) {
    this.discordUrl = opts?.discordUrl ?? config.discordWebhookUrl;
    this.slackUrl = opts?.slackUrl ?? config.slackWebhookUrl;
    const rps = opts?.rps ?? 5;
    this.bucket = new TokenBucket(rps, rps);
  }

  /** Send a webhook alert — never throws, fire-and-forget safe */
  async send(payload: Payload): Promise<void> {
    if (!this.discordUrl && !this.slackUrl) return;

    await this.bucket.acquire();

    if (this.discordUrl) {
      await this.post(this.discordUrl, this.buildDiscordPayload(payload));
    }
    if (this.slackUrl) {
      await this.post(this.slackUrl, this.buildSlackPayload(payload));
    }
  }

  private buildDiscordPayload(p: Payload): object {
    if (isWhaleAlert(p)) return buildDiscordWhaleEmbed(p);
    if (isImbalanceSignal(p)) return buildDiscordImbalanceEmbed(p);
    if (isNegRiskSignal(p)) return buildDiscordNegRiskEmbed(p);
    return { embeds: [{ title: "Signal", description: JSON.stringify(p), color: 0x888888 }] };
  }

  private buildSlackPayload(p: Payload): object {
    if (isWhaleAlert(p)) return buildSlackWhalePayload(p);
    if (isImbalanceSignal(p)) return buildSlackImbalancePayload(p);
    if (isNegRiskSignal(p)) return buildSlackNegRiskPayload(p);
    return {
      blocks: [{ type: "section", text: { type: "mrkdwn", text: JSON.stringify(p) } }],
    };
  }

  private async post(url: string, body: object): Promise<void> {
    try {
      const response = await globalThis.fetch(url, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });

      if (response.status === 429) {
        const retryAfter = response.headers.get("Retry-After");
        const waitMs = retryAfter ? Number(retryAfter) * 1000 : 10_000;
        await new Promise((r) => setTimeout(r, waitMs));
        // Retry once
        const retry = await globalThis.fetch(url, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(body),
        });
        if (!retry.ok && retry.status !== 204) {
          logger.warn({ status: retry.status, url }, "WebhookEmitter: retry also failed");
        }
        return;
      }

      if (!response.ok && response.status !== 204) {
        logger.warn({ status: response.status, url }, "WebhookEmitter: non-OK response");
      }
    } catch (err) {
      logger.warn({ err, url }, "WebhookEmitter: fetch error");
    }
  }
}
