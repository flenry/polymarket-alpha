"use client";

import useSWR from "swr";
import { useRouter } from "next/navigation";
import { Badge } from "@/components/ui/badge";
import { Skeleton } from "@/components/ui/skeleton";
import { formatUSDC } from "@/lib/utils";
import type { MarketRow } from "@/app/api/markets/route";

const SIGNAL_TYPE_VARIANTS: Record<
  string,
  "purple" | "blue" | "orange" | "teal" | "indigo" | "violet"
> = {
  WHALE_TRADE: "purple",
  ORDER_BOOK_IMBALANCE: "blue",
  PRICE_IMPACT_ANOMALY: "orange",
  SENTIMENT_VELOCITY: "teal",
  NEG_RISK_ARB: "indigo",
  NEG_RISK_OUTLIER: "violet",
};

const fetcher = (url: string) => fetch(url).then((r) => r.json());

function heatColor(density: number): string {
  // density: 0–1 (signal_count / max_signal_count)
  if (density >= 0.75) return "bg-blue-500 text-white";
  if (density >= 0.5) return "bg-blue-300 text-slate-900";
  if (density >= 0.25) return "bg-blue-200 text-slate-900";
  return "bg-blue-50 text-slate-900";
}

export function MarketsHeatmap() {
  const router = useRouter();
  const { data, isLoading } = useSWR<{ markets: MarketRow[] }>(
    "/api/markets?hours=24",
    fetcher,
    { refreshInterval: 30_000 }
  );

  if (isLoading) {
    return (
      <div className="grid grid-cols-2 gap-4 sm:grid-cols-4">
        {Array.from({ length: 8 }).map((_, i) => (
          <Skeleton key={i} className="h-36 w-full rounded-lg" />
        ))}
      </div>
    );
  }

  const markets = data?.markets ?? [];

  if (markets.length === 0) {
    return (
      <div className="flex items-center justify-center h-48 text-slate-500 text-sm">
        No signal activity in the last 24 hours
      </div>
    );
  }

  const maxSignals = Math.max(...markets.map((m) => m.signal_count));

  return (
    <div className="grid grid-cols-2 gap-4 sm:grid-cols-4">
      {markets.map((market) => {
        const density = maxSignals > 0 ? market.signal_count / maxSignals : 0;
        const colorClass = heatColor(density);
        const typeVariant =
          market.top_signal_type
            ? SIGNAL_TYPE_VARIANTS[market.top_signal_type] ?? "blue"
            : undefined;

        return (
          <div
            key={market.token_id}
            className={`rounded-lg border border-slate-200 p-4 cursor-pointer hover:ring-2 hover:ring-blue-400 transition-all ${colorClass}`}
            onClick={() =>
              router.push(`/signals?tokenId=${encodeURIComponent(market.token_id)}`)
            }
          >
            <p className="text-xs font-medium line-clamp-2 mb-2">
              {market.question ?? market.token_id}
            </p>
            <div className="space-y-1">
              <p className="text-sm font-bold">{market.signal_count} signals</p>
              {market.whale_count > 0 && (
                <p className="text-xs opacity-80">🐋 {market.whale_count} whale</p>
              )}
              {market.top_signal_type && typeVariant && (
                <Badge variant={typeVariant} className="text-[10px] px-1.5 py-0">
                  {market.top_signal_type.replace(/_/g, " ")}
                </Badge>
              )}
              {market.volume_24h && (
                <p className="text-xs opacity-70">
                  Vol: {formatUSDC(parseFloat(market.volume_24h))}
                </p>
              )}
            </div>
          </div>
        );
      })}
    </div>
  );
}
