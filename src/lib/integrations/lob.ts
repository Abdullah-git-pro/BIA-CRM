/**
 * Lob — print and mail. The vendor that turns a template and an address into a letter.
 *
 * ── The one thing this file exists to make impossible ───────────────────────
 * Sending real mail by accident.
 *
 * Every other integration in this codebase can be wrong and then corrected: a tax-roll
 * verdict is re-run, a contact verdict is re-graded for $0.035, an email sequence is stopped
 * mid-flight. A letter is printed, posted and in somebody's hand. There is no recall, no
 * edit, no suppression after the fact — and it carries a named person's address and an
 * estimated premium, so the failure is not a wasted $0.81 but a disclosure.
 *
 * So the mode is never inferred and never defaulted to live:
 *
 *   1. Every call takes an explicit `mode`. There is no default parameter.
 *   2. 'live' additionally requires LOB_LIVE_ENABLED=true in the environment. Holding the
 *      live key is not consent to use it — the key was set on 15 Oct, days before any letter
 *      should exist, and a key sitting in .env must not be one flag away from printing.
 *   3. The mode used comes back on every result, so the caller records what actually
 *      happened rather than what it believed it asked for.
 *
 * ── Test mode ───────────────────────────────────────────────────────────────
 * Test and live are completely separate environments: a letter created with a test key is
 * rendered and returns a real PDF to read, and nothing is printed or posted. That is how the
 * whole of this build gets verified before anything is spent.
 */

const API_ROOT = 'https://api.lob.com/v1';

export type LobMode = 'test' | 'live';

export interface LobAddress {
  name: string;
  street: string;
  street2?: string | null;
  city: string;
  state: string;
  zip: string;
}

export interface LetterInput {
  to: LobAddress;
  from: LobAddress;
  /** The template HTML, with {{ variables }} left in for Lob to merge. */
  html: string;
  mergeVariables: Record<string, string>;
  color?: boolean;
  doubleSided?: boolean;
  size?: 'us_letter' | 'us_legal';
  /**
   * Our own key. The same value is written to DirectMailSend under a unique index, so a
   * double send is refused on both sides: by Lob, and by our own database.
   */
  idempotencyKey: string;
  description?: string;
}

/** One rendered page, as the vendor's own preview images. */
export interface LetterThumbnail {
  small: string;
  medium: string;
  large: string;
}

export interface LetterResult {
  id: string;
  /** The rendered letter, as a PDF. Readable in test mode — this is the proof. */
  url: string | null;
  /**
   * Page images, one entry per printed page.
   *
   * Preferred over the PDF for showing a proof on screen: the PDF needs a viewer and
   * arrives a minute or two late, while these are PNGs an <img> can display. Both are
   * signed URLs that expire, so neither can be stored and reused — a proof is re-fetched
   * from the vendor each time it is looked at.
   */
  thumbnails: LetterThumbnail[];
  expectedDeliveryDate: string | null;
  mode: LobMode;
  carrier: string | null;
}

/**
 * The key for a mode, and the second lock on the live one.
 *
 * Throwing rather than falling back is deliberate. A missing live key must stop the run; a
 * fallback to test would silently "succeed" at sending nothing, and somebody would believe
 * fifty letters were in the post.
 */
function apiKey(mode: LobMode): string {
  if (mode === 'live') {
    if (String(process.env.LOB_LIVE_ENABLED ?? '').toLowerCase() !== 'true') {
      throw new Error(
        'LOB_LIVE_BLOCKED: live mail is switched off. Set LOB_LIVE_ENABLED=true deliberately, '
        + 'and only after the letter has been through its compliance review.',
      );
    }
    const k = process.env.LOB_LIVE_API_KEY;
    if (!k) throw new Error('Lob live key not configured (LOB_LIVE_API_KEY).');
    if (!k.startsWith('live_')) throw new Error('LOB_LIVE_API_KEY does not look like a live key.');
    return k;
  }
  const k = process.env.LOB_TEST_API_KEY;
  if (!k) throw new Error('Lob test key not configured (LOB_TEST_API_KEY).');
  /**
   * A live key in the test slot would print real mail while every screen said "test".
   * That is the exact mistake the mode split exists to prevent, so it is checked rather
   * than trusted.
   */
  if (!k.startsWith('test_')) throw new Error('LOB_TEST_API_KEY is not a test key — refusing to use it.');
  return k;
}

