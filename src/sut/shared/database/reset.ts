import type pg from 'pg';
import { checksumDatabase } from './seed/checksum.js';
import { readSnapshotManifest, restoreSnapshot, SNAPSHOT_DIR } from './snapshot.js';
import type { PgContainerTarget } from './snapshot.js';
import { Database } from './db.js';
import { clearReliabilityState } from './reliability.js';

export interface ResetOptions {
  pool: pg.Pool;
  target: PgContainerTarget;
  profile: string;
  seed: number;
  snapshotDir?: string;
}

export interface ResetResult {
  snapshot: string;
  combined: string;
  durationMs: number;
}

/**
 * Restore snapshot -> verify checksum. Throws (never silently continues) when
 * the restored data differs from the seeded data, so a dirty dataset can not
 * leak into a measurement.
 */
export async function resetFromSnapshot({
  pool,
  target,
  profile,
  seed,
  snapshotDir = SNAPSHOT_DIR,
}: ResetOptions): Promise<ResetResult> {
  const started = Date.now();
  const manifest = await readSnapshotManifest(profile, seed, snapshotDir);
  await restoreSnapshot(target, manifest, snapshotDir);
  await clearReliabilityState(new Database(pool));
  const client = await pool.connect();
  try {
    const actual = await checksumDatabase(client);
    if (actual.combined !== manifest.checksum.combined) {
      throw new Error(
        `Restored checksum ${actual.combined} != snapshot ${manifest.checksum.combined}`,
      );
    }
    return { snapshot: manifest.file, combined: actual.combined, durationMs: Date.now() - started };
  } finally {
    client.release();
  }
}
