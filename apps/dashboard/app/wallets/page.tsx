import { Suspense } from "react";
import { WalletsPageClient } from "./page-client";

export default function WalletsPage() {
  return (
    <div className="p-6 space-y-6">
      <div>
        <h1 className="text-xl font-semibold text-slate-900">
          Wallet Leaderboard
        </h1>
        <p className="text-sm text-slate-500 mt-0.5">
          Ranked by win rate — min 3 resolved trades
        </p>
      </div>

      <Suspense fallback={null}>
        <WalletsPageClient />
      </Suspense>
    </div>
  );
}
