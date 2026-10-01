import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { mkdir, readFile, rename, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { execa } from 'execa';
import type { DatasetChecksum } from './seed/checksum.js';

/**
 * Snapshots are pg_dump custom-format files produced and restored with the
 * PostgreSQL client tools INSIDE the postgres container (`docker exec`), so the
 * host needs no PostgreSQL install and tool versions always match the server.
 * Every argument is passed as an array element: no shell string is built.
 */
export interface PgContainerTarget {
  dockerBin: string;
  container: string;
  user: string;
  database: string;
}

export interface SnapshotManifest {
  file: string;
  profile: string;
  seed: number;
  sha256: string;
  sizeBytes: number;
  checksum: DatasetChecksum;
  createdAt: string;
}

const CONTAINER_NAME = /^[a-zA-Z0-9][a-zA-Z0-9_.-]{0,127}$/;
const PG_IDENTIFIER = /^[a-z_][a-z0-9_]{0,62}$/;

function assertTarget(target: PgContainerTarget): void {
  if (!CONTAINER_NAME.test(target.container))
    throw new Error(`Invalid container name: ${target.container}`);
  if (!PG_IDENTIFIER.test(target.user)) throw new Error(`Invalid PostgreSQL user: ${target.user}`);
  if (!PG_IDENTIFIER.test(target.database))
    throw new Error(`Invalid PostgreSQL database: ${target.database}`);
}

export const SNAPSHOT_DIR = path.resolve('database/snapshots');

export function snapshotBaseName(profile: string, seed: number): string {
  if (!/^[a-z]+$/.test(profile) || !Number.isInteger(seed))
    throw new Error('Invalid snapshot identity');
  return `${profile}-${seed}`;
}

export async function sha256File(file: string): Promise<string> {
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(file)) hash.update(chunk as Buffer);
  return hash.digest('hex');
}

/** Dumps the database to <dir>/<profile>-<seed>.dump and writes a manifest next to it. */
export async function createSnapshot(
  target: PgContainerTarget,
  identity: { profile: string; seed: number; checksum: DatasetChecksum },
  dir = SNAPSHOT_DIR,
): Promise<SnapshotManifest> {
  assertTarget(target);
  await mkdir(dir, { recursive: true });
  const base = snapshotBaseName(identity.profile, identity.seed);
  const finalPath = path.join(dir, `${base}.dump`);
  const tmpPath = `${finalPath}.partial`;
  await execa(
    target.dockerBin,
    [
      'exec',
      target.container,
      'pg_dump',
      '-U',
      target.user,
      '-d',
      target.database,
      '--format=custom',
      '--no-owner',
      '--no-privileges',
      '--compress=6',
    ],
    { stdout: { file: tmpPath }, stderr: 'pipe' },
  );
  await rename(tmpPath, finalPath);
  const manifest: SnapshotManifest = {
    file: `${base}.dump`,
    profile: identity.profile,
    seed: identity.seed,
    sha256: await sha256File(finalPath),
    sizeBytes: (await stat(finalPath)).size,
    checksum: identity.checksum,
    createdAt: new Date().toISOString(),
  };
  await writeFile(
    path.join(dir, `${base}.manifest.json`),
    `${JSON.stringify(manifest, null, 2)}\n`,
  );
  return manifest;
}

export async function readSnapshotManifest(
  profile: string,
  seed: number,
  dir = SNAPSHOT_DIR,
): Promise<SnapshotManifest> {
  const base = snapshotBaseName(profile, seed);
  return JSON.parse(
    await readFile(path.join(dir, `${base}.manifest.json`), 'utf8'),
  ) as SnapshotManifest;
}

/**
 * Restores a snapshot into the target database. The file hash is verified
 * BEFORE restore so a corrupted/tampered dump never reaches the SUT; the
 * caller must verify the dataset checksum AFTER restore (see verifyRestore).
 */
export async function restoreSnapshot(
  target: PgContainerTarget,
  manifest: SnapshotManifest,
  dir = SNAPSHOT_DIR,
): Promise<void> {
  assertTarget(target);
  const file = path.join(dir, path.basename(manifest.file));
  const actual = await sha256File(file);
  if (actual !== manifest.sha256) {
    throw new Error(
      `Snapshot ${manifest.file} sha256 mismatch (expected ${manifest.sha256}, got ${actual})`,
    );
  }
  await execa(
    target.dockerBin,
    [
      'exec',
      '-i',
      target.container,
      'pg_restore',
      '-U',
      target.user,
      '-d',
      target.database,
      '--clean',
      '--if-exists',
      '--no-owner',
      '--no-privileges',
      '--single-transaction',
      '--exit-on-error',
    ],
    { inputFile: file, stderr: 'pipe' },
  );
}

export function checksumsEqual(a: DatasetChecksum, b: DatasetChecksum): boolean {
  return a.combined === b.combined;
}
