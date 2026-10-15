/** Shared ActionResult type for server-action responses (type-only module —
 *  "use server" modules must not re-export types). */

export interface ActionResult {
  ok: boolean;
  errorKey?: string;
  okKey?: string;
}