/** Is live mail switched on at all? The UI asks this to decide what banner to show. */
export function liveEnabled(): boolean {
  return String(process.env.LOB_LIVE_ENABLED ?? '').toLowerCase() === 'true'
    && !!process.env.LOB_LIVE_API_KEY;
}

function authHeader(mode: LobMode): string {
  // Lob uses HTTP Basic with the key as the username and a blank password.
  return `Basic ${Buffer.from(`${apiKey(mode)}:`).toString('base64')}`;
}

function address(a: LobAddress) {
  return {
    name: a.name,
    address_line1: a.street,
    address_line2: a.street2 || undefined,
    address_city: a.city,
    address_state: a.state,
    address_zip: a.zip,
    address_country: 'US',
  };
}

/**
 * Create one letter.
 *
 * `use_type: 'marketing'` because that is what this is — a renewal approach to somebody who
 * is not yet a customer. Declaring it operational would be a misstatement to the vendor and
 * to USPS about the nature of the mail.
 */
export async function createLetter(input: LetterInput, mode: LobMode): Promise<LetterResult> {
  if (!input.idempotencyKey) throw new Error('A letter needs an idempotency key.');

  const body = {
    to: address(input.to),
    from: address(input.from),
    file: input.html,
    merge_variables: input.mergeVariables,
    color: input.color ?? false,
    double_sided: input.doubleSided ?? true,
    /**
     * `size` is deliberately NOT sent.
     *
     * The field exists in the reference but the account's default API version rejects it —
     * "size is not allowed", 422 — because it is only accepted from Lob-Version 2024-01-01
     * onward, where it is also supplied automatically. Sending it pins us to a version we
     * have not otherwise adopted in exchange for a value Lob already defaults to us_letter.
     * The template still records the size for when we do move versions.
     */
    mail_type: 'usps_first_class',
    use_type: 'marketing',
    description: input.description ?? undefined,
  };

  const res = await fetch(`${API_ROOT}/letters`, {
    method: 'POST',
    headers: {
      Authorization: authHeader(mode),
      'Content-Type': 'application/json',
      'Idempotency-Key': input.idempotencyKey,
    },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(30_000),
  });

  const text = await res.text();
  if (!res.ok) {
    /**
     * The vendor's own words, not a summary of them.
     *
     * A refused letter is usually refused for a reason a person can act on — an
     * undeliverable address, an unsupplied merge variable — and flattening that to "could
     * not send" would send somebody to the logs to find out what we were already told.
     */
    let detail = text.slice(0, 400);
    try {
      const j = JSON.parse(text);
      detail = j?.error?.message ?? detail;
    } catch { /* keep the raw body */ }
    throw new Error(`LOB_${res.status}: ${detail}`);
  }

  const j = JSON.parse(text) as Record<string, any>;
  return {
    id: String(j.id),
    url: j.url ?? null,
    thumbnails: Array.isArray(j.thumbnails) ? j.thumbnails : [],
    expectedDeliveryDate: j.expected_delivery_date ?? null,
    mode,
    carrier: j.carrier ?? null,
    /**
     * There is deliberately no "was this a duplicate?" flag.
     *
     * Lob does replay the original letter for a repeated key — verified: a second call with
     * the same key returned the same ltr_ id and created nothing — but it does NOT set an
     * Idempotency-Replayed header, so a flag read from the response said `false` on a call
     * that had plainly deduplicated. A field that is wrong in exactly the case it exists to
     * report is worse than no field.
     *
     * The authority is our own unique index on DirectMailSend.idempotencyKey: if the row is
     * already there, the letter was already sent. The caller checks that, and knows.
     */
  };
}

