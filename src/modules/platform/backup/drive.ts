/**
 * Remote (off-site) backup transport — Google Drive (BACKUP_AND_RECOVERY §4).
 *
 * Two transports, one rule: **never claim an upload that did not happen**.
 *   - `HttpDriveTransport` — real Drive API calls, used only when OAuth
 *     credentials are present in the environment. Its behaviour cannot be
 *     verified in this environment (no credentials may be assumed), so a run
 *     against it stays `local_ok` until a real metadata re-read confirms it.
 *   - `ContractDriveTransport` — development/test stand-in that stores the
 *     artifact in a local directory and *says so* (`provider: "local-contract"`).
 *     It refuses to operate when `NODE_ENV=production`.
 *
 * Verification is always: re-read the object from the transport and compare size
 * and checksum. A missing verification is recorded as unverified, not as success.
 */

import { createHash } from "node:crypto";
import { copyFile, mkdir, readFile, readdir, stat, unlink } from "node:fs/promises";
import { basename, join } from "node:path";
import { logger } from "@/modules/shared/logger";

export interface RemoteObject {
  id: string;
  bytes: number;
  sha256: string | null;
}

export interface RemoteDrive {
  readonly provider: string;
  /** true only for the real provider — used to label the panel honestly */
  readonly offsite: boolean;
  upload(name: string, filePath: string): Promise<RemoteObject>;
  stat(id: string): Promise<RemoteObject | null>;
  remove(id: string): Promise<void>;
  list(): Promise<RemoteObject[]>;
}

function sha256(buffer: Buffer): string {
  return createHash("sha256").update(buffer).digest("hex");
}

export function driveCredentialsPresent(): boolean {
  return Boolean(
    process.env.GOOGLE_DRIVE_CLIENT_ID &&
      process.env.GOOGLE_DRIVE_CLIENT_SECRET &&
      process.env.GOOGLE_DRIVE_REFRESH_TOKEN,
  );
}

/* --------------------------------------------------------- contract transport */

/**
 * Development stand-in. It is deliberately obvious in the UI (`local-contract`)
 * and refuses in production, because a "backup uploaded to Drive" that never
 * left the host is the most dangerous kind of green check mark.
 */
export class ContractDriveTransport implements RemoteDrive {
  readonly provider = "local-contract";
  readonly offsite = false;
  constructor(private readonly root: string) {}

  private async ensureRoot(): Promise<string> {
    if (process.env.NODE_ENV === "production") {
      throw new Error(
        "contract backup transport is a development stand-in and must not be used in production",
      );
    }
    const dir = join(this.root, "remote-contract");
    await mkdir(dir, { recursive: true });
    return dir;
  }

  async upload(name: string, filePath: string): Promise<RemoteObject> {
    const dir = await this.ensureRoot();
    const target = join(dir, basename(name));
    await copyFile(filePath, target);
    const info = await stat(target);
    const hash = sha256(await readFile(target));
    logger.info({ provider: this.provider, name, bytes: info.size }, "contract remote upload");
    return { id: target, bytes: info.size, sha256: hash };
  }

  async stat(id: string): Promise<RemoteObject | null> {
    const info = await stat(id).catch(() => null);
    if (!info?.isFile()) return null;
    return { id, bytes: info.size, sha256: sha256(await readFile(id)) };
  }

  async remove(id: string): Promise<void> {
    await unlink(id).catch(() => undefined);
  }

  async list(): Promise<RemoteObject[]> {
    const dir = join(this.root, "remote-contract");
    const names = await readdir(dir).catch(() => [] as string[]);
    const out: RemoteObject[] = [];
    for (const n of names) {
      const info = await this.stat(join(dir, n));
      if (info) out.push(info);
    }
    return out;
  }
}

/* ------------------------------------------------------------- Drive transport */

interface DriveCredentials {
  clientId: string;
  clientSecret: string;
  refreshToken: string;
  folderId: string | null;
}

function credentials(): DriveCredentials | null {
  if (!driveCredentialsPresent()) return null;
  return {
    clientId: process.env.GOOGLE_DRIVE_CLIENT_ID!,
    clientSecret: process.env.GOOGLE_DRIVE_CLIENT_SECRET!,
    refreshToken: process.env.GOOGLE_DRIVE_REFRESH_TOKEN!,
    folderId: process.env.GOOGLE_DRIVE_FOLDER_ID ?? null,
  };
}

/**
 * Google Drive transport (drive/v3). Uploads use a simple multipart upload; the
 * artifact is encrypted before it leaves the host, so Drive never holds plaintext
 * books. Metadata is re-read for verification.
 */
export class HttpDriveTransport implements RemoteDrive {
  readonly provider = "google-drive";
  readonly offsite = true;
  private token: { value: string; expiresAt: number } | null = null;

  constructor(private readonly creds: DriveCredentials) {}

