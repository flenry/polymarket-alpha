import { type ClassValue, clsx } from "clsx";
import { twMerge } from "tailwind-merge";

export function cn(...inputs: ClassValue[]): string {
  return twMerge(clsx(inputs));
}

/**
 * Format a USDC value as a dollar string.
 * ≥$1000: 0 decimals ("$127,400")
 * <$1000: 2 decimals ("$500.50")
 * null/undefined: "—"
 */
export function formatUSDC(value: number | null | undefined): string {
  if (value === null || value === undefined) return "—";
  const abs = Math.abs(value);
  if (abs >= 1000) {
    return new Intl.NumberFormat("en-US", {
      style: "currency",
      currency: "USD",
      minimumFractionDigits: 0,
      maximumFractionDigits: 0,
    }).format(value);
  }
  return new Intl.NumberFormat("en-US", {
    style: "currency",
    currency: "USD",
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  }).format(value);
}

/**
 * Truncate an Ethereum address to "0xABCD…1234" (first 6 + last 4 chars).
 * If address is ≤12 chars, return unchanged.
 * null/undefined: "—"
 */
export function formatAddress(address: string | null | undefined): string {
  if (address === null || address === undefined) return "—";
  if (address.length <= 12) return address;
  return `${address.slice(0, 6)}…${address.slice(-4)}`;
}

/**
 * Return a human-readable relative time string.
 * "just now" (<30s), "N min ago" (<60min), "Nh ago" (<24h), "Nd ago" (≥24h).
 * null/undefined: "—"
 */
export function timeAgo(date: Date | string | null | undefined): string {
  if (date === null || date === undefined) return "—";
  const d = typeof date === "string" ? new Date(date) : date;
  if (isNaN(d.getTime())) return "—";
  const seconds = Math.floor((Date.now() - d.getTime()) / 1000);
  if (seconds < 30) return "just now";
  if (seconds < 3600) {
    const mins = Math.floor(seconds / 60);
    return `${mins} min ago`;
  }
  if (seconds < 86400) {
    const hours = Math.floor(seconds / 3600);
    return `${hours}h ago`;
  }
  const days = Math.floor(seconds / 86400);
  return `${days}d ago`;
}
