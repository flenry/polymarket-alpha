"use client";

import dynamic from "next/dynamic";
import useSWR from "swr";
import { Skeleton } from "@/components/ui/skeleton";
import type { VolumeBucket } from "@/app/api/signals/volume/route";

const SignalSparklineInner = dynamic(
  () => import("./signal-sparkline-inner"),
  { ssr: false }
);

const fetcher = (url: string) => fetch(url).then((r) => r.json());

export function SignalSparkline() {
  const { data, isLoading } = useSWR<{ buckets: VolumeBucket[] }>(
    "/api/signals/volume?hours=24",
    fetcher,
    { refreshInterval: 60_000 }
  );

  if (isLoading) {
    return <Skeleton className="h-40 w-full rounded-md" />;
  }

  const buckets = data?.buckets ?? [];

  return (
    <div className="bg-white border border-slate-200 rounded-lg p-4 shadow-sm">
      <p className="text-xs font-medium text-slate-500 uppercase tracking-wide mb-3">
        Signal Volume — Last 24h (per hour)
      </p>
      <SignalSparklineInner data={buckets} />
    </div>
  );
}
