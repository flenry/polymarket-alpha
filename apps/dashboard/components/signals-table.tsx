"use client";

import { useState, useCallback } from "react";
import useSWR from "swr";
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
import { Progress } from "@/components/ui/progress";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Slider } from "@/components/ui/slider";
import { timeAgo } from "@/lib/utils";
import type { SignalRow, SignalType } from "@/app/api/signals/route";

const POLL_MS = parseInt(
  process.env.NEXT_PUBLIC_DASHBOARD_POLL_INTERVAL_MS ?? "5000",
  10
);

const SIGNAL_TYPE_CONFIG: Record<
  string,
  { label: string; variant: "purple" | "blue" | "orange" | "teal" | "indigo" | "violet" }
> = {
  WHALE_TRADE: { label: "WHALE_TRADE", variant: "purple" },
  ORDER_BOOK_IMBALANCE: { label: "ORDER_BOOK_IMBALANCE", variant: "blue" },
  PRICE_IMPACT_ANOMALY: { label: "PRICE_IMPACT_ANOMALY", variant: "orange" },
  SENTIMENT_VELOCITY: { label: "SENTIMENT_VELOCITY", variant: "teal" },
  NEG_RISK_ARB: { label: "NEG_RISK_ARB", variant: "indigo" },
  NEG_RISK_OUTLIER: { label: "NEG_RISK_OUTLIER", variant: "violet" },
};

const ALL_TYPES: SignalType[] = [
  "WHALE_TRADE",
  "ORDER_BOOK_IMBALANCE",
  "PRICE_IMPACT_ANOMALY",
  "SENTIMENT_VELOCITY",
  "NEG_RISK_ARB",
  "NEG_RISK_OUTLIER",
];

const fetcher = (url: string) => fetch(url).then((r) => r.json());

function buildUrl(
  types: SignalType[],
  minConfidence: number,
  hours: string,
  tokenId?: string
): string {
  const params = new URLSearchParams();
  if (types.length > 0) params.set("types", types.join(","));
  params.set("minConfidence", String(minConfidence / 100));
  params.set("hours", hours);
  if (tokenId) params.set("tokenId", tokenId);
  return `/api/signals?${params.toString()}`;
}

interface Props {
  initialTokenId?: string;
}

