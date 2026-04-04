import { MarketsHeatmap } from "@/components/markets-heatmap";

export default function MarketsPage() {
  return (
    <div className="p-6 space-y-6">
      <div>
        <h1 className="text-xl font-semibold text-slate-900">Market Heat Map</h1>
        <p className="text-sm text-slate-500 mt-0.5">
          Top 20 markets by signal activity — last 24h
        </p>
      </div>

      <MarketsHeatmap />
    </div>
  );
}
