"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import {
  Bell,
  TrendingUp,
  Map,
  Users,
  Activity,
} from "lucide-react";
import { cn } from "@/lib/utils";

const navItems = [
  { href: "/alerts", label: "Alerts", icon: Bell },
  { href: "/signals", label: "Signals", icon: TrendingUp },
  { href: "/markets", label: "Markets", icon: Map },
  { href: "/wallets", label: "Wallets", icon: Users },
  { href: "/health", label: "Health", icon: Activity },
];

export function Sidebar() {
  const pathname = usePathname();

  return (
    <aside className="w-56 min-h-screen bg-white border-r border-slate-200 flex flex-col">
      <div className="px-4 py-5 border-b border-slate-200">
        <h1 className="text-sm font-semibold text-slate-900 tracking-tight">
          Polymarket Alpha
        </h1>
        <p className="text-xs text-slate-500 mt-0.5">Dashboard</p>
      </div>
      <nav className="flex-1 p-2">
        {navItems.map(({ href, label, icon: Icon }) => {
          const active = pathname === href || pathname.startsWith(`${href}/`);
          return (
            <Link
              key={href}
              href={href}
              className={cn(
                "flex items-center gap-3 px-3 py-2 rounded-md text-sm font-medium transition-colors mb-0.5",
                active
                  ? "bg-slate-100 text-blue-600"
                  : "text-slate-600 hover:bg-slate-50 hover:text-slate-900"
              )}
            >
              <Icon className="h-4 w-4 shrink-0" />
              {label}
            </Link>
          );
        })}
      </nav>
    </aside>
  );
}
