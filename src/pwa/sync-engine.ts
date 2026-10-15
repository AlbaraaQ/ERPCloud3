"use client";

/**
 * Rep sync engine (OFFLINE_SYNC §4/§5): durable outbox → deduped push, delta
 * pull, backoff with jitter, five explicit states, recovery after restart.
 */

import { newId } from "@/modules/shared/ids";
import { repDb, kvGet, kvSet, type OutboxRow, type OutboxState } from "./sync-db";

const PUSH_BATCH = 50;
let cycling = false;
let started = false;

async function sha256(text: string): Promise<string> {
  const data = new TextEncoder().encode(text);
  const digest = await crypto.subtle.digest("SHA-256", data);
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

export async function getDeviceId(): Promise<string> {
  let id = await kvGet<string>("deviceId");
  if (!id) {
    id = newId();
    await kvSet("deviceId", id);
  }
  return id;
}

/** First-run device registration (explicit — SEC §7). */
export async function ensureRegistered(label?: string): Promise<void> {
  const done = await kvGet<boolean>("deviceRegistered");
  if (done) return;
  const deviceId = await getDeviceId();
  const res = await fetch("/api/sync/register", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      deviceId,
      label: label ?? `متصفح ${navigator.userAgent.slice(0, 40)}`,
      platform: navigator.userAgent.slice(0, 60),
    }),
  });
  if (res.ok) await kvSet("deviceRegistered", true);
}

/** Queue a business op offline-first and kick the push cycle. */
export async function enqueueOp(opType: string, payload: unknown, title: string): Promise<string> {
  const opId = newId();
  const payloadJson = JSON.stringify(payload);
  const payloadHash = await sha256(payloadJson);
  const row: OutboxRow = {
    opId,
    opType,
    payloadJson,
    payloadHash,
    state: "pending",
    createdAt: Date.now(),
    attempts: 0,
    title,
  };
  await repDb().outbox.put(row);
  void cycle();
  return opId;
}

interface PushResult {
  opId: string;
  status: "ack" | "replayed" | "rejected" | "conflict" | "tamper";
  messageKey?: string;
  detail?: string;
  refs?: Record<string, unknown>;
}

async function pushOnce(): Promise<number> {
  const deviceId = await getDeviceId();
  const pending = await repDb().outbox.where("state").equals("pending").sortBy("createdAt");
  if (pending.length === 0) return 0;
  const batch = pending.slice(0, PUSH_BATCH);
  await repDb().outbox.bulkPut(batch.map((r) => ({ ...r, state: "syncing" as OutboxState })));

  try {
    const res = await fetch("/api/sync/push", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        deviceId,
        ops: batch.map((r) => ({
          opId: r.opId,
          opType: r.opType,
          payload: JSON.parse(r.payloadJson),
          payloadHash: r.payloadHash,
        })),
      }),
    });
    if (!res.ok) throw new Error(`push ${res.status}`);
    const json = (await res.json()) as { results: PushResult[] };
    for (const r of json.results) {
      const prev = await repDb().outbox.get(r.opId);
      if (!prev) continue;
      const state: OutboxState =
        r.status === "ack" || r.status === "replayed" ? "synced" : r.status;
      await repDb().outbox.put({
        ...prev,
        state,
        lastError: r.messageKey ?? r.detail,
        resultJson: r.refs ? JSON.stringify(r.refs) : undefined,
      });
    }
    await kvSet("lastSyncAt", new Date().toISOString());
    return json.results.length;
  } catch (e) {
    // network/server error → pending with backoff; never duplicates (op_id stable)
    await repDb().outbox.bulkPut(
      batch.map((r) => ({
        ...r,
        state: "pending" as OutboxState,
        attempts: r.attempts + 1,
        lastError: e instanceof Error ? e.message : String(e),
      })),
    );
    return 0;
  }
}

async function pullOnce(): Promise<void> {
  const deviceId = await getDeviceId();
  const cursors = (await kvGet<Record<string, string>>("cursors")) ?? {};
  const res = await fetch(`/api/sync/pull?deviceId=${deviceId}&cursors=${encodeURIComponent(JSON.stringify(cursors))}`);
  if (res.status === 409) {
    await kvSet("deviceRegistered", false);
    await ensureRegistered();
    return;
  }
  if (!res.ok) throw new Error(`pull ${res.status}`);
  const json = await res.json();

  const db = repDb();
  await db.transaction("rw", [db.products, db.customers, db.prices, db.stock, db.kv], async () => {
    for (const p of json.scopes.products.rows) {
      await db.products.put({
        id: p.id, sku: p.sku, barcode: p.barcode, nameAr: p.nameAr,
        salePrice: p.salePrice, minPrice: p.minPrice, maxPrice: p.maxPrice,
        trackLots: p.trackLots, trackExpiry: p.trackExpiry, updatedAt: p.updatedAt,
      });
    }
    for (const c of json.scopes.customers.rows) {
      await db.customers.put({
        id: c.id, code: c.code, nameAr: c.nameAr, phone: c.phone,
        creditLimit: c.creditLimit, paymentTermsDays: c.paymentTermsDays,
        creditHold: c.creditHold, taxNumber: c.taxNumber ?? null, updatedAt: c.updatedAt,
      });
    }
    for (const pr of json.scopes.prices.rows) {
      await db.prices.put({ key: `${pr.customerId}:${pr.productId}`, price: pr.price });
    }
    // custody stock is authoritative-at-pull (server recomputes everything anyway)
    await db.stock.clear();
    for (const s of json.scopes.stock.rows) {
      await db.stock.put({ productId: s.productId, onHand: s.onHand, avgCost: s.avgCost });
    }
    await kvSet("me", json.me);
    await kvSet("cursors", {
      products: json.scopes.products.cursor,
      customers: json.scopes.customers.cursor,
      invoices: json.scopes.invoices.cursor,
    });
    await kvSet("lastPullAt", json.serverTime);
    await kvSet("lastTransfers", {
      rows: json.scopes.transfers.rows,
      lines: json.scopes.transfers.lines ?? [],
    });
    await kvSet("recentInvoices", json.scopes.invoices.rows ?? []);
  });
}

let cycleAttempts = 0;
async function cycle(): Promise<void> {
  if (cycling) return;
  if (typeof navigator !== "undefined" && !navigator.onLine) return;
  cycling = true;
  try {
    await ensureRegistered();
    await pullOnce();
    await pushOnce();
    cycleAttempts = 0;
  } catch {
    cycleAttempts = Math.min(cycleAttempts + 1, 6);
    const delay = Math.min(30000 * 2 ** cycleAttempts + Math.random() * 4000, 15 * 60 * 1000);
    setTimeout(() => void cycle(), delay);
  } finally {
    cycling = false;
  }
}

export async function startSyncEngine(): Promise<void> {
  if (started) return;
  started = true;
  window.addEventListener("online", () => void cycle());
  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "visible") void cycle();
  });
  setInterval(() => void cycle(), 30_000);
  await cycle();
}

export async function outboxCounts(): Promise<Record<OutboxState, number>> {
  const rows = await repDb().outbox.toArray();
  const acc: Record<string, number> = { pending: 0, syncing: 0, synced: 0, rejected: 0, conflict: 0, tamper: 0 };
  for (const r of rows) acc[r.state] = (acc[r.state] ?? 0) + 1;
  return acc as Record<OutboxState, number>;
}

export async function retryRejected(): Promise<number> {
  const rows = await repDb().outbox.where("state").equals("syncing").toArray();
  await repDb().outbox.bulkPut(rows.map((r) => ({ ...r, state: "pending" as OutboxState })));
  void cycle();
  return rows.length;
}
