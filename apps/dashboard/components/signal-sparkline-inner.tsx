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
  WHALE_TRADE: "#7c3aed",        // purple
  BOOK_IMBALANCE: "#2563eb",     // blue
  PRICE_IMPACT_ANOMALY: "#ea580c", // orange
  SENTIMENT_VELOCITY: "#0d9488", // teal
  NEG_RISK_ARB: "#4f46e5",       // indigo
  NEG_RISK_OUTLIER: "#7c3aed",   // violet (using same as WHALE_TRADE — slight overlap)
};

const SIGNAL_TYPES = Object.keys(SIGNAL_COLORS);

interface Props {
  data: VolumeBucket[];
}

export default function SignalSparklineInner({ data }: Props) {
  // Pivot: [{ hour, WHALE_TRADE: n, BOOK_IMBALANCE: n, ... }]
  const pivotMap = new Map<string, Record<string, number>>();
  for (const bucket of data) {
    const key = bucket.hour;
    if (!pivotMap.has(key)) {
      pivotMap.set(key, { hour: 0 }); // placeholder
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
      return { hour: label, ...counts };
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
