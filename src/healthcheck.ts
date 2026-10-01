/**
 * Container healthcheck: `node dist/healthcheck.js <url>`.
 * Exits 0 only on a 2xx response within the timeout. No shell, no curl,
 * so it works on minimal images running as non-root.
 */
const url = process.argv[2] ?? 'http://localhost:3000/ready';
const timeoutMs = Number(process.env.HEALTHCHECK_TIMEOUT_MS ?? 2000);

async function check(): Promise<number> {
  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(timeoutMs) });
    return res.ok ? 0 : 1;
  } catch {
    return 1;
  }
}

check().then((code) => process.exit(code));
