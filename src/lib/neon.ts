import { neon, Pool, neonConfig } from '@neondatabase/serverless';

/**
 * `sql` — tagged-template client for static/simple one-off queries.
 * Usage: const rows = await sql`SELECT 1`;
 *
 * `pool` — Pool client for parameterized queries via pool.query(sql, params).
 * Uses Neon's HTTP transport (no persistent TCP), safe on serverless.
 *
 * Both are wrapped with a connect-failure retry — see withRetry below.
 */

neonConfig.fetchConnectionCache = true;

/**
 * ── A connect timeout long enough to reach us-east-1 from outside it ───────
 *
 * undici defaults to a 10s connect timeout. On Vercel that is enormous — the function
 * runs in the same AWS region as the database and connects in single-digit milliseconds.
 * From a developer machine it is marginal: measured with a bare fetch and no application
 * code in the way, the first connection to the Neon host took 8,731ms, and subsequent
 * ones 1.1–2.6s. Right on the boundary, which is why local pages 500 while the same
 * code serves Live without trouble.
 *
 * The retry made it worse rather than better. Three attempts each waiting the full 10s
 * meant a developer watched a page hang for 33–41 seconds and then fail, when one
 * patient attempt would have succeeded.
 *
 * 30s applies everywhere, because it costs nothing where connects are fast: a timeout is
 * a ceiling, not a delay. Deployed, nothing changes. Locally, the first request after an
 * idle period waits instead of failing.
 *
 * Set via a custom fetch rather than a global undici dispatcher so it cannot alter the
 * timeouts of every other outbound call in the process — the vendor clients have their
 * own deadlines and should keep them.
 */
const CONNECT_TIMEOUT_MS = 30_000;
neonConfig.fetchFunction = (input: RequestInfo | URL, init?: RequestInit) => fetch(input, {
  ...init,
  signal: init?.signal ?? AbortSignal.timeout(CONNECT_TIMEOUT_MS),
});

// Tagged-template client (used for static queries in storage.service.ts)
const globalForNeon = globalThis as unknown as {
  sql: ReturnType<typeof neon> | undefined;
  pool: Pool | undefined;
};

/**
 * Neon is reached over HTTPS in us-east-1. A cold database or a slow link can push
 * TCP+TLS connect past undici's 10s default, which surfaces as:
 *   NeonDbError: Error connecting to database: fetch failed
 *     └ cause: ConnectTimeoutError (UND_ERR_CONNECT_TIMEOUT)
 * The next attempt almost always succeeds once the connection is warm, so a
 * cold start should never 500 a page.
 *
 * We deliberately retry ONLY connect-phase failures. Those mean the request never
 * reached the server, so replaying them is safe even for INSERT/UPDATE. A generic
 * post-send failure is NOT retried — the write may have already applied, and
 * duplicating it would be worse than surfacing the error.
 */
function isConnectFailure(err: any): boolean {
  const codes = [err?.code, err?.cause?.code, err?.sourceError?.code, err?.sourceError?.cause?.code]
    .filter(Boolean)
    .map(String);
  if (codes.some((c) => /^(UND_ERR_CONNECT_TIMEOUT|ECONNREFUSED|EAI_AGAIN|ENOTFOUND)$/.test(c))) return true;
  const msg = [err?.message, err?.cause?.message, err?.sourceError?.message].filter(Boolean).join(' ');
  return /Connect ?Timeout ?Error/i.test(msg);
}

async function withRetry<T>(run: () => Promise<T>, tries = 3): Promise<T> {
  let last: unknown;
  for (let attempt = 0; attempt < tries; attempt++) {
    try {
      return await run();
    } catch (err) {
      last = err;
      if (!isConnectFailure(err) || attempt === tries - 1) throw err;
      // 500ms, then 1s — enough for a cold Neon endpoint to come up.
      await new Promise((r) => setTimeout(r, 500 * 2 ** attempt));
    }
  }
  throw last;
}

function makeSql(): ReturnType<typeof neon> {
  const raw = neon(process.env.DATABASE_URL!);
  // This codebase only ever calls sql as a tagged template, so wrapping the call
  // signature preserves every existing usage.
  const wrapped = (strings: TemplateStringsArray, ...values: unknown[]) =>
    withRetry(() => (raw as any)(strings, ...values));
  return wrapped as unknown as ReturnType<typeof neon>;
}

function makePool(): Pool {
  const p = new Pool({ connectionString: process.env.DATABASE_URL! });
  const origQuery = p.query.bind(p);
  (p as any).query = (...args: unknown[]) => withRetry(() => (origQuery as any)(...args));
  return p;
}

export const sql = globalForNeon.sql ?? makeSql();
export const pool = globalForNeon.pool ?? makePool();

if (process.env.NODE_ENV !== 'production') {
  globalForNeon.sql = sql;
  globalForNeon.pool = pool;
}

export default sql;
