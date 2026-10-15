/**
 * Backup artifact encryption (BACKUP_AND_RECOVERY §3, D-024).
 *
 * AES-256-GCM with a key from the environment (`HISAB_ENCRYPTION_KEY`, base64 or
 * hex, 32 bytes). No key ⇒ no backup: we refuse to write a plaintext artifact
 * rather than "succeeding" with an unprotected one. Rotation is supported by
 * decrypting with the current key first and then any key in
 * `HISAB_ENCRYPTION_KEYS_OLD` (comma-separated), so old artifacts stay readable
 * while new ones use the new key.
 */

import { createCipheriv, createDecipheriv, createHash, randomBytes } from "node:crypto";

const ARTIFACT_PREFIX = "HISABBK1";
const SECRET_PREFIX = "HISABS1";
const KEY_BYTES = 32;

export class EncryptionKeyError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "EncryptionKeyError";
  }
}

function parseKey(raw: string, source: string): Buffer {
  const value = raw.trim();
  let key: Buffer | null = null;
  if (/^[0-9a-fA-F]{64}$/.test(value)) key = Buffer.from(value, "hex");
  else {
    try {
      const b64 = Buffer.from(value, "base64");
      if (b64.length === KEY_BYTES) key = b64;
    } catch {
      key = null;
    }
  }
  if (!key || key.length !== KEY_BYTES) {
    throw new EncryptionKeyError(`${source} must be 32 bytes (base64 or 64 hex chars)`);
  }
  return key;
}

/** Keys in decryption order: current first, then any previous keys. */
export function encryptionKeys(): Buffer[] {
  const current = process.env.HISAB_ENCRYPTION_KEY;
  if (!current) {
    throw new EncryptionKeyError(
      "HISAB_ENCRYPTION_KEY is not set — encrypted backups and stored platform secrets are unavailable",
    );
  }
  const keys = [parseKey(current, "HISAB_ENCRYPTION_KEY")];
  const old = process.env.HISAB_ENCRYPTION_KEYS_OLD;
  if (old) {
    for (const [i, part] of old.split(",").entries()) {
      try {
        keys.push(parseKey(part, `HISAB_ENCRYPTION_KEYS_OLD[${i}]`));
      } catch {
        // a malformed old key must not block decryption with the current one
      }
    }
  }
  return keys;
}

function encryptWith(key: Buffer, prefix: string, plaintext: Buffer): string {
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", key, iv);
  const ciphertext = Buffer.concat([cipher.update(plaintext), cipher.final()]);
  const tag = cipher.getAuthTag();
  return [prefix, iv.toString("base64"), tag.toString("base64"), ciphertext.toString("base64")].join(".");
}

function decryptWith(key: Buffer, prefix: string, envelope: string): Buffer {
  const [head, ivB64, tagB64, ctB64] = envelope.split(".");
  if (head !== prefix) throw new EncryptionKeyError(`unexpected envelope prefix: ${head}`);
  if (!ivB64 || !tagB64 || !ctB64) throw new EncryptionKeyError("malformed envelope");
  const decipher = createDecipheriv("aes-256-gcm", key, Buffer.from(ivB64, "base64"));
  decipher.setAuthTag(Buffer.from(tagB64, "base64"));
  return Buffer.concat([decipher.update(Buffer.from(ctB64, "base64")), decipher.final()]);
}

function decrypt(envelope: string, prefix: string): Buffer {
  const keys = encryptionKeys();
  let lastError: unknown = null;
  for (const key of keys) {
    try {
      return decryptWith(key, prefix, envelope);
    } catch (e) {
      lastError = e;
    }
  }
  throw new EncryptionKeyError(
    `could not decrypt (${keys.length} key(s) tried): ${lastError instanceof Error ? lastError.message : "unknown"}`,
  );
}

/** Encrypt a backup artifact. Returns a single-line envelope (safe for text files). */
export function encryptArtifact(plaintext: Buffer): string {
  return encryptWith(encryptionKeys()[0]!, ARTIFACT_PREFIX, plaintext);
}

export function decryptArtifact(envelope: string): Buffer {
  return decrypt(envelope, ARTIFACT_PREFIX);
}

export function isEncryptedArtifact(text: string): boolean {
  return text.startsWith(`${ARTIFACT_PREFIX}.`);
}

/** Small secrets at rest (TOTP, provider tokens) — same cipher, own prefix. */
export function encryptSecret(plaintext: string): string {
  return encryptWith(encryptionKeys()[0]!, SECRET_PREFIX, Buffer.from(plaintext, "utf8"));
}

export function decryptSecret(envelope: string): string {
  return decrypt(envelope, SECRET_PREFIX).toString("utf8");
}

export function sha256Hex(data: Buffer | string): string {
  return createHash("sha256").update(data).digest("hex");
}

export function sha256OfFileBuffer(buffer: Buffer): string {
  return sha256Hex(buffer);
}