  private async accessToken(): Promise<string> {
    if (this.token && this.token.expiresAt > Date.now() + 30_000) return this.token.value;
    const res = await fetch("https://oauth2.googleapis.com/token", {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        client_id: this.creds.clientId,
        client_secret: this.creds.clientSecret,
        refresh_token: this.creds.refreshToken,
        grant_type: "refresh_token",
      }),
    });
    if (!res.ok) throw new Error(`drive token refresh failed (${res.status})`);
    const json = (await res.json()) as { access_token?: string; expires_in?: number };
    if (!json.access_token) throw new Error("drive token refresh returned no access_token");
    this.token = {
      value: json.access_token,
      expiresAt: Date.now() + (json.expires_in ?? 3600) * 1000,
    };
    return this.token.value;
  }

  async upload(name: string, filePath: string): Promise<RemoteObject> {
    const token = await this.accessToken();
    const bytes = await readFile(filePath);
    const metadata = {
      name: basename(name),
      ...(this.creds.folderId ? { parents: [this.creds.folderId] } : {}),
    };
    const boundary = `hisab-${Date.now().toString(36)}`;
    const body = Buffer.concat([
      Buffer.from(
        `--${boundary}\r\ncontent-type: application/json; charset=UTF-8\r\n\r\n${JSON.stringify(metadata)}\r\n`,
      ),
      Buffer.from(`--${boundary}\r\ncontent-type: application/octet-stream\r\n\r\n`),
      bytes,
      Buffer.from(`\r\n--${boundary}--\r\n`),
    ]);

    const res = await fetch("https://www.googleapis.com/upload/drive/v3/files?uploadType=multipart&fields=id,size", {
      method: "POST",
      headers: {
        authorization: `Bearer ${token}`,
        "content-type": `multipart/related; boundary=${boundary}`,
      },
      body: new Uint8Array(body),
    });
    if (!res.ok) {
      const detail = await res.text().catch(() => "");
      throw new Error(`drive upload failed (${res.status}): ${detail.slice(0, 200)}`);
    }
    const json = (await res.json()) as { id?: string; size?: string };
    if (!json.id) throw new Error("drive upload returned no file id");
    return { id: json.id, bytes: bytes.length, sha256: sha256(bytes) };
  }

  async stat(id: string): Promise<RemoteObject | null> {
    const token = await this.accessToken();
    const res = await fetch(`https://www.googleapis.com/drive/v3/files/${id}?fields=id,size,trashed`, {
      headers: { authorization: `Bearer ${token}` },
    });
    if (res.status === 404) return null;
    if (!res.ok) throw new Error(`drive metadata read failed (${res.status})`);
    const json = (await res.json()) as { id?: string; size?: string; trashed?: boolean };
    if (!json.id || json.trashed) return null;
    return { id: json.id, bytes: Number(json.size ?? 0), sha256: null };
  }

  async remove(id: string): Promise<void> {
    const token = await this.accessToken();
    const res = await fetch(`https://www.googleapis.com/drive/v3/files/${id}`, {
      method: "DELETE",
      headers: { authorization: `Bearer ${token}` },
    });
    if (!res.ok && res.status !== 404) throw new Error(`drive delete failed (${res.status})`);
  }

  async list(): Promise<RemoteObject[]> {
    const token = await this.accessToken();
    const parent = this.creds.folderId ? `'${this.creds.folderId}' in parents and ` : "";
    const res = await fetch(
      `https://www.googleapis.com/drive/v3/files?q=${encodeURIComponent(`${parent}trashed=false`)}&fields=files(id,size)`,
      { headers: { authorization: `Bearer ${token}` } },
    );
    if (!res.ok) throw new Error(`drive list failed (${res.status})`);
    const json = (await res.json()) as { files?: { id: string; size?: string }[] };
    return (json.files ?? []).map((f) => ({ id: f.id, bytes: Number(f.size ?? 0), sha256: null }));
  }
}

/* ------------------------------------------------------------------ selection */

/**
 * Transport in force. `folderId` comes from platform settings (`driveFolderId`),
 * overridable by the environment. No credentials ⇒ contract transport in dev,
 * and an explicit refusal in production (a job must then fail loudly and alert,
 * not pretend the copy is off-site).
 */
export function driveTransport(opts: { root: string; folderId?: string | null }): RemoteDrive {
  const creds = credentials();
  if (creds) {
    return new HttpDriveTransport({ ...creds, folderId: opts.folderId ?? creds.folderId });
  }
  return new ContractDriveTransport(opts.root);
}

/** Status for the console + docs: what the next run will actually do. */
export function driveStatus(opts: { root: string; folderId?: string | null }): {
  transport: RemoteDrive;
  configured: boolean;
  productionSafe: boolean;
} {
  const transport = driveTransport(opts);
  return {
    transport,
    configured: driveCredentialsPresent(),
    productionSafe: driveCredentialsPresent() || process.env.NODE_ENV !== "production",
  };
}
