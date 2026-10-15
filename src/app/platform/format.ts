/**
 * Console formatters shared by server and client components.
 *
 * This module deliberately carries NO `"use client"` directive: a Server
 * Component may not call a function that lives in a client module (React would
 * have to serialize it), so anything the server pages render is kept here and
 * imported by both sides.
 */

export function fmtBytes(n: number | null | undefined): string {
  if (!n) return "—";
  const units = ["B", "KB", "MB", "GB"];
  let v = n;
  let i = 0;
  while (v >= 1024 && i < units.length - 1) {
    v /= 1024;
    i += 1;
  }
  return `${v.toFixed(v < 10 && i > 0 ? 1 : 0)} ${units[i]}`;
}

export function fmtDate(d: Date | string | null | undefined): string {
  if (!d) return "—";
  const date = typeof d === "string" ? new Date(d) : d;
  return new Intl.DateTimeFormat("en-GB", { dateStyle: "short", timeStyle: "short" }).format(date);
}

export function statusTone(status: string): "muted" | "success" | "warning" | "danger" | "info" {
  switch (status) {
    case "active":
    case "verified":
    case "uploaded":
    case "passed":
    case "ready":
    case "purged":
      return "success";
    case "trial":
    case "trialing":
    case "local_ok":
    case "running":
    case "cooling_off":
    case "requested":
    case "queued":
      return "info";
    case "suspended":
    case "failed":
    case "expired":
    case "warning":
      return "warning";
    case "deactivated":
    case "pruned":
    case "critical":
      return "danger";
    default:
      return "muted";
  }
}
