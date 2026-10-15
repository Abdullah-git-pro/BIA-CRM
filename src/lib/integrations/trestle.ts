/**
 * Trestle Real Contact — identity and liveness for a contact point we already hold.
 *
 * ── What this is, and what it is not ────────────────────────────────────────
 * It does NOT return phone numbers. Trestle has no name-and-address-in, contacts-out
 * endpoint; every one of its APIs either grades a value you supply or goes the other way
 * (number in, person out). Finding numbers remains the skip-trace vendors' job. This
 * answers two narrower questions about numbers we already have:
 *
 *   nameMatch      is this value associated with the person we named?
 *   activityScore  has the line shown activity recently?
 *
 * ── Measured before it was built (221 calls, 13 Oct 2026) ───────────────────
 * Scored against outcomes we already knew — 14 reached the insured, 49 were answered by
 * somebody else, 158 rang dead:
 *
 *   nameMatch false   73 numbers, NONE of which had ever reached the insured.
 *                     Safe to drop on; removes a third of the list for nothing.
 *   nameMatch true    148 numbers, but only 14 reached the insured and 28 reached a
 *                     stranger. It means "historically linked to this name", not "they
 *                     will answer". It narrows; it does not confirm.
 *   activity >= 70    blocks 87% of dead numbers, keeps 93% of connecting calls.
 *   isValid           true on all 158 dead numbers. Useless as a filter; read and stored
 *                     for the record, never used to decide anything.
 *
 * Both gates together took the right-party rate from 6.3% to 25% on that sample.
 *
 * ── Compliance ──────────────────────────────────────────────────────────────
 * Trestle state their data is not a consumer report and must not be used for insurance
 * decisions. Deciding which of a lead's own numbers to dial first is contact routing and
 * sits the right side of that line; deciding whether somebody is offered a renewal would
 * not. Nothing here may be wired into eligibility, grading or pricing.
 */

const API_ROOT = 'https://api.trestleiq.com/2.0';

export interface ContactGrade {
  nameMatch: boolean | null;
  isValid: boolean | null;
  activityScore: number | null;
  contactGrade: string | null;
  lineType: string | null;
  emailNameMatch: boolean | null;
  emailIsValid: boolean | null;
  /** 0–100, the address's longevity and activity level. Null unless the add-on was asked for. */
  emailAgeScore: number | null;
  emailContactGrade: string | null;
}

/**
 * The paid add-on that scores an address's age and activity.
 *
 * ── Why it is worth the 17% ─────────────────────────────────────────────────
 * The base call is $0.03 and this is $0.005 on top. Its phone-side counterpart is the most
 * useful field the provider returns: activity >= 70 blocked 87% of dead numbers while
 * keeping 93% of connecting calls, where is_valid — the field that sounds like it should do
 * that job — was true on all 158 dead numbers. There is no equivalent signal on the email
 * side without this, which left name_match carrying the whole decision alone.
 *
 * ── Only on requests that carry an address ──────────────────────────────────
 * Most of our calls are phone-only, and the charge lands per request whether or not there
 * is an email on it. Attached to every call it would cost $37 across the remaining book to
 * learn nothing on 4,905 of them; attached only where it can answer, $13.
 *
 * ── Nothing is gated on it yet ──────────────────────────────────────────────
 * The phone threshold was set by scoring 221 lookups against call outcomes we already knew.
 * No such measurement exists for email, and picking a number now would be guessing with
 * somebody's campaign. It is stored and shown; it decides nothing until it has been scored
 * against opens and bounces the same way.
 */
const EMAIL_AGE_ADDON = 'email_checks_age';

export interface RealContactInput {
  /** The person we are asking about. Without a name, nameMatch is meaningless. */
  name: string;
  phone: string;
  email?: string | null;
  street?: string | null;
  city?: string | null;
  state?: string | null;
  zip?: string | null;
}

function apiKey(): string {
  const key = process.env.TRESTLE_API_KEY;
  if (!key) throw new Error('Trestle API key not configured (TRESTLE_API_KEY).');
  return key;
}

