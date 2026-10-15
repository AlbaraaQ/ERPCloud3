/**
 * Structured logging (pino, JSON) with secret redaction (SECURITY_AND_TENANCY §5).
 */

import pino from "pino";

const level = process.env.LOG_LEVEL ?? (process.env.NODE_ENV === "production" ? "info" : "debug");

export const logger = pino({
  level,
  base: { app: "hisab-erp" },
  redact: {
    paths: [
      "password",
      "password_hash",
      "*.password",
      "*.passwordHash",
      "*.token",
      "*.session",
      "*.secret",
      "*.apiKey",
      "*.authorization",
      "req.headers.authorization",
      "req.headers.cookie",
    ],
    censor: "[redacted]",
  },
  formatters: {
    level: (label) => ({ level: label }),
  },
});

export type Logger = typeof logger;

export function childLogger(bindings: Record<string, unknown>): Logger {
  return logger.child(bindings) as Logger;
}
