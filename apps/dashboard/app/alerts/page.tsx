"use client";

import useSWR from "swr";
import { AlertsTable } from "@/components/alerts-table";
import { StatCard } from "@/components/stat-card";
import { formatUSDC } from "@/lib/utils";
import type { AlertRow } from "@/app/api/alerts/route";

const POLL_MS = parseInt(
  process.env.NEXT_PUBLIC_DASHBOARD_POLL_INTERVAL_MS ?? "5000",
  10
);

const fetcher = (url: string) => fetch(url).then((r) => r.json());

export default function AlertsPage() {
  const { data } = useSWR<{ alerts: AlertRow[]; total: number }>(
    "/api/alerts?hours=24&limit=100",
    fetcher,
    { refreshInterval: POLL_MS }
  );

  const alerts = data?.alerts ?? [];
  const total = data?.total ?? 0;

  const largest =
    alerts.length > 0
      ? Math.max(...alerts.map((a) => parseFloat(a.usdc_value)))
      : 0;

  const avg =
    alerts.length > 0
      ? alerts.reduce((sum, a) => sum + parseFloat(a.usdc_value), 0) /
        alerts.length
      : 0;

  // Most active market by alert count
  const marketCounts: Record<string, { count: number; title: string }> = {};
  for (const a of alerts) {
    const key = a.token_id;
    if (!marketCounts[key]) {
      marketCounts[key] = { count: 0, title: a.question ?? a.token_id };
    }
    marketCounts[key].count++;
  }
  const topMarket = Object.values(marketCounts).sort(
    (a, b) => b.count - a.count
  )[0];

  return (
    <div className="p-6 space-y-6">
      <div>
        <h1 className="text-xl font-semibold text-slate-900">Whale Alerts</h1>
        <p className="text-sm text-slate-500 mt-0.5">
          Live feed — last 24 hours
        </p>
      </div>

      <div className="grid grid-cols-2 gap-4 sm:grid-cols-4">
        <StatCard title="Total Alerts (24h)" value={String(total)} />
        <StatCard
          title="Largest Alert"
          value={largest > 0 ? formatUSDC(largest) : "—"}
        />
        <StatCard
          title="Avg Size"
          value={avg > 0 ? formatUSDC(avg) : "—"}
        />
        <StatCard
          title="Most Active Market"
          value={
            topMarket
              ? `${topMarket.count} alerts`
              : "—"
          }
          subtitle={topMarket?.title}
        />
      </div>

      <div className="bg-white border border-slate-200 rounded-lg shadow-sm overflow-hidden">
        <AlertsTable />
      </div>
    </div>
  );
}
