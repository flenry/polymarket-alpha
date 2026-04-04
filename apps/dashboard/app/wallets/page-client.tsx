"use client";

import { useSearchParams } from "next/navigation";
import { WalletsTable } from "@/components/wallets-table";

export function WalletsPageClient() {
  const searchParams = useSearchParams();
  const wallet = searchParams.get("wallet") ?? undefined;
  return <WalletsTable initialWallet={wallet} />;
}
