"use client";

import {
  BarChart,
  Bar,
  XAxis,
  YAxis,
  Tooltip,
  ResponsiveContainer,
  Legend,
} from "recharts";
import type { VolumeBucket } from "@/app/api/signals/volume/route";

const SIGNAL_COLORS: Record<string, string> = {
  WHALE_TRADE: "#7c3aed",           // purple-700
  ORDER_BOOK_IMBALANCE: "#2563eb",  // blue-600
  PRICE_IMPACT_ANOMALY: "#ea580c",  // orange-600
  SENTIMENT_VELOCITY: "#0d9488",    // teal-600
  NEG_RISK_ARB: "#4f46e5",          // indigo-600
  NEG_RISK_OUTLIER: "#8b5cf6",      // violet-500 (distinct from WHALE_TRADE purple-700)
};

const SIGNAL_TYPES = Object.keys(SIGNAL_COLORS);

interface Props {
  data: VolumeBucket[];
}

export default function SignalSparklineInner({ data }: Props) {
  // Pivot buckets into per-hour rows: { hour: "HH:MM", WHALE_TRADE: n, ... }
  // Use an empty object (no placeholder) to avoid the `hour` key collision
  // when spreading counts into the final row.
  const pivotMap = new Map<string, Record<string, number>>();
  for (const bucket of data) {
    const key = bucket.hour;
    if (!pivotMap.has(key)) {
      pivotMap.set(key, {});
    }
    const row = pivotMap.get(key)!;
    row[bucket.type] = (row[bucket.type] ?? 0) + bucket.count;
  }

  const chartData = Array.from(pivotMap.entries())
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([hour, counts]) => {
      const label = new Date(hour).toLocaleTimeString("en-US", {
        hour: "2-digit",
        minute: "2-digit",
      });
      // hour: label must come AFTER ...counts so it is not overwritten
      // by a stray `hour` key inside the counts object.
      return { ...counts, hour: label };
    });

  // Collect all types present in data
  const presentTypes = Array.from(
    new Set(data.map((d) => d.type))
  );

  return (
    <ResponsiveContainer width="100%" height={160}>
      <BarChart
        data={chartData}
        margin={{ top: 4, right: 8, left: -16, bottom: 0 }}
      >
        <XAxis
          dataKey="hour"
          tick={{ fontSize: 10, fill: "#64748b" }}
          interval="preserveStartEnd"
        />
        <YAxis tick={{ fontSize: 10, fill: "#64748b" }} allowDecimals={false} />
        <Tooltip
          contentStyle={{
            fontSize: 11,
            borderColor: "#e2e8f0",
            borderRadius: 6,
          }}
        />
        <Legend wrapperStyle={{ fontSize: 10 }} />
        {(presentTypes.length > 0 ? presentTypes : SIGNAL_TYPES).map((type) => (
          <Bar
            key={type}
            dataKey={type}
            stackId="a"
            fill={SIGNAL_COLORS[type] ?? "#94a3b8"}
          />
        ))}
      </BarChart>
    </ResponsiveContainer>
  );
}
