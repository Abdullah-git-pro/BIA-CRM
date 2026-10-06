/**
 * Seed-list inbox placement testing — the one place the CRM talks to the seed tool.
 *
 * Named for what it does, not for the vendor, and the vendor's brand appears in no
 * exported name and no thrown message — the same rule leadCampaign.ts follows, so
 * swapping tools is a change to this file rather than a find-replace across services.
 *
 * ── What this measures, and what it cannot ────────────────────────────────────
 * Nothing in this file says where a real homeowner's email landed. That is unobservable:
 * no provider reports it and no amount of integration will produce it. What a seed test
 * gives is a SAMPLE — the same campaign, sent to the tool's own mailboxes across the
 * major providers — and the share of those that reached the inbox. It stands in for the
 * real list the way a poll stands in for an election.
 *
 * It is the only measurement available for §02's gate on sending, and §08 wants it
 * weekly. It is not evidence about any individual lead.
 *
 * ── Verified against the published API spec, 6 Oct 2026 ──────────────────────
 *   • Auth is the `x-api-key` HEADER. The prose says "the apiKey parameter"; the OpenAPI
 *     security definition says header, and the header is what works.
 *   • Rate limit is 50 requests/second — three orders of magnitude above the campaign
 *     platform's 20/minute, so no budget is kept here.
 *   • The API is not available on free accounts. A plan without it answers 401/403 on
 *     every call, which is reported as a configuration problem rather than an outage.
 */

const API_BASE = 'https://api.glockapps.com/gateway/spamtest-v2/api';

function apiKey(): string {
  const key = process.env.GLOCK_API_KEY;
  if (!key?.trim()) throw new Error('GLOCK_API_KEY not configured');
  return key.trim();
}

/** True when a key is present — lets a route answer "are we connected?" without a call. */
export function isConfigured(): boolean {
  return Boolean(process.env.GLOCK_API_KEY?.trim());
}

async function apiFetch(path: string, init: RequestInit = {}): Promise<Response> {
  const headers: Record<string, string> = {
    'x-api-key': apiKey(),
    ...(init.body != null ? { 'content-type': 'application/json' } : {}),
    ...(init.headers as Record<string, string> ?? {}),
  };

  const res = await fetch(`${API_BASE}${path}`, {
    ...init,
    headers,
    signal: AbortSignal.timeout(30000),
  });

  if (!res.ok) {
    const body = await res.text().catch(() => '');
    // "Seed tool", not the vendor's name: these reach people in toasts.
    if (res.status === 401 || res.status === 403) {
      throw new Error(
        'Seed tool rejected the API key. The key is wrong, or the account is on a free '
        + 'plan — the API is only available on paid plans.',
      );
    }
    throw new Error(
      `Seed tool ${init.method ?? 'GET'} ${path} → HTTP ${res.status}: ${body.slice(0, 300)}`,
    );
  }
  return res;
}

const getJson = async <T>(path: string): Promise<T> => (await apiFetch(path)).json() as Promise<T>;

// ─── Types, named for what they mean here ────────────────────────────────────

/**
 * The placement breakdown for one test.
 *
 * `other` is the vendor's name for everything delivered outside the primary inbox —
 * Gmail's Promotions and Updates tabs, mostly. It is NOT spam, and conflating the two
 * would report a campaign as filtered when it was merely tabbed.
 *
 * `notDelivered` is the one with no counterpart in our own data: accepted and then
 * dropped, with no bounce. Our send log counts exactly that as delivered.
 */
export type PlacementStats = {
  inbox: number;
  inboxRate: number;
  other: number;
  otherRate: number;
  spam: number;
  spamRate: number;
  notDelivered: number;
  notDeliveredRate: number;
};

export type SeedTestResult = {
  testId: string;
  /** When the test ran, ISO. */
  created: string | null;
  /** False while seeds are still arriving — a half-finished test is not a reading. */
  finished: boolean;
  failed: boolean;
  stats: PlacementStats | null;
  seedCount: number | null;
  /** The domain the mail was actually sent from, as the receiving servers saw it. */
  senderDomain: string | null;
  senderIp: string | null;
  /** 'pass' / 'fail' / 'none', straight from the tool. */
  spf: string | null;
  dkim: string | null;
  dmarc: string | null;
  senderScore: number | null;
  spamAssassinScore: number | null;
  /** Blocklists the sending IP or domain was found on. Empty is the good answer. */
  blocklists: string[];
  autoTestId: string | null;
  note: string | null;
};

