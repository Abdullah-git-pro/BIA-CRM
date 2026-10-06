/**
 * Lead campaign platform — the one place the CRM talks to the outbound email vendor.
 *
 * Every outbound call goes through here. The vendor's brand name appears nowhere in
 * an exported name or in any thrown message, and the key is read from a generic env
 * var, so swapping vendors is a change to this file rather than a find-replace across
 * routes and UI copy.
 *
 * ── Verified against the live API, Sep-2026 ────────────────────────────────────
 * Auth is `Authorization: Bearer <key>`; a bogus key returns 401, so the header is
 * genuinely what authenticates. Confirmed empirically rather than from the docs,
 * along with three shapes that are not what you would guess:
 *
 *   • Listing leads is POST /leads/list, not GET /leads (which 404s).
 *   • There is NO bulk lead endpoint — /leads/bulk and /leads/list/bulk both 404.
 *     POST /leads creates exactly one. So addLeadsToCampaign loops and reports a
 *     result per lead; a partial failure is normal and must not fail the batch.
 *   • Campaign analytics for every campaign comes back from ONE call, so the
 *     overview never needs N+1 per-campaign requests.
 *
 * Errors are thrown plainly for the route layer to map to a 502. Pagination loops carry
 * a hard page ceiling as a defence against an infinite loop on a vendor bug.
 *
 * ── The rate limit, which the vendor does not advertise ───────────────────────
 * Verified 5 Oct 2026: the 21st request in a minute comes back
 *
 *   429 {"message":"Rate limit exceeded. Maximum 20 requests per minute allowed."}
 *
 * and there is no `X-RateLimit-*` header and no `Retry-After` on any response, so the
 * only way to know is to count. Every call goes through `limiter`, and a 429 that slips
 * past it is retried rather than thrown — see the note on apiFetch.
 */

import { RateLimiter, RateLimitExceededError } from '@/lib/rateLimit';

const API_BASE = 'https://api.instantly.ai/api/v2';

/** Defensive ceiling on any pagination loop — not rate limiting. */
const MAX_PAGES = 10;
const PAGE_SIZE = 100;

/**
 * 18 of the vendor's 20, because the two windows are not the same clock.
 *
 * The vendor's minute starts whenever it decides; ours starts at the first request we
 * count. Near a boundary our "20th" can be its "21st", so the last two are left unused
 * and the retry below absorbs the rest.
 */
const RATE_BUDGET = 18;
const RATE_WINDOW_MS = 60_000;
/**
 * How long a caller will queue for a slot.
 *
 * A route handler is waiting on this and the platform it runs on has its own timeout, so
 * the queue has to stay well inside one. Eight seconds absorbs an ordinary burst; past
 * that the budget is genuinely oversubscribed and a person should be told rather than
 * left watching a spinner.
 */
const RATE_MAX_WAIT_MS = 8_000;
/**
 * The pause after the vendor says we are over the limit.
 *
 * Shorter than the window on purpose: the limit is a rolling minute, so slots free up
 * continuously and a full 60-second sit-out is both unnecessary and longer than any
 * caller can wait. Must stay below RATE_MAX_WAIT_MS or the retry cannot survive its own
 * cooldown — which is exactly the bug that made one 429 fail every request for a minute.
 */
const RATE_COOLDOWN_MS = 6_000;
const RETRY_429_TIMES = 1;

const limiter = new RateLimiter({
  budget: RATE_BUDGET,
  windowMs: RATE_WINDOW_MS,
  maxWaitMs: RATE_MAX_WAIT_MS,
});

/** Slots left in this process's window. For diagnostics — never branch on it. */
export function rateBudgetRemaining(): number {
  return limiter.available();
}

function apiKey(): string {
  const key = process.env.LEADS_CAMPAIGN_API_KEY;
  if (!key?.trim()) throw new Error('LEADS_CAMPAIGN_API_KEY not configured');
  return key.trim();
}

/** True when a key is present — lets a route answer "are we connected?" without a call. */
export function isConfigured(): boolean {
  return Boolean(process.env.LEADS_CAMPAIGN_API_KEY?.trim());
}