export function SignalsTable({ initialTokenId }: Props) {
  const [selectedTypes, setSelectedTypes] = useState<SignalType[]>([]);
  const [minConfidence, setMinConfidence] = useState<number>(0); // 0-100
  const [hours, setHours] = useState<string>("24");

  const url = buildUrl(selectedTypes, minConfidence, hours, initialTokenId);
  const { data, isLoading } = useSWR<{ signals: SignalRow[] }>(url, fetcher, {
    refreshInterval: POLL_MS,
  });

  const toggleType = useCallback((type: SignalType) => {
    setSelectedTypes((prev) =>
      prev.includes(type) ? prev.filter((t) => t !== type) : [...prev, type]
    );
  }, []);

  const signals = data?.signals ?? [];

  return (
    <div className="space-y-4">
      {/* Filter bar */}
      <div className="flex flex-wrap items-center gap-4 bg-white border border-slate-200 rounded-lg p-4 shadow-sm">
        <div className="flex flex-wrap gap-1.5">
          {ALL_TYPES.map((type) => {
            const cfg = SIGNAL_TYPE_CONFIG[type];
            const active = selectedTypes.includes(type);
            return (
              <button
                key={type}
                onClick={() => toggleType(type)}
                className={`text-xs px-2.5 py-1 rounded-full border font-medium transition-colors ${
                  active
                    ? "bg-blue-600 text-white border-blue-600"
                    : "bg-white text-slate-600 border-slate-200 hover:bg-slate-50"
                }`}
              >
                {cfg?.label ?? type}
              </button>
            );
          })}
        </div>

        <div className="flex items-center gap-2 min-w-[180px]">
          <span className="text-xs text-slate-500 whitespace-nowrap">
            Min conf: {minConfidence}%
          </span>
          <Slider
            min={0}
            max={100}
            step={5}
            value={[minConfidence]}
            onValueChange={([v]) => setMinConfidence(v)}
            className="w-28"
          />
        </div>

        <Select value={hours} onValueChange={setHours}>
          <SelectTrigger className="w-28">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="1">Last 1h</SelectItem>
            <SelectItem value="6">Last 6h</SelectItem>
            <SelectItem value="24">Last 24h</SelectItem>
            <SelectItem value="168">Last 7d</SelectItem>
          </SelectContent>
        </Select>
      </div>

      {/* Table */}
      <div className="bg-white border border-slate-200 rounded-lg shadow-sm overflow-hidden">
        {isLoading ? (
          <div className="p-4 space-y-2">
            {Array.from({ length: 6 }).map((_, i) => (
              <Skeleton key={i} className="h-10 w-full rounded" />
            ))}
          </div>
        ) : (
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Time</TableHead>
                <TableHead>Market</TableHead>
                <TableHead>Signal Type</TableHead>
                <TableHead>Direction</TableHead>
                <TableHead>Confidence</TableHead>
                <TableHead>Strength</TableHead>
                <TableHead>Composite</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {signals.length === 0 ? (
                <TableRow>
                  <TableCell
                    colSpan={7}
                    className="text-center text-slate-500 text-sm py-12"
                  >
                    No signals in the selected window
                  </TableCell>
                </TableRow>
              ) : (
                signals.map((sig, idx) => {
                  const cfg = SIGNAL_TYPE_CONFIG[sig.signal_type] ?? {
                    label: sig.signal_type,
                    variant: "blue" as const,
                  };
                  const conf = Math.round(parseFloat(sig.confidence) * 100);
                  const payload = sig.payload as Record<string, unknown> | null;
                  const compositeScore =
                    payload && typeof payload === "object"
                      ? (payload.compositeScore as number | undefined)
                      : undefined;
                  const isEven = idx % 2 === 0;

                  return (
                    <TableRow
                      key={sig.id}
                      className={isEven ? "bg-white" : "bg-slate-50"}
                    >
                      <TableCell className="text-xs text-slate-500 whitespace-nowrap">
                        {timeAgo(sig.created_at)}
                      </TableCell>
                      <TableCell className="text-xs max-w-[200px] truncate">
                        {sig.question ?? sig.token_id}
                      </TableCell>
                      <TableCell>
                        <Badge variant={cfg.variant}>{cfg.label}</Badge>
                      </TableCell>
                      <TableCell>
                        {sig.direction === "BULLISH" ? (
                          <span className="text-green-700 text-sm font-medium">
                            ▲ BULL
                          </span>
                        ) : sig.direction === "BEARISH" ? (
                          <span className="text-red-700 text-sm font-medium">
                            ▼ BEAR
                          </span>
                        ) : (
                          <span className="text-slate-400 text-sm">—</span>
                        )}
                      </TableCell>
                      <TableCell className="w-32">
                        <div className="flex items-center gap-2">
                          <Progress value={conf} className="h-1.5 w-16" />
                          <span className="text-xs text-slate-500">
                            {conf}%
                          </span>
                        </div>
                      </TableCell>
                      <TableCell className="text-xs text-slate-600">
                        {sig.strength
                          ? parseFloat(sig.strength).toFixed(2)
                          : "—"}
                      </TableCell>
                      <TableCell>
                        {compositeScore !== undefined ? (
                          <span className="text-amber-600 text-xs font-medium">
                            ⭐ {Number(compositeScore).toFixed(3)}
                          </span>
                        ) : (
                          <span className="text-slate-400 text-xs">—</span>
                        )}
                      </TableCell>
                    </TableRow>
                  );
                })
              )}
            </TableBody>
          </Table>
        )}
      </div>
    </div>
  );
}