type RawStats = Partial<PlacementStats>;
type RawTest = {
  testId?: string;
  created?: string;
  finished?: boolean;
  failedReport?: boolean;
  stats?: RawStats;
  seedAccountsTotal?: number;
  autoTestId?: string;
  note?: string;
  authenticationResult?: {
    senderDomain?: string; senderIp?: string;
    spfAuth?: string; dkimAuth?: string; dmarcAuth?: string; senderScore?: number;
  };
  spamAssassin?: { score?: number };
  dnsbl?: { results?: Array<{ name?: string; listed?: boolean }> };
};

const num = (v: unknown): number => Number(v ?? 0);

function toResult(t: RawTest): SeedTestResult {
  const a = t.authenticationResult ?? {};
  const s = t.stats;
  return {
    testId: String(t.testId ?? ''),
    created: t.created ?? null,
    finished: t.finished === true,
    failed: t.failedReport === true,
    stats: s
      ? {
        inbox: num(s.inbox), inboxRate: num(s.inboxRate),
        other: num(s.other), otherRate: num(s.otherRate),
        spam: num(s.spam), spamRate: num(s.spamRate),
        notDelivered: num(s.notDelivered), notDeliveredRate: num(s.notDeliveredRate),
      }
      : null,
    seedCount: t.seedAccountsTotal ?? null,
    senderDomain: a.senderDomain ?? null,
    senderIp: a.senderIp ?? null,
    spf: a.spfAuth ?? null,
    dkim: a.dkimAuth ?? null,
    dmarc: a.dmarcAuth ?? null,
    senderScore: a.senderScore ?? null,
    spamAssassinScore: t.spamAssassin?.score ?? null,
    blocklists: (t.dnsbl?.results ?? []).filter((r) => r.listed).map((r) => String(r.name ?? '')).filter(Boolean),
    autoTestId: t.autoTestId ?? null,
    note: t.note ?? null,
  };
}

export type SeedProject = {
  id: string;
  name: string;
  /** Send anything to this address and a test fires. Null until one is generated. */
  autoTestEmail: string | null;
};

/**
 * Unwrap a list response, loudly.
 *
 * ── Why this is not `json.results ?? []` ─────────────────────────────────────
 * It was, with the key guessed as `result`, and the account's one project came back as
 * zero. Not an error — a 200 with a shape the parser did not recognise, reported as "the
 * seed tool holds no projects", which is a sentence a person would act on.
 *
 * The envelope is `{ results: [...], page, status }`. A missing key now throws, because
 * an empty list and an unread list have to be distinguishable: the first is a fact about
 * the account, the second is a bug in this file.
 */
function unwrapList<T>(json: unknown, path: string): T[] {
  const r = (json as { results?: unknown })?.results;
  if (Array.isArray(r)) return r as T[];
  throw new Error(
    `Seed tool ${path} returned no "results" array — the response shape has changed. `
    + `Got keys: ${Object.keys((json ?? {}) as object).join(', ') || '(none)'}`,
  );
}

/** The projects configured in the tool. One per sending domain is the intended setup. */
export async function listProjects(): Promise<SeedProject[]> {
  const json = await getJson<unknown>('/projects?limit=100');
  return unwrapList<Record<string, unknown>>(json, 'GET /projects').map((p) => ({
    id: String(p.id ?? ''),
    name: String(p.name ?? ''),
    autoTestEmail: (p.autoTestEmail as string) || null,
  })).filter((p) => p.id);
}

/**
 * Finished test reports for a project, newest first.
 *
 * Paged by the tool; the cap exists for the same reason every pagination loop in this
 * codebase has one — a vendor bug should slow a screen down, not hang it.
 */
export async function listTests(projectId: string, opts: { limit?: number } = {}): Promise<SeedTestResult[]> {
  const limit = Math.min(opts.limit ?? 50, 100);
  const path = `/projects/${encodeURIComponent(projectId)}/tests/list?limit=${limit}`;
  return unwrapList<RawTest>(await getJson<unknown>(path), `GET ${path}`).map(toResult);
}

/** One test report in full. */
export async function getTest(projectId: string, testId: string): Promise<SeedTestResult> {
  const json = await getJson<{ result?: RawTest }>(
    `/projects/${encodeURIComponent(projectId)}/tests?testId=${encodeURIComponent(testId)}`,
  );
  if (!json.result) throw new Error(`Seed tool returned no test ${testId}`);
  return toResult(json.result);
}
