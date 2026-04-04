"use client";

import { useState, useEffect, useCallback } from "react";
import useSWR from "swr";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import {
  Sheet,
  SheetContent,
  SheetHeader,
  SheetTitle,
} from "@/components/ui/sheet";
import { Skeleton } from "@/components/ui/skeleton";
import { formatUSDC, formatAddress, timeAgo } from "@/lib/utils";
import type { WalletRow } from "@/app/api/wallets/route";
import type { AlertRow } from "@/app/api/alerts/route";

const fetcher = (url: string) => fetch(url).then((r) => r.json());

function winRateClass(ratio: string | null): string {
  if (!ratio) return "text-slate-400";
  const n = parseFloat(ratio);
  if (n > 0.6) return "text-green-700 font-medium";
  if (n >= 0.4) return "text-amber-700 font-medium";
  return "text-red-700 font-medium";
}

interface WalletAlertsProps {
  address: string;
}

function WalletAlerts({ address }: WalletAlertsProps) {
  const { data, isLoading } = useSWR<{ alerts: AlertRow[] }>(
    `/api/wallets/${address}/alerts`,
    fetcher
  );

  if (isLoading) {
    return (
      <div className="space-y-2 mt-4">
        {Array.from({ length: 4 }).map((_, i) => (
          <Skeleton key={i} className="h-10 w-full" />
        ))}
      </div>
    );
  }

  const alerts = data?.alerts ?? [];

  if (alerts.length === 0) {
    return (
      <p className="text-sm text-slate-500 mt-4">No whale alerts for this wallet</p>
    );
  }

  return (
    <div className="mt-4 overflow-auto">
      <table className="w-full text-xs">
        <thead>
          <tr className="border-b">
            <th className="text-left py-1 pr-3 font-medium text-slate-500">Time</th>
            <th className="text-left py-1 pr-3 font-medium text-slate-500">Market</th>
            <th className="text-left py-1 pr-3 font-medium text-slate-500">Side</th>
            <th className="text-right py-1 font-medium text-slate-500">Value</th>
          </tr>
        </thead>
        <tbody>
          {alerts.map((a) => (
            <tr key={a.id} className="border-b border-slate-100">
              <td className="py-1.5 pr-3 text-slate-500">{timeAgo(a.alerted_at)}</td>
              <td className="py-1.5 pr-3 text-slate-700 max-w-[140px] truncate">
                {a.question ?? a.token_id}
              </td>
              <td className={`py-1.5 pr-3 font-medium ${a.side === "BUY" ? "text-green-700" : "text-red-700"}`}>
                {a.side ?? "—"}
              </td>
              <td className="py-1.5 text-right text-slate-700">
                {formatUSDC(parseFloat(a.usdc_value))}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

interface Props {
  initialWallet?: string;
}

export function WalletsTable({ initialWallet }: Props) {
  const [minTrades, setMinTrades] = useState<string>("3");
  const [minVolume, setMinVolume] = useState<string>("0");
  const [selectedWallet, setSelectedWallet] = useState<string | null>(
    initialWallet ?? null
  );

  // Sync initialWallet (for ?wallet= URL param)
  useEffect(() => {
    if (initialWallet) setSelectedWallet(initialWallet);
  }, [initialWallet]);

  const url = `/api/wallets?minTrades=${minTrades}&minVolume=${minVolume}`;
  const { data, isLoading } = useSWR<{ wallets: WalletRow[] }>(url, fetcher, {
    refreshInterval: 30_000,
  });

  const wallets = data?.wallets ?? [];

  const handleDebouncedChange = useCallback(
    (setter: (v: string) => void) =>
      (e: React.ChangeEvent<HTMLInputElement>) => {
        const val = e.target.value;
        setTimeout(() => setter(val), 300);
      },
    []
  );

  return (
    <>
      {/* Filters */}
      <div className="flex gap-4 bg-white border border-slate-200 rounded-lg p-4 shadow-sm mb-4">
        <label className="flex flex-col gap-1">
          <span className="text-xs text-slate-500">Min trades (resolved)</span>
          <input
            type="number"
            min={0}
            defaultValue={3}
            onChange={handleDebouncedChange(setMinTrades)}
            className="border border-slate-200 rounded px-2 py-1 text-sm w-28"
          />
        </label>
        <label className="flex flex-col gap-1">
          <span className="text-xs text-slate-500">Min volume ($)</span>
          <input
            type="number"
            min={0}
            defaultValue={0}
            onChange={handleDebouncedChange(setMinVolume)}
            className="border border-slate-200 rounded px-2 py-1 text-sm w-28"
          />
        </label>
      </div>

      {isLoading ? (
        <div className="space-y-2">
          {Array.from({ length: 6 }).map((_, i) => (
            <Skeleton key={i} className="h-10 w-full" />
          ))}
        </div>
      ) : (
        <div className="bg-white border border-slate-200 rounded-lg shadow-sm overflow-hidden">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Rank</TableHead>
                <TableHead>Wallet</TableHead>
                <TableHead>Total Vol</TableHead>
                <TableHead>Trades</TableHead>
                <TableHead>Win Rate</TableHead>
                <TableHead>Whale Trades</TableHead>
                <TableHead>Last Seen</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {wallets.length === 0 ? (
                <TableRow>
                  <TableCell
                    colSpan={7}
                    className="text-center text-slate-500 text-sm py-12"
                  >
                    No wallets match the current filters
                  </TableCell>
                </TableRow>
              ) : (
                wallets.map((wallet, idx) => (
                  <TableRow
                    key={wallet.proxy_wallet}
                    className={`${idx % 2 === 0 ? "bg-white" : "bg-slate-50"} cursor-pointer hover:bg-slate-100`}
                    onClick={() => setSelectedWallet(wallet.proxy_wallet)}
                  >
                    <TableCell className="text-slate-500 text-sm">
                      #{idx + 1}
                    </TableCell>
                    <TableCell className="font-mono text-xs text-blue-600">
                      {formatAddress(wallet.proxy_wallet)}
                    </TableCell>
                    <TableCell className="text-sm">
                      {formatUSDC(
                        wallet.total_volume_usdc
                          ? parseFloat(wallet.total_volume_usdc)
                          : null
                      )}
                    </TableCell>
                    <TableCell className="text-sm text-slate-600">
                      {wallet.trade_count ?? "—"}
                    </TableCell>
                    <TableCell>
                      <span className={`text-sm ${winRateClass(wallet.win_ratio)}`}>
                        {wallet.win_ratio
                          ? (parseFloat(wallet.win_ratio) * 100).toFixed(1) + "%"
                          : "—"}
                      </span>
                    </TableCell>
                    <TableCell className="text-sm text-slate-600">
                      {wallet.whale_trade_count ?? "—"}
                    </TableCell>
                    <TableCell className="text-xs text-slate-500">
                      {timeAgo(wallet.last_seen_at)}
                    </TableCell>
                  </TableRow>
                ))
              )}
            </TableBody>
          </Table>
        </div>
      )}

      {/* Side panel */}
      <Sheet
        open={selectedWallet !== null}
        onOpenChange={(open) => {
          if (!open) setSelectedWallet(null);
        }}
      >
        <SheetContent side="right" className="w-[420px] sm:max-w-[420px]">
          <SheetHeader>
            <SheetTitle>
              {selectedWallet ? formatAddress(selectedWallet) : "Wallet"}
            </SheetTitle>
            <p className="text-xs text-slate-500 font-mono">{selectedWallet}</p>
          </SheetHeader>
          {selectedWallet && <WalletAlerts address={selectedWallet} />}
        </SheetContent>
      </Sheet>
    </>
  );
}