async function apiFetch(path: string, init: RequestInit = {}): Promise<Response> {
  // content-type ONLY when there is a body to describe.
  //
  // The vendor's Fastify layer rejects a bodiless request that declares JSON with
  // FST_ERR_CTP_EMPTY_JSON_BODY — "Body cannot be empty when content-type is set to
  // 'application/json'". Sending it unconditionally made every DELETE /leads/{id} and
  // DELETE /accounts/{email} fail with a 400, so those never worked. Inconsistently,
  // the vendor accepts the same bodiless DELETE on /campaigns/{id}, which is why
  // campaign deletion looked fine and hid this.
  const headers: Record<string, string> = {
    Authorization: `Bearer ${apiKey()}`,
    ...(init.body != null ? { 'content-type': 'application/json' } : {}),
    ...(init.headers as Record<string, string> ?? {}),
  };

  /*
   * ── Budget first, then the request; a 429 is retried, not thrown ───────────
   *
   * `limiter.take()` waits for a slot rather than failing, so a busy minute makes this
   * slower instead of breaking the caller. A 429 can still arrive — another serverless
   * instance sharing the key, or the vendor's window not lining up with ours — and when
   * it does the local count is wrong, so the budget is marked spent and we wait out a
   * full window before trying again.
   *
   * Retried only RETRY_429_TIMES: beyond that the key is genuinely oversubscribed and a
   * person should be told, not kept waiting.
   */
  let res: Response | null = null;
  for (let attempt = 0; ; attempt++) {
    try {
      await limiter.take();
    } catch (err) {
      if (err instanceof RateLimitExceededError) {
        throw new Error(
          'Campaign tool is busy — it allows 20 requests a minute, and that budget is '
          + 'shared by everyone using the CRM. Give it a few seconds and try again.',
        );
      }
      throw err;
    }

    res = await fetch(`${API_BASE}${path}`, {
      ...init,
      headers,
      signal: AbortSignal.timeout(30000),
    });

    if (res.status !== 429) break;

    // Body must be read even when discarded, or the connection is held open.
    await res.text().catch(() => '');
    // The cooldown is all the waiting there is: the next take() sits out whatever is
    // left of it, so there is no second sleep here to double the delay.
    limiter.block(RATE_COOLDOWN_MS);
    if (attempt >= RETRY_429_TIMES) {
      throw new Error(
        'Campaign tool is rate limited — it allows 20 requests a minute, and that budget '
        + 'is shared by everyone using the CRM. Give it a few seconds and try again.',
      );
    }
  }

  if (!res.ok) {
    const bodyText = await res.text().catch(() => '');
    // Deliberately says "Campaign tool", not the vendor's name: these messages reach
    // producers in toasts.
    throw new Error(
      `Campaign tool ${init.method ?? 'GET'} ${path} → HTTP ${res.status}: ${bodyText.slice(0, 300)}`,
    );
  }
  return res;
}

const getJson = async <T>(path: string): Promise<T> => (await apiFetch(path)).json() as Promise<T>;
const postJson = async <T>(path: string, body: unknown): Promise<T> =>
  (await apiFetch(path, { method: 'POST', body: JSON.stringify(body) })).json() as Promise<T>;

/**
 * True when a page cannot be followed by another — so the cursor is not worth a request.
 *
 * ── Why a cursor is not enough to go on ───────────────────────────────────────
 * This vendor returns `next_starting_after` on EVERY page, including the last one. Trusting
 * it meant every pager ended with a request that came back empty: reading the six replies
 * in the inbox cost two requests instead of one, and each conversation another two instead
 * of one — half of a twenty-per-minute budget spent proving there was nothing left.
 *
 * A page shorter than the page size cannot have more behind it, so that is the real
 * end-of-list signal. The cursor is still honoured for a full page.
 */
const lastPage = (items: unknown[], pageSize: number, cursor?: string | null): boolean =>
  !cursor || !items.length || items.length < pageSize;

/** Walk a cursor-paginated list endpoint to the page ceiling. */
async function paginate<T>(path: string): Promise<T[]> {
  const out: T[] = [];
  let cursor: string | undefined;
  for (let page = 0; page < MAX_PAGES; page++) {
    const sep = path.includes('?') ? '&' : '?';
    const url = `${path}${sep}limit=${PAGE_SIZE}${cursor ? `&starting_after=${encodeURIComponent(cursor)}` : ''}`;
    const json = await getJson<{ items?: T[]; next_starting_after?: string }>(url);
    const items = json.items ?? [];
    out.push(...items);
    if (lastPage(items, PAGE_SIZE, json.next_starting_after)) break;
    cursor = json.next_starting_after;
  }
  return out;
}

// ─── Types ────────────────────────────────────────────────────────────────────

/** Vendor campaign status codes. 1 = active is the only one we act on. */
export const CAMPAIGN_STATUS: Record<number, string> = {
  0: 'Draft',
  1: 'Active',
  2: 'Paused',
  3: 'Completed',
  4: 'Running subsequences',
};

export type Campaign = {
  id: string;
  name: string;
  status: number;
  daily_limit?: number;
  stop_on_reply?: boolean;
  insert_unsubscribe_header?: boolean;
  link_tracking?: boolean;
  open_tracking?: boolean;
  email_list?: string[];
  campaign_schedule?: {
    schedules?: Array<{
      name?: string;
      timing?: { from?: string; to?: string };
      days?: Record<string, boolean>;
      timezone?: string;
    }>;
  };
  sequences?: Array<{ steps?: Array<{ type?: string; delay?: number; variants?: Array<{ subject?: string; body?: string }> }> }>;
  timestamp_created?: string;
};

/**
 * Per-campaign counters for EVERY campaign, from one call.
 *
 * ── The unique counters were returned all along and never declared ───────────
 * This type listed only the totals, so the campaigns list divided TOTAL opens by sends
 * while a campaign's own page divided UNIQUE openers by sends. One label, two
 * definitions, and the list read higher whenever somebody opened twice.
 *
 * The endpoint returns both — verified live 6 Oct 2026, the payload carries
 * open_count_unique, reply_count_unique and link_click_count_unique beside the totals.
 * Nothing was missing but the declaration, which is why nothing ever failed.
 *
 * Bounces have no unique variant and need none: a bounce is already per recipient.
 */
export type CampaignAnalytics = {
  campaign_id: string;
  campaign_name: string;
  campaign_status: number;
  leads_count: number;
  contacted_count: number;
  emails_sent_count: number;
  open_count: number;
  /** Distinct people who opened. This is the one a rate may be built on. */
  open_count_unique?: number;
  reply_count: number;
  reply_count_unique?: number;
  link_click_count: number;
  link_click_count_unique?: number;
  bounced_count: number;
  unsubscribed_count: number;
  completed_count: number;
};

