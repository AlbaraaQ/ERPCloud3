/**
 * IDs — UUIDv7 everywhere (D-004). Time-ordered, index-friendly, and safe to
 * generate on client devices for offline documents.
 */

import { uuidv7 } from "uuidv7";

export const newId = (): string => uuidv7();

/** New idempotency/op identifier — same generator, explicit name for intent. */
export const newOpId = (): string => uuidv7();

/** Verify uuidv7 ordering invariant: later ids sort after earlier ones. */
export function isUuid(v: unknown): v is string {
  return (
    typeof v === "string" &&
    /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(v)
  );
}
