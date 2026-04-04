import { cn } from "@/lib/utils";

interface StatCardProps {
  title: string;
  value: string;
  subtitle?: string;
  className?: string;
}

export function StatCard({ title, value, subtitle, className }: StatCardProps) {
  return (
    <div
      className={cn(
        "bg-white border border-slate-200 rounded-lg p-5 shadow-sm",
        className
      )}
    >
      <p className="text-xs font-medium text-slate-500 uppercase tracking-wide">
        {title}
      </p>
      <p className="mt-1.5 text-2xl font-semibold text-slate-900">{value}</p>
      {subtitle && (
        <p className="mt-1 text-xs text-slate-500">{subtitle}</p>
      )}
    </div>
  );
}