export type EmailAccount = {
  email: string;
  first_name?: string;
  last_name?: string;
  warmup_status?: number;
  stat_warmup_score?: number;
  daily_limit?: number;
  tracking_domain_name?: string | null;
  tracking_domain_status?: string | null;
  status?: number;
  /** True while the platform is still provisioning it — not a usable sender yet. */
  setup_pending?: boolean;
  is_managed_account?: boolean;
};

/** One lead as the vendor stores it. `payload` holds whatever custom fields we sent. */
export type VendorLead = {
  id: string;
  email: string;
  /** Names live at the TOP level. `payload` carries them too, but camelCased —
   *  reading payload.first_name (snake, inside payload) finds neither. */
  first_name?: string;
  last_name?: string;
  campaign?: string;
  status?: number;
  email_open_count?: number;
  email_reply_count?: number;
  email_click_count?: number;
  timestamp_last_contact?: string | null;
  /**
   * When this contact last replied. Written the moment the reply arrives, unlike the
   * campaign analytics counters, which are batched and trail it by minutes — which is
   * why the analytics panel reconciles against this field.
   */
  timestamp_last_reply?: string | null;
  payload?: Record<string, unknown>;
};

export type LeadInput = {
  email: string;
  first_name?: string;
  last_name?: string;
  company_name?: string;
  /** Merge fields available to the sequence copy as {{key}}. */
  custom_variables?: Record<string, string | number | null>;
};

// ─── Campaigns ────────────────────────────────────────────────────────────────

/**
 * Light picker list — id/name/status only.
 * Doubles as the connection check, so keep it cheap: no analytics fetch here.
 */
/**
 * timestamp_created is carried through because the list response already contains it.
 *
 * Fetching it any other way means getCampaign() per campaign — nine extra round trips for a
 * date the first call already returned. Every caller that only wants id/name/status is
 * unaffected; it is one more field on an object they already have.
 */
export async function listCampaigns(): Promise<
  Array<Pick<Campaign, 'id' | 'name' | 'status' | 'timestamp_created'>>
> {
  const items = await paginate<Campaign>('/campaigns');
  return items.map((c) => ({
    id: c.id, name: c.name, status: c.status, timestamp_created: c.timestamp_created,
  }));
}

export async function getCampaign(id: string): Promise<Campaign> {
  return getJson<Campaign>(`/campaigns/${encodeURIComponent(id)}`);
}

/**
 * Replace a campaign's email sequence.
 *
 * ── Why this exists ─────────────────────────────────────────────────────────
 * The subject and body were hand-typed into the platform, so the same sentence lived in two
 * places and the copies drifted: an em-dash lost, one subject truncated to "the last
 * stretc", a step 1 carrying the step 2 line. Worse, six campaigns referenced
 * {{first_name}} when the platform's built-in is {{firstName}} — which renders nothing, so
 * the first line read "Hi ,".
 *
 * ── Whole-sequence write, and that is the dangerous part ────────────────────
 * The vendor has no endpoint for one step, so the entire `sequences` array is sent. Anything
 * the caller omits from it is GONE — a step somebody added on the platform this morning
 * included. So callers build the new array from a FRESH getCampaign() read and change only
 * the fields they mean to, rather than from anything cached.
 */
export async function updateCampaignSequences(
  id: string,
  sequences: unknown[],
): Promise<Campaign> {
  return (await apiFetch(`/campaigns/${encodeURIComponent(id)}`, {
    method: 'PATCH',
    body: JSON.stringify({ sequences }),
  })).json() as Promise<Campaign>;
}

/**
 * Every campaign's counters in ONE call — merge into the list client-side by id.
 * Doing this per campaign would be N+1 for a dashboard that always shows all of them.
 */
export async function getAllCampaignAnalytics(): Promise<CampaignAnalytics[]> {
  const json = await getJson<CampaignAnalytics[]>('/campaigns/analytics');
  return Array.isArray(json) ? json : [];
}

/**
 * Whole-campaign counters. Distinguishes total from unique deliberately: a single
 * recipient opening five times is five opens but one person, and only the unique
 * figure divided by sends is a rate anyone should quote.
 */
export type CampaignOverview = {
  emails_sent_count?: number;
  contacted_count?: number;
  open_count?: number;
  open_count_unique?: number;
  link_click_count?: number;
  link_click_count_unique?: number;
  reply_count?: number;
  reply_count_unique?: number;
  bounced_count?: number;
  unsubscribed_count?: number;
  completed_count?: number;
  total_opportunities?: number;
};

export type CampaignDailyPoint = {
  date: string;
  sent: number;
  contacted: number;
  new_leads_contacted: number;
  opened: number;
  unique_opened: number;
  replies: number;
  unique_replies: number;
  clicks: number;
  unique_clicks: number;
  opportunities: number;
  unique_opportunities: number;
};

export type CampaignStepStat = {
  step: string;
  variant: string;
  sent: number;
  opened: number;
  unique_opened: number;
  replies: number;
  unique_replies: number;
  clicks: number;
  unique_clicks: number;
};

