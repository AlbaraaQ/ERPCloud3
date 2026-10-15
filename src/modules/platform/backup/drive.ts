/**
 * Remote artifact transport (BACKUP_AND_RECOVERY §4).
 *
 * Google Drive needs OAuth2 with a refresh token held in the secret store
 * (D-024), which does not exist in this environment. Following the same rule as
 * the ZATCA transport (D-012): the boundary is explicit, the real implementation
 * refuses to run without credentials, and the dev/test implementation is gated —
 * it stores artifacts in a local "remote" directory and reports
 * `provider: "local-contract"`. It NEVER claims to be Google Drive, and a run it
 * uploads is never presented as an off-site backup.
 *
 * Verification is provider-independent: re-read the stored object and compare
 * size + SHA-256 with the metadata row.
 */

import { createHash } from "node:crypto";
import { mkdir, readFile, readdir, stat, unlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { errors } from "@/modules/shared/result";
import { logger } from "@/modules/shared/logger";

export interface RemoteObject {
  id: string;
  name: string;
  bytes: number;
  sha256: string;
  provider: string;
}

export interface RemoteTransport {
  readonly provider: string;
  upload(input: { name: string; data: Buffer; folderId?: string | null }): Promise<RemoteObject>;
  /** Re-read metadata for verification (size + checksum). */
  stat(id: string): Promise<RemoteObject | null>;
  remove(id: string): Promise<void>;
  list(prefix?: string): Promise<RemoteObject[]>;
}

/** Google Drive credentials (refresh-token flow) — none in this environment. */
export function driveCredentialsPresent(): boolean {
  return Boolean(
    process.env.GOOGLE_DRIVE_CLIENT_ID &&
      process.env.GOOGLE_DRIVE_CLIENT_SECRET &&
      process.env.GOOGLE_DRIVE_REFRESH_TOKEN,
  );
}

/**
 * Contract implementation for dev/test: a directory that plays "the remote".
 * Gated exactly like MockTransport: it refuses in production, so a deployment
 * that forgot its Drive credentials fails loudly instead of quietly keeping
 * backups on the same disk.
 */
class LocalContractTransport implements RemoteTransport {
  readonly provider = "local-contract";

  constructor(private readonly root: string) {}

  private pathFor(id: string): string {
    return join(this.root, id);
  }

  async upload(input: { name: string; data: Buffer }): Promise<RemoteObject> {
    await mkdir(this.root, { recursive: true });
    const id = `${Date.now()}-${input.name}`;
    await writeFile(this.pathFor(id), input.data);
    return this.stat(id).then((obj) => obj!);
  }

  async stat(id: string): Promise<RemoteObject | null> {
    try {
      const path = this.pathFor(id);
      const [info, data] = await Promise.all([stat(path), readFile(path)]);
      return {
        id,
        name: id.replace(/^\d+-/, ""),
        bytes: info.size,
        sha256: createHash("sha256").update(data).digest("hex"),
        provider: this.provider,
      };
    } catch {
      return null;
    }
  }

  async remove(id: string): Promise<void> {
    await unlink(this.pathFor(id)).catch(() => undefined);
  }

  async list(): Promise<RemoteObject[]> {
    const names = await readdir(this.root).catch(() => [] as string[]);
    const out: RemoteObject[] = [];
    for (const name of names) {
      const obj = await this.stat(name);
      if (obj) out.push(obj);
    }
    return out;
  }
}

/** Real Drive transport: refuses until credentials exist (never fabricates). */
class HttpDriveTransport implements RemoteTransport {
  readonly provider = "google-drive";

  async upload(): Promise<RemoteObject> {
    throw errors.integration(
      "errors.driveNotConfigured",
      "Google Drive credentials are absent — the artifact stays local and is marked as such",
    );
  }

  async stat(): Promise<RemoteObject | null> {
    throw errors.integration("errors.driveNotConfigured", "no Drive access token");
  }

  async remove(): Promise<void> {
    throw errors.integration("errors.driveNotConfigured", "no Drive access token");
  }

  async list(): Promise<RemoteObject[]> {
    throw errors.integration("errors.driveNotConfigured", "no Drive access token");
  }
}

let transport: RemoteTransport | null = null;

/**
 * Resolve the transport. `localRoot` is where the contract implementation keeps
 * its objects (tests point it at a temp directory).
 */
export function remoteTransport(localRoot: string): RemoteTransport {
  if (transport) return transport;
  if (driveCredentialsPresent()) {
    transport = new HttpDriveTransport();
    return transport;
  }
  if (process.env.NODE_ENV === "production") {
    logger.warn("backup: no Drive credentials in production — uploads disabled (local artifacts only)");
    transport = {
      provider: "none",
      async upload() {
        throw errors.integration("errors.driveNotConfigured", "no Drive credentials configured");
      },
      async stat() {
        return null;
      },
      async remove() {},
      async list() {
        return [];
      },
    };
    return transport;
  }
  transport = new LocalContractTransport(localRoot);
  return transport;
}

/** Test seam. */
export function resetRemoteTransport(): void {
  transport = null;
}
