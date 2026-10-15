"use client";

/** Durable local store for the rep PWA (OFFLINE_SYNC §2). */

import Dexie, { type Table } from "dexie";

export type OutboxState = "pending" | "syncing" | "synced" | "rejected" | "conflict" | "tamper";

export interface OutboxRow {
  opId: string;
  opType: string;
  payloadJson: string;
  payloadHash: string;
  state: OutboxState;
  createdAt: number;
  attempts: number;
  lastError?: string;
  resultJson?: string;
  title: string;
}

export interface KvRow {
  key: string;
  value: unknown;
}

export interface CacheProduct {
  id: string;
  sku: string;
  barcode: string | null;
  nameAr: string;
  salePrice: string;
  minPrice: string | null;
  maxPrice: string | null;
  trackLots: boolean;
  trackExpiry: boolean;
  updatedAt: string;
}

export interface CacheCustomer {
  id: string;
  code: string;
  nameAr: string;
  phone: string | null;
  creditLimit: string;
  paymentTermsDays: number;
  creditHold: boolean;
  taxNumber?: string | null;
  updatedAt: string;
}

export interface CachePrice {
  key: string; // customerId:productId
  price: string;
}

export interface CacheStock {
  productId: string;
  onHand: string;
  avgCost: string;
}

class RepDb extends Dexie {
  outbox!: Table<OutboxRow, string>;
  kv!: Table<KvRow, string>;
  products!: Table<CacheProduct, string>;
  customers!: Table<CacheCustomer, string>;
  prices!: Table<CachePrice, string>;
  stock!: Table<CacheStock, string>;

  constructor() {
    super("hisab_rep");
    this.version(1).stores({
      outbox: "opId, state, createdAt",
      kv: "key",
      products: "id, sku, nameAr",
      customers: "id, code, nameAr",
      prices: "key",
      stock: "productId",
    });
  }
}

let _db: RepDb | null = null;
export function repDb(): RepDb {
  if (!_db) _db = new RepDb();
  return _db;
}

export async function kvGet<T>(key: string): Promise<T | null> {
  const row = await repDb().kv.get(key);
  return (row?.value as T) ?? null;
}

export async function kvSet(key: string, value: unknown): Promise<void> {
  await repDb().kv.put({ key, value });
}