/**
 * ⚠ The three analytics endpoints do NOT share a filter parameter name.
 *
 *   /analytics/daily    and  /analytics/steps  →  campaign_id=<id>
 *   /analytics/overview                        →  ids=<id>
 *
 * Verified by differential against the live API, Sep-2026, and the mismatch is a trap
 * rather than a curiosity: an unrecognised parameter name is IGNORED, not rejected, so
 * `overview?campaign_id=…` silently returns whole-workspace totals. Those totals then
 * render on one campaign's page as if they were its own — a campaign that has never
 * sent anything reporting the workspace's send count. Confirmed by passing a bogus
 * campaign id: `?campaign_id=00000000-…` still returned the full workspace figures,
 * whereas `?ids=00000000-…` returned zeroes.
 *
 * `ids` is genuinely parsed rather than coincidentally zeroing things out: a malformed
 * value (`?ids=garbage`) errors instead of falling back to unfiltered.
 *
 * Not yet proven: that `ids` returns the right NON-ZERO figures for a campaign that has
 * sent. No campaign in the workspace has sends yet, so only the zero case is covered.
 * Re-check this against a live sending campaign before quoting these numbers to anyone.
 *
 * `start_date`/`end_date` are inclusive ISO dates, honoured on daily.
 */
function analyticsQuery(campaignId: string, range?: { start?: string; end?: string }): string {
  const q = new URLSearchParams({ campaign_id: campaignId });
  if (range?.start) q.set('start_date', range.start);
  if (range?.end) q.set('end_date', range.end);
  return q.toString();
}

export async function getCampaignOverview(
  campaignId: string, range?: { start?: string; end?: string },
): Promise<CampaignOverview> {
  // `ids`, NOT `campaign_id` — see the note above before changing this.
  const q = new URLSearchParams({ ids: campaignId });
  if (range?.start) q.set('start_date', range.start);
  if (range?.end) q.set('end_date', range.end);
  return getJson<CampaignOverview>(`/campaigns/analytics/overview?${q.toString()}`);
}

export async function getCampaignDaily(
  campaignId: string, range?: { start?: string; end?: string },
): Promise<CampaignDailyPoint[]> {
  const json = await getJson<CampaignDailyPoint[]>(`/campaigns/analytics/daily?${analyticsQuery(campaignId, range)}`);
  return Array.isArray(json) ? json : [];
}

export async function getCampaignStepStats(campaignId: string): Promise<CampaignStepStat[]> {
  const json = await getJson<CampaignStepStat[]>(`/campaigns/analytics/steps?${analyticsQuery(campaignId)}`);
  return Array.isArray(json) ? json : [];
}

export async function pauseCampaign(id: string): Promise<void> {
  await apiFetch(`/campaigns/${encodeURIComponent(id)}/pause`, { method: 'POST' });
}

export async function activateCampaign(id: string): Promise<void> {
  await apiFetch(`/campaigns/${encodeURIComponent(id)}/activate`, { method: 'POST' });
}

// ─── Sending mailboxes ────────────────────────────────────────────────────────

export async function listEmailAccounts(): Promise<EmailAccount[]> {
  return paginate<EmailAccount>('/accounts');
}

/**
 * Mailbox actions, verified against the live API Sep-2026.
 *
 * Route existence was established by probing with an address that does not exist: a
 * missing ROUTE answers "Route POST:/api/v2/... not found", while a real route with a
 * missing resource answers "Account not found". The two are easy to confuse and the
 * difference is what tells you whether a feature exists at all.
 *
 *   warmup on/off   POST /accounts/warmup/enable | /disable   { emails: [...] }
 *   pause / resume  POST /accounts/{email}/pause | /resume
 *   clear error     POST /accounts/{email}/mark-fixed
 *   delete          DELETE /accounts/{email}
 *
 * There is NO reconnect endpoint. /accounts/{email}/reconnect, /accounts/reconnect,
 * /connect, /reauth and /accounts/enable all answer "Route ... not found". That is
 * expected for OAuth mailboxes — re-consent has to happen in the vendor's own UI
 * against Google, and no API key can perform it. mark-fixed clears the error flag on
 * an account the platform has soft-failed; it does not re-authenticate one.
 */

/**
 * One mailbox in full, including the settings the list endpoint omits.
 *
 * Field names were established by probing PATCH: the endpoint silently IGNORES keys it
 * does not know and echoes back the ones it accepted, so a wrong guess looks exactly
 * like success. Every field below was confirmed by sending it and reading it back.
 * Notably `important_rate`, not `mark_important`, backs the "Mark important" slider —
 * the obvious name is one of the ones that gets swallowed.
 */
export type AccountWarmupSettings = {
  limit?: number;
  increment?: string | number;
  reply_rate?: number;
  advanced?: {
    warm_ctd?: boolean;
    open_rate?: number;
    spam_save_rate?: number;
    important_rate?: number;
    weekday_only?: boolean;
    read_emulation?: boolean;
  };
};

export type AccountDetail = EmailAccount & {
  warmup?: AccountWarmupSettings;
  sending_gap?: number;
  enable_slow_ramp?: boolean;
  inbox_placement_test_limit?: number;
  reply_to?: string | null;
  timestamp_warmup_start?: string | null;
};

export async function getEmailAccount(email: string): Promise<AccountDetail> {
  return getJson<AccountDetail>(`/accounts/${encodeURIComponent(email)}`);
}

