import { API_CONFIG } from '@/lib/constants';
import type { Lead } from '@/types/lead';

/**
 * REAPI Skip Trace (RealEstateAPI.com add-on) — v2/SkipTrace.
 * Consumes REAPI credits — callers must gate with canRunSkipTrace() first.
 */
const SKIPTRACE_URL = 'https://api.realestateapi.com/v2/SkipTrace';

export interface SkipTraceResult {
  phones: string[];
  emails: string[];
  matched: boolean;
  raw?: unknown;
}

const norm = (s: any) => String(s ?? '').toLowerCase().trim();

/**
 * The skip-trace person with a given name. Exact first+last, else same-surname with a
 * first-name prefix agreement (≥3 chars) so "Alla"↔"Allan" matches but a same-surname
 * relative like "Al"↔"Albert" does not. Never guesses.
 *
 * Exported because the co-insured needs exactly the same treatment as the insured: their
 * addresses were being read from the single owner2Email column, so a co-insured with
 * three addresses in the trace payload counted as one. The matching rule must not be
 * re-implemented per person — that is how the two sides drift apart.
 */
export function matchPersonByName(persons: any[], first: any, last: any): any | null {
  const list = Array.isArray(persons) ? persons : [];
  const f = norm(first);
  const l = norm(last);
  if (!f || !l) return null;
  const firstNamesAgree = (a: string, b: string) => {
    if (!a || !b) return false;
    const [short, long] = a.length <= b.length ? [a, b] : [b, a];
    return short.length >= 3 && long.startsWith(short);
  };
  return list.find((p) => norm(p.firstName) === f && norm(p.lastName) === l)
    || list.find((p) => norm(p.lastName) === l && firstNamesAgree(norm(p.firstName), f))
    || null;
}

/** The skip-trace person whose name matches the INSURED (owner1). */
export function matchInsuredPerson(persons: any[], lead: any): any | null {
  return matchPersonByName(persons, lead?.owner1FirstName, lead?.owner1LastName);
}

/**
 * The skip-trace person whose name matches the CO-INSURED (owner2), if we have one.
 *
 * Returns null when owner2 carries the INSURED's own name. That is not hypothetical: on
 * a number of leads the co-insured slots hold a copy of owner1 (e.g. insured "Harold
 * Boyer", co-insured "Harold Boyer"), so a plain name match returns the insured's own
 * person record. Treating that as a second person would move the insured's addresses
 * over to a co-insured who does not exist, and the campaign would be left with nobody
 * to mail on email 1.
 */
export function matchCoInsuredPerson(persons: any[], lead: any): any | null {
  const first = norm(lead?.owner2FirstName);
  const last = norm(lead?.owner2LastName);
  if (!first || !last) return null;
  if (first === norm(lead?.owner1FirstName) && last === norm(lead?.owner1LastName)) return null;

  const co = matchPersonByName(persons, first, last);
  // Belt and braces: even with different spellings, the same person record must never
  // count as both parties.
  return co && co === matchInsuredPerson(persons, lead) ? null : co;
}

const personStreet = (p: any) => norm(p?.address?.streetAddress || p?.address?.address);

/**
 * Co-insured = the spouse / co-owner — NOT an adult child or a stranger on the loan
 * (Frank/Ruben Jul-2026). Preference order:
 *   1. same property address as the insured AND age within 15 yrs  (spouse, co-resident)
 *   2. same property address (any age)
 *   3. same surname AND age within 15 yrs                          (joint owner who moved)
 *   4. same surname (relative — weaker, still surfaced for the producer to confirm)
 * If none plausibly qualify, returns null — we never attach a random person.
 */
function pickCoInsured(persons: any[], primary: any, lead: any): any | null {
  const others = persons.filter((p) => p !== primary);
  if (!others.length) return null;
  const o1Last = norm(lead.owner1LastName);
  const propStreet = norm(lead.addressStreet);
  const primaryAge = Number(primary?.age) || null;
  const ageOk = (p: any) => { const a = Number(p?.age); return primaryAge && a ? Math.abs(a - primaryAge) <= 15 : false; };
  const sameAddr = (p: any) => !!propStreet && personStreet(p) === propStreet;

  return others.find((p) => sameAddr(p) && ageOk(p))
    ?? others.find((p) => sameAddr(p))
    ?? others.find((p) => o1Last && norm(p.lastName) === o1Last && ageOk(p))
    ?? others.find((p) => o1Last && norm(p.lastName) === o1Last)
    ?? null;
}

/** Phones / emails on a single REAPI person, normalized to string arrays. */
function personContacts(p: any): { phones: string[]; emails: string[] } {
  const phones = (Array.isArray(p?.phones) ? p.phones : [])
    .map((ph: any) => (typeof ph === 'string' ? ph : ph?.phone)).filter(Boolean).map(String);
  const emails = (Array.isArray(p?.emails) ? p.emails : [])
    .map((em: any) => (typeof em === 'string' ? em : em?.email)).filter(Boolean).map(String);
  return { phones, emails };
}

