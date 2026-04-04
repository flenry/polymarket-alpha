"use client";

import useSWR from "swr";
import { Skeleton } from "@/components/ui/skeleton";
import { timeAgo } from "@/lib/utils";
import type { HealthResponse } from "@/app/api/health/route";

const fetcher = (url: string) => fetch(url).then((r) => r.json());

function statusInfo(lastEventAt: string | null): {
  color: string;
  dot: string;
  label: string;
} {
  if (!lastEventAt) {
    return { color: "text-slate-500", dot: "bg-slate-400", label: "No data" };
  }
  const ageMs = Date.now() - new Date(lastEventAt).getTime();
  const ageSec = ageMs / 1000;
  if (ageSec < 30) {
    return { color: "text-green-700", dot: "bg-green-500", label: "Connected" };
  }
  if (ageSec < 120) {
    return { color: "text-amber-700", dot: "bg-amber-500", label: "Degraded" };
  }
  return { color: "text-red-700", dot: "bg-red-500", label: "Disconnected" };
}

interface HealthCardProps {
  title: string;
  lastEventAt: string | null;
  subtitle?: string;
}

function HealthCard({ title, lastEventAt, subtitle }: HealthCardProps) {
  const { color, dot, label } = statusInfo(lastEventAt);

  return (
    <div className="bg-white border border-slate-200 rounded-lg p-5 shadow-sm">
      <div className="flex items-center gap-2 mb-3">
        <span className={`inline-block w-2.5 h-2.5 rounded-full ${dot}`} />
        <h3 className="text-sm font-semibold text-slate-900">{title}</h3>
      </div>
      <p className={`text-sm font-medium ${color}`}>{label}</p>
      <p className="text-xs text-slate-500 mt-1">
        Last event: {timeAgo(lastEventAt)}
      </p>
      {subtitle && (
        <p className="text-xs text-slate-500 mt-1">{subtitle}</p>
      )}
    </div>
  );
}

export function HealthPanel() {
  const { data, isLoading } = useSWR<HealthResponse>(
    "/api/health",
    fetcher,
    { refreshInterval: 10_000 }
  );

  if (isLoading) {
    return (
      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-4">
        {Array.from({ length: 4 }).map((_, i) => (
          <Skeleton key={i} className="h-36 w-full rounded-lg" />
        ))}
      </div>
    );
  }

  return (
    <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-4">
      <HealthCard
        title="LiveDataWs"
        lastEventAt={data?.lastTradeAt ?? null}
        subtitle="Trade feed"
      />
      <HealthCard
        title="ClobWsPool"
        lastEventAt={data?.lastSnapshotAt ?? null}
        subtitle="Shards: Unknown"
      />
      <HealthCard
        title="GammaPoller"
        lastEventAt={data?.lastMarketRefreshAt ?? null}
        subtitle={
          data
            ? `${data.marketsTracked} markets tracked`
            : undefined
        }
      />
      <HealthCard
        title="DB"
        lastEventAt={data?.lastTradeAt ?? null}
        subtitle={
          data
            ? `${data.tradesLast5Min} trades/5min`
            : undefined
        }
      />
    </div>
  );
}