/** PATCH only what changed; unknown keys are dropped without complaint. */
export async function updateEmailAccount(
  email: string, patch: Record<string, unknown>,
): Promise<AccountDetail> {
  return (await apiFetch(`/accounts/${encodeURIComponent(email)}`, {
    method: 'PATCH',
    body: JSON.stringify(patch),
  })).json() as Promise<AccountDetail>;
}

export type WarmupAnalytics = {
  email_date_data?: Record<string, Record<string, { sent?: number; landed_inbox?: number; received?: number }>>;
  aggregate_data?: Record<string, { sent?: number; received?: number; landed_inbox?: number; health_score?: number }>;
};

/** Per-day warmup activity. POST with { emails }, NOT a GET — /warmup/analytics 404s. */
export async function getWarmupAnalytics(emails: string[]): Promise<WarmupAnalytics> {
  return postJson<WarmupAnalytics>('/accounts/warmup-analytics', { emails });
}

/**
 * Which campaigns send from this mailbox.
 *
 * Derived by scanning each campaign's email_list — there is no "campaigns for account"
 * endpoint, and the assignment lives on the campaign rather than on the account.
 */
export async function campaignsUsingMailbox(
  email: string,
): Promise<Array<{ id: string; name: string; status: number }>> {
  const all = await paginate<Campaign>('/campaigns');
  const target = email.toLowerCase();
  return all
    .filter((c) => (c.email_list ?? []).some((e) => String(e).toLowerCase() === target))
    .map((c) => ({ id: c.id, name: c.name, status: c.status }));
}

/** Warmup is a bulk, asynchronous job — the response is a job id, not the new state. */
export async function setWarmup(emails: string[], on: boolean): Promise<void> {
  if (!emails.length) return;
  await apiFetch(`/accounts/warmup/${on ? 'enable' : 'disable'}`, {
    method: 'POST',
    body: JSON.stringify({ emails }),
  });
}

export async function pauseEmailAccount(email: string): Promise<void> {
  await apiFetch(`/accounts/${encodeURIComponent(email)}/pause`, { method: 'POST', body: '{}' });
}

export async function resumeEmailAccount(email: string): Promise<void> {
  await apiFetch(`/accounts/${encodeURIComponent(email)}/resume`, { method: 'POST', body: '{}' });
}

/** Clears a soft error flag. NOT a re-authentication — see the note above. */
export async function markEmailAccountFixed(email: string): Promise<void> {
  await apiFetch(`/accounts/${encodeURIComponent(email)}/mark-fixed`, { method: 'POST', body: '{}' });
}

export async function deleteEmailAccount(email: string): Promise<void> {
  // Bodiless by design — apiFetch omits content-type when there is no body, which is
  // what this endpoint requires.
  await apiFetch(`/accounts/${encodeURIComponent(email)}`, { method: 'DELETE' });
}

// ─── Leads ────────────────────────────────────────────────────────────────────

/**
 * Leads already in a campaign — used for dedup and for reading back outcomes.
 *
 * The filter key is `campaign`, NOT `campaign_id`. Verified live: passing
 * `campaign_id` is silently ignored and the endpoint returns every lead in the
 * workspace — so a campaign's lead list would show other campaigns' recipients with
 * no error to hint at it. The client-side filter below is a second line of defence,
 * because the failure mode of getting this wrong is showing one client's leads under
 * another campaign rather than an obvious crash.
 */
export async function listLeadsInCampaign(campaignId: string): Promise<VendorLead[]> {
  const out: VendorLead[] = [];
  let cursor: string | undefined;
  for (let page = 0; page < MAX_PAGES; page++) {
    const json = await postJson<{ items?: VendorLead[]; next_starting_after?: string }>(
      '/leads/list',
      { campaign: campaignId, limit: PAGE_SIZE, ...(cursor ? { starting_after: cursor } : {}) },
    );
    out.push(...(json.items ?? []));
    if (!json.next_starting_after) break;
    cursor = json.next_starting_after;
  }
  return out.filter((l) => !l.campaign || l.campaign === campaignId);
}

/**
 * Is this address already somewhere in the workspace?
 * Checked before a push so a homeowner cannot land in two campaigns at once — the
 * vendor's own per-campaign duplicate flag does not cover that.
 */
export async function findLeadsByEmail(email: string): Promise<VendorLead[]> {
  const json = await postJson<{ items?: VendorLead[] }>('/leads/list', {
    search: email.trim().toLowerCase(),
    limit: 10,
  });
  const wanted = email.trim().toLowerCase();
  // The vendor's `search` is not guaranteed to be an exact match, so narrow locally.
  return (json.items ?? []).filter((l) => String(l.email ?? '').toLowerCase() === wanted);
}

export type AddLeadResult = {
  email: string;
  ok: boolean;
  /** Vendor's own lead id — what the webhook later matches on. */
  leadId?: string;
  error?: string;
};

/**
 * Add leads to a campaign, one vendor call each.
 *
 * The vendor has no bulk endpoint (verified: /leads/bulk 404s), so this loops. A
 * failure on one lead is reported and the rest continue — a batch that aborts
 * halfway leaves the caller unable to tell which leads actually landed, which is
 * precisely the state we cannot be in when the next step writes send-log rows.
 */
