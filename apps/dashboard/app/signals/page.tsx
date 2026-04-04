import { SignalSparkline } from "@/components/signal-sparkline";
import { SignalsTable } from "@/components/signals-table";

export default function SignalsPage() {
  return (
    <div className="p-6 space-y-6">
      <div>
        <h1 className="text-xl font-semibold text-slate-900">Signals</h1>
        <p className="text-sm text-slate-500 mt-0.5">Signal stream with filters</p>
      </div>

      <SignalSparkline />
      <SignalsTable />
    </div>
  );
}