/** Digits only — the provider is strict and our sources are not consistent. */
export function normalisePhone(v: unknown): string | null {
  let d = String(v ?? '').replace(/\D/g, '');
  if (d.length === 11 && d.startsWith('1')) d = d.slice(1);
  return d.length === 10 ? d : null;
}

/**
 * Grade one phone, optionally carrying an email along for free.
 *
 * Phone is a required parameter, so the call count is driven by numbers; an email on the
 * same request is graded at no extra charge, which is why callers should attach one.
 */
export async function realContact(input: RealContactInput): Promise<ContactGrade> {
  const phone = normalisePhone(input.phone);
  if (!phone) throw new Error(`Not a usable phone number: ${input.phone}`);
  if (!input.name?.trim()) throw new Error('Trestle needs a name to match against.');

  const qs = new URLSearchParams({ name: input.name.trim(), phone });
  if (input.email) {
    qs.set('email', input.email);
    qs.set('add_ons', EMAIL_AGE_ADDON);
  }
  if (input.street) qs.set('address.street_line_1', input.street);
  if (input.city) qs.set('address.city', input.city);
  if (input.state) qs.set('address.state_code', input.state);
  if (input.zip) qs.set('address.postal_code', input.zip);
  qs.set('address.country_code', 'US');

  const res = await fetch(`${API_ROOT}/real_contact?${qs}`, {
    headers: { 'x-api-key': apiKey(), Accept: 'application/json' },
    signal: AbortSignal.timeout(20_000),
  });
  const text = await res.text();
  if (!res.ok) {
    /**
     * Quota is its own failure and must be legible to the caller.
     *
     * The trial allowance ran out 20 lookups into a 221-number batch and every remaining
     * row came back 429. A batch that cannot tell "this number is bad" from "we stopped
     * being allowed to ask" would have written 201 false verdicts.
     */
    const quota = res.status === 429 || /quota/i.test(text);
    throw new Error(`${quota ? 'TRESTLE_QUOTA' : `Trestle ${res.status}`}: ${text.slice(0, 200)}`);
  }
  const j = JSON.parse(text) as Record<string, any>;
  const ph = j?.phone ?? {};
  const em = j?.email ?? {};
  // The add-on answers in its own branch, not in `email` — asking j.email.email_age_score
  // returns undefined and would record "no score" on every address we had paid to score.
  const ageRaw = j?.add_ons?.email_checks?.email_age_score;
  return {
    nameMatch: typeof ph.name_match === 'boolean' ? ph.name_match : null,
    isValid: typeof ph.is_valid === 'boolean' ? ph.is_valid : null,
    activityScore: typeof ph.activity_score === 'number' ? ph.activity_score : null,
    contactGrade: ph.contact_grade ?? null,
    lineType: ph.line_type ?? null,
    emailNameMatch: typeof em.name_match === 'boolean' ? em.name_match : null,
    emailIsValid: typeof em.is_valid === 'boolean' ? em.is_valid : null,
    emailAgeScore: typeof ageRaw === 'number' ? ageRaw : null,
    emailContactGrade: em.contact_grade ?? null,
  };
}

/** The two gates, in the form the SOP states them. Thresholds live here, once. */
export const GATE_ACTIVITY_MIN = 70;

/**
 * Does this contact point pass both gates?
 *
 * Deliberately requires a positive nameMatch: a null — meaning we never managed to ask —
 * must not read as a pass. Unchecked and failed are different states and the caller is
 * expected to keep them apart.
 */
export function passesGates(g: Pick<ContactGrade, 'nameMatch' | 'activityScore'>): boolean {
  return g.nameMatch === true && (g.activityScore ?? -1) >= GATE_ACTIVITY_MIN;
}

/**
 * The safe half, on its own.
 *
 * nameMatch false never once appeared on a number that reached the insured, so this is the
 * rule that can be acted on before the gates have been watched for a while.
 */
export function definitelyNotTheirs(g: Pick<ContactGrade, 'nameMatch'>): boolean {
  return g.nameMatch === false;
}
