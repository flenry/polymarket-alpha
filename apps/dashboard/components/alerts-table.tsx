"use client";

import useSWR from "swr";
import Link from "next/link";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { Badge } from "@/components/ui/badge";
import { Skeleton } from "@/components/ui/skeleton";
import { formatUSDC, formatAddress, timeAgo } from "@/lib/utils";
import type { AlertRow } from "@/app/api/alerts/route";

const POLL_MS = parseInt(
  process.env.NEXT_PUBLIC_DASHBOARD_POLL_INTERVAL_MS ?? "5000",
  10
);

const fetcher = (url: string) => fetch(url).then((r) => r.json());

function gateVariant(
  sigmas: string | null,
  pct: string | null
): { label: string; variant: "blue" | "amber" | "green" } {
  const s = sigmas !== null ? parseFloat(sigmas) : 0;
  const p = pct !== null ? parseFloat(pct) : 0;
  const sigmaOk = s >= 3;
  const pctOk = p >= 0.02;
  if (sigmaOk && pctOk) return { label: "BOTH", variant: "green" };
  if (sigmaOk) return { label: "SIGMA", variant: "blue" };
  return { label: "PCT_VOL", variant: "amber" };
}

export function AlertsTable() {
  const { data, isLoading } = useSWR<{ alerts: AlertRow[]; total: number }>(
    "/api/alerts?hours=24&limit=100",
    fetcher,
    { refreshInterval: POLL_MS }
  );

  if (isLoading) {
    return (
      <div className="space-y-2">
        {Array.from({ length: 6 }).map((_, i) => (
          <Skeleton key={i} className="h-12 w-full rounded-md" />
        ))}
      </div>
    );
  }

  const alerts = data?.alerts ?? [];

  if (alerts.length === 0) {
    return (
      <div className="flex items-center justify-center h-48 text-slate-500 text-sm">
        No whale alerts yet — pipeline may still be warming up
      </div>
    );
  }

  return (
    <Table>
      <TableHeader>
        <TableRow>
          <TableHead>Time</TableHead>
          <TableHead>Market</TableHead>
          <TableHead>Side</TableHead>
          <TableHead>Value (USDC)</TableHead>
          <TableHead>Wallet</TableHead>
          <TableHead>σ above mean</TableHead>
          <TableHead>% daily vol</TableHead>
          <TableHead>Enriched?</TableHead>
          <TableHead>Gate</TableHead>
        </TableRow>
      </TableHeader>
      <TableBody>
        {alerts.map((alert, idx) => {
          const isEven = idx % 2 === 0;
          const side = alert.side ?? "—";
          const usdcValue = parseFloat(alert.usdc_value);
          const { label: gateLabel, variant: gateVariant_ } = gateVariant(
            alert.sigmas_above_mean,
            alert.pct_of_daily_volume
          );

          return (
            <TableRow
              key={alert.id}
              className={isEven ? "bg-white" : "bg-slate-50"}
            >
              <TableCell className="text-slate-500 text-xs whitespace-nowrap">
                {timeAgo(alert.alerted_at)}
              </TableCell>
              <TableCell className="text-xs max-w-[200px] truncate">
                {alert.question ?? alert.token_id}
              </TableCell>
              <TableCell>
                <Badge variant={side === "BUY" ? "green" : "red"}>
                  {side}
                </Badge>
              </TableCell>
              <TableCell
                className={`font-medium ${side === "BUY" ? "text-green-700" : "text-red-700"}`}
              >
                {formatUSDC(usdcValue)}
              </TableCell>
              <TableCell>
                {alert.proxy_wallet ? (
                  <Link
                    href={`/wallets?wallet=${alert.proxy_wallet}`}
                    className="text-blue-600 hover:underline text-xs font-mono"
                  >
                    {formatAddress(alert.proxy_wallet)}
                  </Link>
                ) : (
                  <span className="text-slate-400 text-xs">—</span>
                )}
              </TableCell>
              <TableCell className="text-xs text-slate-600">
                {alert.sigmas_above_mean
                  ? parseFloat(alert.sigmas_above_mean).toFixed(2) + "σ"
                  : "—"}
              </TableCell>
              <TableCell className="text-xs text-slate-600">
                {alert.pct_of_daily_volume
                  ? (parseFloat(alert.pct_of_daily_volume) * 100).toFixed(2) +
                    "%"
                  : "—"}
              </TableCell>
              <TableCell>
                {alert.enriched_at ? "✅" : "⏳"}
              </TableCell>
              <TableCell>
                <Badge variant={gateVariant_}>{gateLabel}</Badge>
              </TableCell>
            </TableRow>
          );
        })}
      </TableBody>
    </Table>
  );
}