/**
 * Pull phone/email arrays out of REAPI's v2 SkipTrace response, INSURED FIRST.
 * The insured's own contacts lead the list so phone1/email1 belong to the named
 * insured — not the co-insured or another person on the loan (Frank Jul-2026).
 */
function extractContacts(json: any, insured: any | null): { phones: string[]; emails: string[] } {
  const persons: any[] = Array.isArray(json?.persons) ? json.persons : [];
  const ordered = insured ? [insured, ...persons.filter((p) => p !== insured)] : persons;
  const phones: string[] = [];
  const emails: string[] = [];
  for (const p of ordered) {
    const c = personContacts(p);
    phones.push(...c.phones);
    emails.push(...c.emails);
  }
  return { phones: [...new Set(phones)], emails: [...new Set(emails)] };
}

/** Letters only, lower-cased — so "O'Brien" and "OBrien" are one name. */
const nameToken = (v: unknown) => String(v ?? '').toLowerCase().replace(/[^a-z]/g, '');

/**
 * Is this candidate the person already named in the co-insured slot?
 *
 * Compared as a SET of tokens, not first-then-last. Vendors routinely return a name the
 * other way up — Tracerfy gave "Ashraf Waqas" for a homeowner the CRM holds as "Waqas
 * Ashraf" — and an ordered comparison reads that as a stranger.
 *
 * Deliberately strict: an unsure answer must come back false. A false negative costs one
 * contact detail we already hold elsewhere; a false positive writes one person's email
 * under another person's name, which is the fault this whole guard exists to stop.
 */
function isSamePerson(
  aFirst: unknown, aLast: unknown, bFirst: unknown, bLast: unknown,
): boolean {
  const a = [nameToken(aFirst), nameToken(aLast)].filter((t) => t.length >= 2);
  const b = [nameToken(bFirst), nameToken(bLast)].filter((t) => t.length >= 2);
  if (a.length < 2 || b.length < 2) return false;

  const sameSet = a.every((t) => b.includes(t)) && b.every((t) => a.includes(t));
  if (sameSet) return true;

  // Surnames agree and one first name is a prefix of the other — "Alla" / "Allan".
  const [aF, aL] = a; const [bF, bL] = b;
  const surname = aL === bL || aL === bF || aF === bL;
  if (!surname) return false;
  const firstA = aL === bL ? aF : (aL === bF ? aF : aL);
  const firstB = aL === bL ? bF : (aL === bF ? bL : bF);
  const [short, long] = firstA.length <= firstB.length ? [firstA, firstB] : [firstB, firstA];
  return short.length >= 3 && long.startsWith(short);
}

export type CoInsuredCandidate = {
  firstName?: unknown; lastName?: unknown;
  phone?: unknown; email?: unknown; dob?: unknown;
};

/**
 * Fill the co-insured slot FROM ONE PERSON, or not at all.
 *
 * ── The fault this replaces ─────────────────────────────────────────────────
 * Every co-insured field used to be guarded on its own: write the name if the name is
 * empty, write the email if the email is empty, and so on. Each line is defensible and
 * the combination is not — a card that already named a co-insured kept that name and
 * took the EMAIL from whichever person the trace happened to pick.
 *
 * Lead 251520882 is what that produces. The card names Waqas Ashraf as insured and
 * Zebunnisa Saeed as co-insured. Tracerfy returned a "relative" called Ashraf Waqas —
 * the insured himself, name reversed — carrying waqas24@yahoo.com. The name guard held,
 * the email guard did not, and the co-insured record became "Zebunnisa Saeed ·
 * waqas24@yahoo.com". An email opening "Dear Zebunnisa" would arrive in Waqas's inbox,
 * greeting him by his wife's name, and every report would call that lead reachable at
 * the co-insured. 29 Grade A cards in C1 onward are in that state.
 *
 * ── The rule ────────────────────────────────────────────────────────────────
 * The slot describes ONE human being, so it is filled as one unit:
 *
 *   · Slot already named  → contacts are taken only from that same person. The name is
 *                           never rewritten.
 *   · Slot empty          → name and contacts are taken together, from one person, and
 *                           only when that person actually has a name. An unnamed
 *                           contact dropped into a named slot is the original fault.
 *   · Candidate is the insured → nothing. A second copy of the policyholder is not a
 *                           second person, however the vendor labelled it.
 *
 * Producer entries are still never overwritten — that part was always right.
 */
export function coInsuredPatch(lead: any, candidate: CoInsuredCandidate | null | undefined): Record<string, any> {
  if (!candidate) return {};

  const cFirst = String(candidate.firstName ?? '').trim();
  const cLast = String(candidate.lastName ?? '').trim();

  // Never file the policyholder as their own co-insured.
  if (isSamePerson(cFirst, cLast, lead?.owner1FirstName, lead?.owner1LastName)) return {};

  const slotNamed = !!String(lead?.owner2FirstName ?? '').trim()
    && !!String(lead?.owner2LastName ?? '').trim();

  const patch: Record<string, any> = {};
  const put = (key: string, value: unknown) => {
    const v = typeof value === 'string' ? value.trim() : value;
    if (v == null || v === '') return;
    if (String(lead?.[key] ?? '').trim()) return;   // producer entry wins, always
    patch[key] = v;
  };

  if (slotNamed) {
    // Only this person's details may go into this person's slot.
    if (!isSamePerson(cFirst, cLast, lead.owner2FirstName, lead.owner2LastName)) return {};
  } else {
    // Nothing is named yet, so the identity and the contacts arrive together or not at all.
    if (!cFirst || !cLast) return {};
    put('owner2FirstName', cFirst);
    put('owner2LastName', cLast);
  }

  put('owner2Phone', candidate.phone);
  put('owner2Email', candidate.email);
  put('owner2Dob', candidate.dob);
  return patch;
}

