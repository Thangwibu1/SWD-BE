/** Dev compose PostgreSQL (infra/dev/postgres.compose.yaml). */
export const DEFAULT_DEV_DATABASE_URL = 'postgres://bench:bench@127.0.0.1:25432/ecommerce';

/** Tiny `--key value` / `--flag` parser for maintenance scripts. */
export function parseArgs(argv: readonly string[] = process.argv.slice(2)): Map<string, string> {
  const args = new Map<string, string>();
  for (let i = 0; i < argv.length; i += 1) {
    const token = argv[i] ?? '';
    if (!token.startsWith('--')) continue;
    const [key, inline] = token.slice(2).split('=', 2) as [string, string | undefined];
    if (inline !== undefined) args.set(key, inline);
    else if (argv[i + 1] && !argv[i + 1]?.startsWith('--')) args.set(key, argv[++i] as string);
    else args.set(key, 'true');
  }
  return args;
}

export function requireEnv(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`Environment variable ${name} is required`);
  return value;
}

export async function runScript(fn: () => Promise<void>): Promise<void> {
  try {
    await fn();
  } catch (error) {
    console.error(error instanceof Error ? error.message : error);
    process.exitCode = 1;
  }
}
