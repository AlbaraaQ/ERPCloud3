/**
 * Secret handling shared by the platform tier (D-024).
 *
 * - AES-256-GCM authenticated encryption for secrets stored in the database
 *   (TOTP seeds) and for backup artifacts at rest.
 * - Keys come from the environment only (`HISAB_ENCRYPTION_KEY`, 32 bytes as
 *   base64 or hex) and are NEVER written to source control, logs or metadata.
 * - A missing/short key is a configuration error: callers must fail loudly
 *   rather than fall back to plaintext.
 */

import { createCipheriv, createDecipheriv, createHash, randomBytes } from "node:crypto";
import { errors } from "./result";

const KEY_ENV = "HISAB_ENCRYPTION_KEY";
const MAGIC = "HISAB1"; // format tag so future key rotation can be detected
const NONCE_BYTES = 12;
const TAG_BYTES = 16;

/** Parse the app key from env — base64 or hex, exactly 32 bytes. */
export function appKey(): Buffer {
  const raw = process.env[KEY_ENV];
  if (!raw) {
    throw errors.configuration(
      "errors.encryptionKeyMissing",
      `${KEY_ENV} is not set — secrets and backups cannot be encrypted`,
    );
  }
  const key = /^[0-9a-fA-F]{64}$/.test(raw) ? Buffer.from(raw, "hex") : Buffer.from(raw, "base64");
  if (key.length !== 32) {
    throw errors.configuration(
      "errors.encryptionKeyInvalid",
      `${KEY_ENV} must decode to 32 bytes (got ${key.length})`,
    );
  }
  return key;
}

export function encryptionKeyConfigured(): boolean {
  try {
    appKey();
    return true;
  } catch {
    return false;
  }
}

/** Encrypt a UTF-8 string (or bytes) → `HISAB1.<nonce>.<tag>.<ciphertext>` (all base64). */
export function encryptSecret(plaintext: string | Buffer, key: Buffer = appKey()): string {
  const data = typeof plaintext === "string" ? Buffer.from(plaintext, "utf8") : plaintext;
  const nonce = randomBytes(NONCE_BYTES);
  const cipher = createCipheriv("aes-256-gcm", key, nonce);
  const ciphertext = Buffer.concat([cipher.update(data), cipher.final()]);
  const tag = cipher.getAuthTag();
  return [MAGIC, nonce.toString("base64"), tag.toString("base64"), ciphertext.toString("base64")].join(".");
}

/** Decrypt a value produced by `encryptSecret`. Throws on tampering (GCM tag). */
export function decryptSecret(value: string, key: Buffer = appKey()): Buffer {
  const parts = value.split(".");
  if (parts.length !== 4 || parts[0] !== MAGIC) {
    throw errors.invariant("ciphertext has an unknown format tag");
  }
  const [, nonce, tag, ciphertext] = parts;
  const decipher = createDecipheriv("aes-256-gcm", key, Buffer.from(nonce!, "base64"));
  decipher.setAuthTag(Buffer.from(tag!, "base64"));
  return Buffer.concat([decipher.update(Buffer.from(ciphertext!, "base64")), decipher.final()]);
}

export function decryptToString(value: string, key: Buffer = appKey()): string {
  return decryptSecret(value, key).toString("utf8");
}

/** SHA-256 of a string or buffer, hex-encoded (checksums for artifacts). */
export function sha256Hex(data: string | Buffer): string {
  return createHash("sha256").update(data).digest("hex");
}

/** Random URL-safe token (download links, grant ids exposed to URLs). */
export function randomToken(bytes = 32): string {
  return randomBytes(bytes).toString("base64url");
}
