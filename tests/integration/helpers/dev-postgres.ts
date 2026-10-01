import { readFileSync } from 'node:fs';
import path from 'node:path';
import { execa } from 'execa';

/**
 * Starts an isolated, throwaway PostgreSQL container (pinned version from
 * versions.env) on a random free host port. Each test file gets its own
 * container name so suites never share state.
 */
export interface TestPostgres {
  container: string;
  url: string;
  stop: () => Promise<void>;
}

export function pinnedVersions(): Record<string, string> {
  const text = readFileSync(path.resolve('versions.env'), 'utf8');
  return Object.fromEntries(
    text
      .split(/\r?\n/)
      .filter((l) => /^[A-Z0-9_]+=/.test(l))
      .map((l) => {
        const i = l.indexOf('=');
        return [l.slice(0, i), l.slice(i + 1).trim()];
      }),
  );
}

export async function startTestPostgres(name: string): Promise<TestPostgres> {
  if (!/^[a-z0-9-]{3,40}$/.test(name)) throw new Error(`Invalid test container name ${name}`);
  const container = `arch-eval-test-${name}`;
  const image = `postgres:${pinnedVersions().POSTGRES_VERSION}`;
  await execa('docker', ['rm', '-f', container], { reject: false });
  await execa('docker', [
    'run',
    '-d',
    '--name',
    container,
    '--tmpfs',
    '/var/lib/postgresql/data',
    '-e',
    'POSTGRES_USER=bench',
    '-e',
    'POSTGRES_PASSWORD=bench',
    '-e',
    'POSTGRES_DB=ecommerce',
    '-p',
    '127.0.0.1::5432',
    image,
  ]);
  const { stdout } = await execa('docker', ['port', container, '5432/tcp']);
  const port = stdout.split(/\r?\n/)[0]?.split(':').pop();
  if (!port) throw new Error(`Could not resolve mapped port for ${container}`);
  for (let i = 0; i < 60; i += 1) {
    const ready = await execa(
      'docker',
      ['exec', container, 'pg_isready', '-U', 'bench', '-d', 'ecommerce', '-h', '127.0.0.1'],
      { reject: false },
    );
    if (ready.exitCode === 0) break;
    await new Promise((r) => setTimeout(r, 500));
  }
  return {
    container,
    url: `postgres://bench:bench@127.0.0.1:${port}/ecommerce`,
    stop: async () => {
      await execa('docker', ['rm', '-f', container], { reject: false });
    },
  };
}
