/**
 * Result type + DomainError taxonomy (SYSTEM_ARCHITECTURE §6).
 * All application services either return Result<T> or throw a DomainError
 * subclass — never raw Error — so the UI can map to actionable Arabic messages.
 */

export type Result<T, E extends DomainError = DomainError> =
  | { ok: true; value: T }
  | { ok: false; error: E };

export const ok = <T>(value: T): Result<T, never> => ({ ok: true, value });
export const err = <E extends DomainError>(error: E): Result<never, E> => ({
  ok: false,
  error,
});

export type DomainErrorKind =
  | "ValidationError"
  | "PermissionDenied"
  | "ConfigurationError"
  | "ConflictError"
  | "IntegrationError"
  | "InvariantViolation"
  | "NotFound"
  | "AuthError";

/**
 * @param messageKey  i18n key for the Arabic message (resolved by UI layer).
 * @param detail      Technical detail for logs (never shown raw to users).
 */
export class DomainError extends Error {
  readonly kind: DomainErrorKind;
  readonly messageKey: string;
  readonly detail?: string;
  readonly meta?: Record<string, unknown>;

  constructor(
    kind: DomainErrorKind,
    messageKey: string,
    detail?: string,
    meta?: Record<string, unknown>,
  ) {
    super(messageKey);
    this.name = kind;
    this.kind = kind;
    this.messageKey = messageKey;
    this.detail = detail;
    this.meta = meta;
  }
}

export const errors = {
  validation: (key: string, detail?: string, meta?: Record<string, unknown>) =>
    new DomainError("ValidationError", key, detail, meta),
  permission: (perm: string, detail?: string) =>
    new DomainError("PermissionDenied", "errors.permissionDenied", detail ?? `missing: ${perm}`, {
      permission: perm,
    }),
  /** Missing mapping / policy / input — blocks the operation with an actionable fix (INV-17). */
  configuration: (key: string, detail?: string, meta?: Record<string, unknown>) =>
    new DomainError("ConfigurationError", key, detail, meta),
  conflict: (key: string, detail?: string, meta?: Record<string, unknown>) =>
    new DomainError("ConflictError", key, detail, meta),
  integration: (key: string, detail?: string, meta?: Record<string, unknown>) =>
    new DomainError("IntegrationError", key, detail, meta),
  invariant: (detail: string, meta?: Record<string, unknown>) =>
    new DomainError("InvariantViolation", "errors.invariant", detail, meta),
  notFound: (entity: string, id?: string) =>
    new DomainError("NotFound", "errors.notFound", `${entity}${id ? `#${id}` : ""}`),
  auth: (key = "errors.invalidCredentials") => new DomainError("AuthError", key),
};

export function isDomainError(e: unknown): e is DomainError {
  return e instanceof DomainError;
}

/** Convert anything to a DomainError without leaking internals. */
export function toDomainError(e: unknown, fallbackKey = "errors.unexpected"): DomainError {
  return isDomainError(e)
    ? e
    : new DomainError("InvariantViolation", fallbackKey, e instanceof Error ? e.message : String(e));
}