/**
 * Map skip-trace persons onto the lead's Insured Info, filling EMPTY slots only
 * (never clobber producer entries). REAPI DOB comes strictly from the name-matched
 * insured; the co-insured is the plausible spouse/co-owner (see pickCoInsured). REAPI
 * returns `age`, not a birth date, so DOB is an estimated birth year the producer confirms.
 */
export function insuredPatchFromPersons(persons: any[], lead: any): Record<string, any> {
  const list = Array.isArray(persons) ? persons : [];
  if (!list.length) return {};

  const nameMatch = matchInsuredPerson(list, lead);
  const primary = nameMatch ?? list[0];
  const coInsured = pickCoInsured(list, primary, lead);

  const estDob = (age: any): string | undefined => {
    const a = parseInt(String(age), 10);
    return a > 0 && a < 120 ? `${new Date().getFullYear() - a}-01-01` : undefined;
  };
  // Prefer the skip-trace's actual year-month DOB (e.g. "1996-04" → 1996-04-01); only fall
  // back to the age-derived year (…-01-01) when no real DOB is returned.
  const dobOf = (p: any): string | undefined => {
    const m = String(p?.dob ?? '').match(/^(\d{4})-(\d{2})/);
    if (m) return `${m[1]}-${m[2]}-01`;
    return estDob(p?.age);
  };

  const patch: Record<string, any> = {};

  // REAPI DOB — strictly from the name-matched insured (read-only display field).
  if (nameMatch != null && (nameMatch.dob || nameMatch.age != null)) {
    const a = parseInt(String(nameMatch.age), 10);
    const d = dobOf(nameMatch);
    if (d) patch.reapiDob = d;
    if (a > 0 && a < 120) patch.reapiAge = a;
  }

  // Co-insured's OWN contact info (Frank Oct-2026) — so the spouse gets their own
  // phone/email slots instead of being crowded out by the insured's numbers.
  //
  // Name, phone, email and date of birth go through coInsuredPatch TOGETHER, so this
  // slot can never end up describing one person and holding another's address.
  if (coInsured) {
    const cc = personContacts(coInsured);
    Object.assign(patch, coInsuredPatch(lead, {
      firstName: coInsured.firstName,
      lastName: coInsured.lastName,
      phone: cc.phones[0],
      email: cc.emails[0],
      dob: dobOf(coInsured),
    }));
  }
  // The insured's own editable DOB (empty slots only); reapiDob above stays source-of-truth.
  if (!lead.owner1Dob) { const d = dobOf(primary); if (d) patch.owner1Dob = d; }
  return patch;
}

/**
 * Run a skip trace for a single lead against the owner name + property address.
 * Returns de-duplicated phones/emails (insured first); throws on transport / auth errors.
 */
export async function runSkipTrace(lead: Lead): Promise<SkipTraceResult> {
  if (!API_CONFIG.API_KEY) {
    throw new Error('REAPI key not configured (NEXT_PUBLIC_REAL_ESTATE_API_KEY).');
  }

  const l = lead as any;
  // Property address is required; mailing address (if present) sharpens the match
  // for absentee owners. REAPI rejects empty-string params, so only send non-empty.
  const candidate: Record<string, unknown> = {
    first_name: l.owner1FirstName,
    last_name: l.owner1LastName,
    address: l.addressStreet,
    city: l.addressCity,
    state: l.addressState,
    zip: l.addressZip,
    mail_address: l.mailStreet,
    mail_city: l.mailCity,
    mail_state: l.mailState,
    mail_zip: l.mailZip,
  };
  const body: Record<string, string> = {};
  for (const [k, v] of Object.entries(candidate)) {
    const s = v == null ? '' : String(v).trim();
    if (s) body[k] = s;
  }

  const res = await fetch(SKIPTRACE_URL, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': API_CONFIG.API_KEY,
      'x-user-id': API_CONFIG.USER_ID,
    },
    body: JSON.stringify(body),
  });

  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new Error(`REAPI SkipTrace ${res.status}: ${text.slice(0, 200)}`);
  }

  const json = await res.json();
  // Insured-first contact ordering: phone1/email1 belong to the named insured.
  const insured = matchInsuredPerson(Array.isArray(json?.persons) ? json.persons : [], lead);
  const { phones, emails } = extractContacts(json, insured);
  const matched = json?.match === true || (json?.resultCount ?? 0) > 0
    || (Array.isArray(json?.persons) && json.persons.length > 0)
    || phones.length > 0 || emails.length > 0;

  return { phones, emails, matched, raw: json };
}
