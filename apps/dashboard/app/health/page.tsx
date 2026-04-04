import { HealthPanel } from "@/components/health-panel";

export default function HealthPage() {
  return (
    <div className="p-6 space-y-6">
      <div>
        <h1 className="text-xl font-semibold text-slate-900">Pipeline Health</h1>
        <p className="text-sm text-slate-500 mt-0.5">
          Status of all pipeline components — refreshes every 10s
        </p>
      </div>

      <HealthPanel />
    </div>
  );
}