export async function addLeadsToCampaign(
  campaignId: string,
  leads: LeadInput[],
  opts?: { gapMs?: number },
): Promise<AddLeadResult[]> {
  const gap = opts?.gapMs ?? 150;
  const results: AddLeadResult[] = [];

  for (const lead of leads) {
    const email = String(lead.email ?? '').trim().toLowerCase();
    if (!email) {
      results.push({ email: '', ok: false, error: 'No email address' });
      continue;
    }
    try {
      const created = await postJson<VendorLead>('/leads', {
        campaign: campaignId,
        email,
        ...(lead.first_name ? { first_name: lead.first_name } : {}),
        ...(lead.last_name ? { last_name: lead.last_name } : {}),
        ...(lead.company_name ? { company_name: lead.company_name } : {}),
        ...(lead.custom_variables ? { custom_variables: lead.custom_variables } : {}),
      });
      results.push({ email, ok: true, leadId: created?.id });
    } catch (err) {
      results.push({ email, ok: false, error: (err as Error)?.message ?? 'Create failed' });
    }
    if (gap) await new Promise((r) => setTimeout(r, gap));
  }
  return results;
}

// ─── Replies / message feed ───────────────────────────────────────────────────

export type VendorEmail = {
  id: string;
  /** Distinct from `id` — the two are NOT interchangeable when replying to a thread. */
  message_id?: string;
  thread_id?: string;
  campaign_id?: string;
  subject?: string;
  body?: { text?: string; html?: string } | string;
  from_address_email?: string;
  /** The sending mailbox, same value as from_address_email on every row observed. */
  eaccount?: string;
  to_address_email_list?: string;
  timestamp_email?: string;
  is_unread?: boolean;
  /**
   * Message type. Observed live 21 Sep 2026: 1 = campaign send, 2 = the prospect's reply,
   * 3 = a reply we sent by hand through /emails/reply. So "not 1" does NOT mean inbound —
   * compare the from address against `eaccount` instead.
   */
  ue_type?: number;
  lead_id?: string;
  /** Vendor's own sequence coordinate, e.g. "0_0_0". NOT a plain step number. */
  step?: string;
};

/** Recent messages — the raw feed behind replies. */
export async function listEmails(opts?: { campaignId?: string; limit?: number }): Promise<VendorEmail[]> {
  // The platform rejects limit > 100 outright — "querystring/limit must be <= 100", a 400,
  // not a silent truncation. Clamped rather than passed through so a caller asking for
  // more gets the most the API allows instead of an error page.
  const params = new URLSearchParams({ limit: String(Math.min(opts?.limit ?? PAGE_SIZE, PAGE_SIZE)) });
  if (opts?.campaignId) params.set('campaign_id', opts.campaignId);
  const json = await getJson<{ items?: VendorEmail[] }>(`/emails?${params.toString()}`);
  return json.items ?? [];
}

/**
 * One page of the message feed, with the cursor to continue from.
 *
 * `campaign_id` IS honoured here — verified by passing an id that exists nowhere and
 * getting `items: []` back rather than the whole workspace. Worth stating because this
 * vendor silently ignores parameters it does not recognise and answers 200, which has
 * already produced one wrong number in this integration (campaign analytics reported
 * workspace totals for a single campaign).
 */
export async function listEmailsPage(opts: {
  campaignId?: string;
  limit?: number;
  startingAfter?: string;
}): Promise<{ items: VendorEmail[]; nextCursor: string | null }> {
  // Same 100 ceiling as listEmails above.
  const params = new URLSearchParams({ limit: String(Math.min(opts.limit ?? PAGE_SIZE, PAGE_SIZE)) });
  if (opts.campaignId) params.set('campaign_id', opts.campaignId);
  if (opts.startingAfter) params.set('starting_after', opts.startingAfter);
  const json = await getJson<{ items?: VendorEmail[]; next_starting_after?: string }>(
    `/emails?${params.toString()}`,
  );
  return { items: json.items ?? [], nextCursor: json.next_starting_after ?? null };
}

/**
 * ── Which /emails query parameters are real ───────────────────────────────────
 *
 * This vendor answers 200 and ignores a parameter it does not recognise, so a filter
 * that does nothing is indistinguishable from one that works unless you check the rows
 * that come back. Probed 5 Oct 2026 against a workspace of 1,007 messages:
 *
 *   HONOURED   email_type=received | sent    the only message-direction filter
 *              lead=<address>                every message to or from one address
 *              search=<address>              same result for an address
 *              campaign_id=<id>
 *              starting_after=<id>, limit (<= 100)
 *
 *   IGNORED    ue_type=, i_status=, thread_id=, lead_email=, contact=, assigned_to=
 *              — all return the UNFILTERED feed with a 200.
 *
 *   REJECTED   email_type=<anything else>    400, it is a validated enum
 *
 * `email_type` takes the words, not the numbers: `received` returns ue_type 2 only and
 * `sent` returns ue_type 1. Numeric values 0-3 are all 400s.
 */

/**
 * Every inbound reply, newest first.
 *
 * This is what the reply inbox is actually looking for, and asking for it directly is
 * the difference between 2 requests and 10. The inbox used to page the whole message
 * feed and discard it: of 1,007 messages, 998 were automated sends and 6 were replies.
 *
 * It also removes a ceiling that was going to start losing replies. The feed is newest
 * first and the page cap is 10, so only the most recent ~1,000 messages were ever
 * examined; at 250-1,200 sends a week, a reply from a fortnight ago would have fallen
 * off the end and vanished from the inbox while still owed an answer. There is no such
 * cliff here, because the cap now applies to replies rather than to all traffic.
 */