/** Read a letter back — used by the proof screen and when reconciling a webhook. */
export async function getLetter(id: string, mode: LobMode): Promise<Record<string, any>> {
  const res = await fetch(`${API_ROOT}/letters/${encodeURIComponent(id)}`, {
    headers: { Authorization: authHeader(mode) },
    signal: AbortSignal.timeout(20_000),
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`LOB_${res.status}: ${text.slice(0, 300)}`);
  return JSON.parse(text);
}

/**
 * Cancel a letter the vendor has not yet printed.
 *
 * Lob allows this only inside a short window after creation. It is not an undo for mail —
 * once printed there is none — but the window is real and a mistake caught in the first
 * minutes should not be left in the queue out of fatalism.
 */
export async function cancelLetter(id: string, mode: LobMode): Promise<boolean> {
  const res = await fetch(`${API_ROOT}/letters/${encodeURIComponent(id)}`, {
    method: 'DELETE',
    headers: { Authorization: authHeader(mode) },
    signal: AbortSignal.timeout(20_000),
  });
  return res.ok;
}

/**
 * Is this address real and postable?
 *
 * Asked before a batch rather than after it. A letter to a bad address is charged in full
 * and arrives nowhere, and 47 of our Grade A households mail somewhere other than the
 * property — the addresses least likely to have been looked at by anybody.
 */
export async function verifyAddress(
  a: Pick<LobAddress, 'street' | 'city' | 'state' | 'zip'>,
): Promise<{ deliverable: boolean | null; deliverability: string; corrected: LobAddress | null }> {
  /**
   * ── The one carve-out to the live-key guard ───────────────────────────────
   *
   * This function uses the live key when there is one, without LOB_LIVE_ENABLED, because it
   * is the only call in this file that CANNOT PRODUCE MAIL. It is a read: an address goes
   * in, USPS's opinion comes back, nothing is printed, nothing is posted and nothing can be
   * recalled because nothing exists.
   *
   * The guard exists to stop paper leaving the building. Applying it here would have meant
   * never being able to check an address until we were already committed to posting to it —
   * which is backwards, since knowing the address is right is a precondition of posting. 73
   * of the Grade A letters carry a house number with a unit squashed into it, and the only
   * authority on which form USPS accepts is USPS.
   *
   * createLetter is untouched and still refuses live without the flag. Approved by Abdullah,
   * 15 Oct 2026, as a verification-only exception.
   *
   * It is charged — $0.05 a lookup on the current plan — so callers count before they ask,
   * the same as every other metered call here.
   */
  const live = process.env.LOB_LIVE_API_KEY;
  const mode: LobMode = live && live.startsWith('live_') ? 'live' : 'test';
  /**
   * ── Without a live key this cannot answer, and must not pretend to ────────
   *
   * Lob's us_verifications endpoint is a stub under a test key: it returns "undeliverable"
   * for every input. Verified against controls — 210 King St San Francisco (Lob's own
   * address) and 1600 Pennsylvania Ave NW both come back undeliverable, identically to
   * "99999 Nowhere Blvd". Run over C2 it marked all 50 households undeliverable, which is a
   * statement about the test environment and not about anybody's house.
   *
   * So test mode returns `null` — unknown — rather than `false`. The distinction is the one
   * that runs through this whole pipeline: unchecked is not failed. A send gate reading
   * `false` here would block every letter we ever try to post; a gate reading a stub as
   * truth would be worse, because it would look like it was working.
   *
   * Real deliverability can only be measured with the live key, and it is worth measuring
   * before the first batch: C2 holds at least one mailing address that lacks the unit number
   * its property address carries.
   */
  if (mode === 'test') {
    return { deliverable: null, deliverability: 'no_live_key', corrected: null };
  }

  const auth = `Basic ${Buffer.from(`${live}:`).toString('base64')}`;
  const res = await fetch(`${API_ROOT}/us_verifications`, {
    method: 'POST',
    headers: { Authorization: auth, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      primary_line: a.street,
      city: a.city,
      state: a.state,
      zip_code: a.zip,
    }),
    signal: AbortSignal.timeout(20_000),
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`LOB_${res.status}: ${text.slice(0, 300)}`);
  const j = JSON.parse(text) as Record<string, any>;
  const d = String(j.deliverability ?? '');
  return {
    deliverable: d === 'deliverable',
    deliverability: d,
    corrected: j.primary_line ? {
      name: '',
      street: j.primary_line,
      street2: j.secondary_line || null,
      city: j.components?.city ?? a.city,
      state: j.components?.state ?? a.state,
      zip: j.components?.zip_code ?? a.zip,
    } : null,
  };
}
