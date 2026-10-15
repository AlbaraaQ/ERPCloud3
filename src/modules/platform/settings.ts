/**
 * Platform settings (key/value, platform-owned).
 *
 * Everything the console must be able to change without a deploy: backup
 * directory, retention policy, Drive folder, staleness threshold, deletion
 * cooling-off window. Defaults are code-side so a fresh database behaves
 * sensibly, and every write is audited by the caller.
 */

import { eq } from "drizzle-orm";
import { db } from "@/db";
import { platformSettings } from "@/db/schema";
import type { DbExecutor } from "@/modules/shared/db-context";

export interface BackupPolicy {
  /** Directory for encrypted artifacts (never inside the web root). */
  directory: string;
  /** Minimum number of successful backups to keep (BACKUP_AND_RECOVERY §2: ≥18). */
  keepLatest: number;
  /** Optional GFS: keep N daily and M weekly artifacts in addition. */
  keepDaily: number;
  keepWeekly: number;
  /** Stale-backup alert threshold in hours (spec: alert if last verified is older). */
  staleAfterHours: number;
  /** Upload artifacts to the remote provider when a transport is configured. */
  uploadToRemote: boolean;
}

export interface PlatformSettings {
  backup: BackupPolicy;
  /** Deletion cooling-off window in days (PLATFORM_ADMIN §5, default 14). */
  deletionCoolingOffDays: number;
  /** Drive folder id for the "ERP Backups" folder (BACKUP_AND_RECOVERY §4). */
  driveFolderId: string | null;
  /** Support-grant maximum lifetime in hours (spec: ≤ 24 h). */
  supportGrantMaxHours: number;
  /** Default plan for newly created tenants. */
  defaultPlanCode: string;
}

export const SETTINGS_DEFAULTS: PlatformSettings = {
  backup: {
    directory: process.env.BACKUP_DIR ?? ".backups",
    keepLatest: 18,
    keepDaily: 14,
    keepWeekly: 8,
    staleAfterHours: 8,
    uploadToRemote: true,
  },
  deletionCoolingOffDays: 14,
  driveFolderId: null,
  supportGrantMaxHours: 24,
  defaultPlanCode: "starter",
};

export const SETTINGS_KEY = "platform";

export async function getSettings(exec: DbExecutor = db): Promise<PlatformSettings> {
  const [row] = await exec
    .select()
    .from(platformSettings)
    .where(eq(platformSettings.key, SETTINGS_KEY))
    .limit(1);
  const stored = (row?.value as Partial<PlatformSettings> | undefined) ?? {};
  return {
    ...SETTINGS_DEFAULTS,
    ...stored,
    backup: { ...SETTINGS_DEFAULTS.backup, ...(stored.backup ?? {}) },
  };
}

export async function saveSettings(
  patch: Partial<PlatformSettings>,
  updatedByLabel: string,
): Promise<PlatformSettings> {
  const current = await getSettings();
  const next: PlatformSettings = {
    ...current,
    ...patch,
    backup: { ...current.backup, ...(patch.backup ?? {}) },
  };
  await db
    .insert(platformSettings)
    .values({ key: SETTINGS_KEY, value: next, updatedByLabel })
    .onConflictDoUpdate({
      target: platformSettings.key,
      set: { value: next, updatedAt: new Date(), updatedByLabel },
    });
  return next;
}