export async function listInboundEmails(opts: {
  campaignId?: string;
  maxPages?: number;
} = {}): Promise<VendorEmail[]> {
  const out: VendorEmail[] = [];
  let cursor: string | undefined;
  const pages = Math.min(opts.maxPages ?? MAX_PAGES, MAX_PAGES);

  for (let page = 0; page < pages; page++) {
    const params = new URLSearchParams({ limit: String(PAGE_SIZE), email_type: 'received' });
    if (opts.campaignId) params.set('campaign_id', opts.campaignId);
    if (cursor) params.set('starting_after', cursor);
    const json = await getJson<{ items?: VendorEmail[]; next_starting_after?: string }>(
      `/emails?${params.toString()}`,
    );
    const items = json.items ?? [];
    out.push(...items);
    if (lastPage(items, PAGE_SIZE, json.next_starting_after)) break;
    cursor = json.next_starting_after;
  }
  return out;
}

/**
 * Every message to or from one address — both directions, so a whole conversation.
 *
 * `lead=` is the filter that makes this possible; `thread_id=` looks like the obvious
 * choice and is silently ignored, which would have returned the entire feed dressed up
 * as one thread.
 */
export async function listEmailsForContact(
  email: string,
  opts: { maxPages?: number } = {},
): Promise<VendorEmail[]> {
  const out: VendorEmail[] = [];
  let cursor: string | undefined;
  const pages = Math.min(opts.maxPages ?? 3, MAX_PAGES);

  for (let page = 0; page < pages; page++) {
    const params = new URLSearchParams({ limit: String(PAGE_SIZE), lead: email });
    if (cursor) params.set('starting_after', cursor);
    const json = await getJson<{ items?: VendorEmail[]; next_starting_after?: string }>(
      `/emails?${params.toString()}`,
    );
    const items = json.items ?? [];
    out.push(...items);
    if (lastPage(items, PAGE_SIZE, json.next_starting_after)) break;
    cursor = json.next_starting_after;
  }
  return out;
}

// ─── Campaign lifecycle (verified: all of these routes exist) ─────────────────

export type CreateCampaignInput = {
  name: string;
  timezone: string;
  /** 24h "HH:MM" in the campaign's own timezone. */
  from?: string;
  to?: string;
  days?: Record<string, boolean>;
  /** Mailboxes that send it. Empty means the platform's default selection. */
  emailList?: string[];
  dailyLimit?: number;
  /** First sequence step. A campaign with no step cannot send anything. */
  subject?: string;
  body?: string;
};

/**
 * Create a campaign in a draft (inactive) state.
 *
 * `campaign_schedule.schedules[]` is required with at least one entry, and its
 * `timezone` must come from the platform's curated list — see campaignTimezones.ts,
 * where the surprising rejections are documented. A campaign is created paused; the
 * sequence goes on separately and activation is an explicit, separate action.
 */
export async function createCampaign(input: CreateCampaignInput): Promise<Campaign> {
  const body: Record<string, unknown> = {
    name: input.name,
    campaign_schedule: {
      schedules: [{
        name: 'Default Schedule',
        timing: { from: input.from ?? '09:00', to: input.to ?? '17:00' },
        days: input.days ?? { '0': false, '1': true, '2': true, '3': true, '4': true, '5': true, '6': false },
        timezone: input.timezone,
      }],
    },
  };
  if (input.emailList?.length) body.email_list = input.emailList;
  if (input.dailyLimit != null) body.daily_limit = input.dailyLimit;
  // Frank Sep-2026 (T1.6): one-click unsubscribe on every send, without exception.
  // Set at create time so a campaign cannot exist without it.
  body.insert_unsubscribe_header = true;
  // Stop the sequence the moment somebody replies — the whole point of tracking them.
  body.stop_on_reply = true;

  if (input.subject || input.body) {
    body.sequences = [{
      steps: [{
        type: 'email',
        delay: 0,
        variants: [{ subject: input.subject ?? '', body: input.body ?? '' }],
      }],
    }];
  }
  return postJson<Campaign>('/campaigns', body);
}

/**
 * Generic PATCH — backs rename, schedule, options, mailbox assignment and sequence
 * edits, which are all the same call underneath. Callers pass only what changes.
 */
export async function patchCampaign(id: string, patch: Record<string, unknown>): Promise<Campaign> {
  const res = await apiFetch(`/campaigns/${encodeURIComponent(id)}`, {
    method: 'PATCH',
    body: JSON.stringify(patch),
  });
  return res.json() as Promise<Campaign>;
}

export async function duplicateCampaign(id: string): Promise<Campaign> {
  const res = await apiFetch(`/campaigns/${encodeURIComponent(id)}/duplicate`, { method: 'POST' });
  return res.json() as Promise<Campaign>;
}

export async function deleteCampaign(id: string): Promise<void> {
  await apiFetch(`/campaigns/${encodeURIComponent(id)}`, { method: 'DELETE' });
}

/** Delete one lead from the platform entirely. */
export async function deleteLead(leadId: string): Promise<void> {
  await apiFetch(`/leads/${encodeURIComponent(leadId)}`, { method: 'DELETE' });
}

/**
 * Update a contact's merge variables in place.
 *
 * ── Why this is needed ──────────────────────────────────────────────────────
 * custom_variables are otherwise written ONLY at create, so every value a contact holds is
 * a snapshot from upload time. band_low and band_high are empty on all 186 C1–C3 contacts
 * right now, waiting on Frank. Without this, supplying them later would mean deleting and
 * re-adding every contact — which restarts their sequence from step 1.
 *
 * ── Measured, not assumed (probe, 28 Sep 2026) ──────────────────────────────
 * The vendor's PATCH is documented nowhere and our own notes record that it silently drops
 * keys it does not recognise, so each of these was checked by writing and READING BACK:
 *
 *   • an existing variable is updated                          — yes
 *   • a variable absent at create can be introduced            — yes
 *   • a PARTIAL patch MERGES; untouched keys survive           — yes
 *   • a top-level key the API does not know still returns 200  — yes
 *
 * That last one is why this reads the contact back and compares rather than trusting the
 * status. A 200 from this endpoint means the request was accepted, not that anything
 * changed, and a re-sync built on the status alone would report success forever while every
 * email went out with a blank where the price should be.
 *
 * The merge behaviour is what makes a targeted fix safe: sending only { band_low, band_high }
 * cannot wipe the renewal date or the resolved copy sitting beside it.
 */
export async function updateLeadVariables(
  leadId: string,
  vars: Record<string, string | number | null>,
): Promise<{ ok: boolean; mismatched: string[] }> {
  await apiFetch(`/leads/${encodeURIComponent(leadId)}`, {
    method: 'PATCH',
    body: JSON.stringify({ custom_variables: vars }),
  });

  // Read back. The write's own response is not evidence — see above.
  const res = await apiFetch(`/leads/${encodeURIComponent(leadId)}`);
  const after = (await res.json() as { custom_variables?: Record<string, unknown>; payload?: Record<string, unknown> });
  const stored = after.custom_variables ?? after.payload ?? {};

  const mismatched = Object.entries(vars)
    .filter(([k, v]) => String(stored[k] ?? '') !== String(v ?? ''))
    .map(([k]) => k);

  return { ok: mismatched.length === 0, mismatched };
}

/**
 * How many leads each campaign actually holds.
 *
 * Needed because /campaigns/analytics only contains campaigns that have SEND
 * activity — a draft campaign is absent from the response entirely, not merely
 * reported as zero. Defaulting a missing row to zero made a campaign holding 300
 * leads read "0 leads", which looks exactly like a failed import.
 *
 * Counted with ONE pass over the workspace's leads, grouped by campaign locally,
 * rather than a request per campaign: the overview always renders every campaign,
 * so per-campaign counting would be N+1 by construction.
 *
 * `truncated` is true when the page ceiling was hit, so the caller can say "1000+"
 * instead of quietly reporting a number it knows is short.
 */
export async function getLeadCountsByCampaign(
  opts?: { maxPages?: number },
): Promise<{ counts: Map<string, number>; truncated: boolean }> {
  const maxPages = opts?.maxPages ?? 50; // 50 × 100 = 5,000 leads
  const counts = new Map<string, number>();
  let cursor: string | undefined;
  let truncated = true;

  for (let page = 0; page < maxPages; page++) {
    const json = await postJson<{ items?: VendorLead[]; next_starting_after?: string }>(
      '/leads/list',
      { limit: PAGE_SIZE, ...(cursor ? { starting_after: cursor } : {}) },
    );
    for (const lead of json.items ?? []) {
      const id = lead.campaign;
      if (!id) continue;
      counts.set(id, (counts.get(id) ?? 0) + 1);
    }
    if (!json.next_starting_after) { truncated = false; break; }
    cursor = json.next_starting_after;
  }
  return { counts, truncated };
}

// ─── Replies (Unibox) ─────────────────────────────────────────────────────────

/**
 * Send a reply into an existing thread.
 *
 * Verified live 21 Sep 2026. The required shape is not in any doc we have — it was
 * established by probing, one 400 at a time:
 *
 *   POST /emails/reply
 *     reply_to_uuid  the INBOUND message's `id` (not its message_id — see VendorEmail)
 *     eaccount       the mailbox that owns the thread
 *     subject        string
 *     body           an OBJECT { html?, text? } — a string here fails validation
 *
 * `reply_to_uuid` is what threads it. Composing a fresh message to the same person
 * instead would arrive as a disconnected email from a stranger, which is worse than not
 * replying at all: the prospect answered a named producer and gets a reply that looks
 * like a new cold approach.
 */
export async function replyToEmail(input: {
  replyToUuid: string;
  eaccount: string;
  subject: string;
  text?: string;
  html?: string;
}): Promise<VendorEmail> {
  if (!input.text && !input.html) throw new Error('A reply needs a body.');
  return postJson<VendorEmail>('/emails/reply', {
    reply_to_uuid: input.replyToUuid,
    eaccount: input.eaccount,
    subject: input.subject,
    body: {
      ...(input.html ? { html: input.html } : {}),
      ...(input.text ? { text: input.text } : {}),
    },
  });
}

/** One message, by the vendor's own id. Used to read a full body the webhook truncated. */
export async function getEmail(id: string): Promise<VendorEmail> {
  return getJson<VendorEmail>(`/emails/${encodeURIComponent(id)}`);
}
