import type { Lead } from '@/types/lead';
import { matchInsuredPerson, insuredPatchFromPersons, coInsuredPatch } from './skipTrace.service';
import { logTrace } from './skipTraceLog.service';
import { readVendorJson } from './vendorErrors';

/**
 * Tracerfy skip trace (Frank Aug-2026) — REPLACES the REAPI skip trace, whose data was
 * corrupt (wrong owners, junk emails like "jessica6267@netscape.com"). Tracerfy returns
 * real, ranked owner contacts with DNC/TCPA/carrier flags.
 *
 * Endpoint (verified live): POST https://tracerfy.com/v1/api/trace/enhanced/lookup/
 *   body: { first_name, last_name, address, city, state, zip }  auth: Bearer <TRACERFY_API_KEY>
 *   → { hit, persons:[{ first_name, last_name, age, mailing_address:{street,...},
 *        phones:[{ number, type, dnc, tcpa, carrier, rank }], emails:[{ email, rank }] }],
 *        credits_deducted }   (15 credits per hit, 0 on miss)
 *
 * The insured/co-insured/DOB logic already exists for the old provider, so we normalize
 * Tracerfy's people onto that person shape and reuse it verbatim.
 */
// The Tracerfy ENHANCED tier is the ONLY skip trace in the system (Frank Aug-2026). The
// 5-credit standard address lookup was removed: same vendor, thinner data, and the deep
// tier measured 78% hit / 59% email recovery on accounts the standard tier had left with
// no contact at all. 15 credits per call.
//
// IMPORTANT: this endpoint targets the NAMED INSURED, so a lead with no owner1First/Last
// name on file cannot be traced at all now that the address-based lookup is gone. Callers
// must gate on the name being present rather than letting this throw.
const ENHANCED_URL = 'https://tracerfy.com/v1/api/trace/enhanced/lookup/';
/**
 * The 5-credit name-scoped lookup, used ONLY as the co-insured fallback below.
 *
 * Not a replacement for the enhanced tier: it returns no relatives block, which is where
 * three quarters of our co-insured contacts come from. Measured side by side on 30 leads,
 * swapping to it wholesale would have lost the co-insured on 14 of every 30.
 */
const LOOKUP_URL = 'https://tracerfy.com/v1/api/trace/lookup/';

export interface TracerfyResult {
  phones: string[];
  emails: string[];
  matched: boolean;
  raw?: unknown;                      // full Tracerfy response (keeps DNC/TCPA/carrier/rank)
  insuredPatch: Record<string, any>;  // co-insured + DOB, empty-slot fill only
  personCount: number;
  ownerName: string | null;           // insured/owner name Tracerfy returned (for name-mismatch QC)
}

/**
 * Map a Tracerfy person onto the REAPI-person shape the skipTrace helpers expect
 * (firstName / lastName / age / address.streetAddress / phones[].phone / emails[].email),
 * so matchInsuredPerson, pickCoInsured, and insuredPatchFromPersons work unchanged.
 */
function toReapiPerson(p: any) {
  return {
    firstName: p?.first_name ?? '',
    lastName: p?.last_name ?? '',
    age: p?.age ?? null,
    dob: p?.dob ?? null,   // Tracerfy year-month DOB (e.g. "1996-04") — more precise than age
    address: { streetAddress: p?.mailing_address?.street ?? '' },
    phones: (Array.isArray(p?.phones) ? p.phones : [])
      .map((ph: any) => ({ phone: String(ph?.number ?? ''), dnc: !!ph?.dnc, type: ph?.type, rank: ph?.rank })),
    emails: (Array.isArray(p?.emails) ? p.emails : [])
      .map((em: any) => ({ email: String(em?.email ?? ''), rank: em?.rank })),
  };
}

/**
 * Skip trace one lead by property address. Returns de-duplicated phones/emails with the
 * named INSURED's contacts first (so phone1/email1 belong to them, not a co-owner), plus
 * the co-insured/DOB patch and the full raw response. Throws on transport / auth errors.
 */
export async function runTracerfy(
  lead: Lead,
  /** Set by a blast so its traces can be summarised as one run (Frank, 1 Oct). */
  opts: { runId?: string | null; by?: string | null } = {},
): Promise<TracerfyResult> {
  const startedAt = Date.now();
  let requests = 0;
  const key = process.env.TRACERFY_API_KEY;
  if (!key) throw new Error('Tracerfy API key not configured (TRACERFY_API_KEY).');

  const l = lead as any;
  const address = String(l.addressStreet ?? '').trim();
  const city = String(l.addressCity ?? '').trim();
  const state = String(l.addressState ?? 'NJ').trim();
  const zip = String(l.addressZip ?? '').trim();
  if (!address || !city) {
    throw new Error('Lead is missing a property address, so it cannot be skip traced.');
  }

  // The enhanced endpoint keys off the named insured — first + last are required.
  const first = String(l.owner1FirstName ?? '').trim();
  const last = String(l.owner1LastName ?? '').trim();
  if (!first || !last) {
    throw new Error('Skip trace needs the insured first + last name on file.');
  }

  const callEnhanced = async (firstName: string) => {
    requests++;
    const res = await fetch(ENHANCED_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${key}` },
      body: JSON.stringify({ first_name: firstName, last_name: last, address, city, state, zip }),
      signal: AbortSignal.timeout(30000),
    });
    // Classified rather than stringified: a blast has to know whether this was THIS
    // lead's problem or the account's, and a message it has to pattern-match later is
    // how a dead account kept getting billed for another 290 calls.
    return readVendorJson('Tracerfy', res);
  };

  // Middle-name retry (Frank Sep-2026). owner1FirstName often holds a middle name too —
  // "Jesse Meyer" for Jesse Meyer Horowitz — and Tracerfy will not match on that, so the
  // lookup comes back empty. Measured across the traced book: compound first names missed
  // 80% of the time vs 14% for single ones, and 924 leads carry one. A miss is billed 0
  // credits, so retrying with just the first token is free and recovers the match.
  let json: any = await callEnhanced(first);
  const firstToken = first.split(/\s+/)[0];
  if (!json?.hit && firstToken && firstToken !== first) {
    json = await callEnhanced(firstToken);
  }
  const rawPersons: any[] = Array.isArray(json?.persons) ? json.persons : [];

  /**
   * ── Second call for a co-insured the enhanced trace did not return ───────
   *
   * Tracerfy's own suggestion (Jorge, 13 Oct 2026) and measured before adopting.
   *
   * Enhanced finds the named co-insured on 1,035 of 1,380 traced cards — 75%. On the
   * 345 it misses, a NAME-SCOPED lookup recovered them on 40 of 87 tried, and 40 of the
   * 41 people it returned were the right person: 97% precision. That sample gained 176
   * numbers, 81 of them mobile, and 59 addresses, for 205 credits — about 5 credits per
   * co-insured found.
   *
   * ── Why find_owner must be false ────────────────────────────────────────
   * It defaults to TRUE, which makes the endpoint address-scoped: it returns whoever has
   * lived at the property and ignores the name sent with it. Our first comparison missed
   * this and measured 29% unrelated people as a result. With it off the endpoint answers
   * the question actually asked — "this person, at this address".
   *
   * ── Why this is safe to run automatically ───────────────────────────────
   * A miss bills nothing, so the cost is bounded by the successes. It only fires when the
   * card already names a second person AND the enhanced payload does not contain them,
   * so it cannot run on a card with no co-insured or duplicate work already done.
   */
  /** Only the fields this block reads — enough to avoid an any, honest about the rest. */
  type NamedPerson = { first_name?: string; firstName?: string; last_name?: string; lastName?: string;
    relatives?: NamedPerson[] };
  const coFirst = String(l.owner2FirstName ?? '').trim();
  const coLast = String(l.owner2LastName ?? '').trim();
  const nameKey = (v: unknown) => String(v ?? '').toLowerCase().replace(/[^a-z]/g, '');
  const wantsCo = coFirst && coLast
    // A co-insured slot holding the insured's own name is not a second person — the same
    // guard every other co-insured rule applies.
    && !(nameKey(coFirst) === nameKey(first) && nameKey(coLast) === nameKey(last));

  if (wantsCo) {
    const want = nameKey(coFirst) + nameKey(coLast);
    const already = rawPersons.some((p) => [p, ...(Array.isArray(p?.relatives) ? p.relatives : [])]
      .some((y: NamedPerson) => nameKey(y?.first_name ?? y?.firstName) + nameKey(y?.last_name ?? y?.lastName) === want));

    if (!already) {
      requests++;
      try {
        const res = await fetch(LOOKUP_URL, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${key}` },
          body: JSON.stringify({
            address, city, state, zip,
            find_owner: false, first_name: coFirst, last_name: coLast,
          }),
          signal: AbortSignal.timeout(30000),
        });
        const co = await readVendorJson('Tracerfy', res) as { persons?: NamedPerson[] } | null;
        /*
         * Only the person we asked for is taken.
         *
         * Even name-scoped the endpoint can return a near miss, and 1 of the 41 it
         * returned in testing was somebody else. Appending whatever came back is how a
         * stranger's numbers end up on a card labelled with the co-insured's name.
         */
        for (const p of (Array.isArray(co?.persons) ? co.persons : []) as NamedPerson[]) {
          if (nameKey(p?.first_name) + nameKey(p?.last_name) === want) rawPersons.push(p);
        }
      } catch {
        // The fallback is a bonus, never a reason to lose the enhanced result that
        // already succeeded. A failure here leaves the trace exactly as it was.
      }
    }
  }

  const persons = rawPersons.map(toReapiPerson);

  // Insured first — same ordering rule as the old provider.
  const insured = matchInsuredPerson(persons, l);
  const ordered = insured ? [insured, ...persons.filter((p: any) => p !== insured)] : persons;
  const phones: string[] = [];
  const emails: string[] = [];
  for (const p of ordered) {
    for (const ph of p.phones) if (ph.phone) phones.push(ph.phone);
    for (const em of p.emails) if (em.email) emails.push(em.email);
  }

  const insuredPatch = insuredPatchFromPersons(persons, l);

  // Deep / enhanced trace: the recovered household contacts live in `relatives`, NOT in
  // persons[] (the named insured often has few/no emails of their own). Fill the co-insured
  // slots from the top-ranked relative so a married/family household stays reachable, and
  // add their numbers/emails to the overall pool. Producer confirms who's who on the call.
  if (rawPersons[0]?.relatives?.length) {
    const rels = [...rawPersons[0].relatives].sort((a: any, b: any) => (a?.rank ?? 99) - (b?.rank ?? 99));
    const relPhone = (r: any) => (Array.isArray(r?.phones) ? r.phones[0]?.number : undefined);
    const relEmail = (r: any) => (Array.isArray(r?.emails) ? r.emails[0]?.email : undefined);
    // Prefer the top-ranked relative that actually has a contact to hand over.
    const top = rels.find((r: any) => relPhone(r) || relEmail(r)) ?? rels[0];
    if (top) {
      /**
       * One person, or nothing — see coInsuredPatch.
       *
       * This block used to guard each field separately, which is how lead 251520882 came
       * to read "Zebunnisa Saeed · waqas24@yahoo.com": the card already named a
       * co-insured so the name was kept, and the email was taken from a "relative"
       * Tracerfy called Ashraf Waqas — the insured himself with his name the other way
       * up. The address was real and it belonged to the wrong person on the card.
       *
       * The lead already in hand is passed with the pending patch merged over it, so a
       * co-insured this trace has just proposed is respected the same way a stored one is.
       */
      const rd = String(top.dob ?? '').match(/^(\d{4})-(\d{2})/);
      Object.assign(insuredPatch, coInsuredPatch({ ...l, ...insuredPatch }, {
        firstName: top.first_name,
        lastName: top.last_name,
        phone: relPhone(top),
        email: relEmail(top),
        dob: rd ? `${rd[1]}-${rd[2]}-01` : undefined,
      }));
    }
  }

  // Name-mismatch surface (Frank Aug-2026): flag ONLY when the on-file insured matched
  // NONE of the traced people. If the insured IS among the persons returned — just not the
  // top-ranked / property_owner one (e.g. a spouse owns the deed) — there is no genuine
  // mismatch, so leave ownerName null and no override is offered. Never auto-applied.
  const ownerRaw = rawPersons.find((p: any) => p?.property_owner) ?? rawPersons[0];
  const ownerName = insured
    ? null
    : ownerRaw
      ? [ownerRaw.first_name, ownerRaw.last_name].filter(Boolean).join(' ').trim() || null
      : null;

  const dedupedPhones = [...new Set(phones)];
  const dedupedEmails = [...new Set(emails)];
  const matched = !!json?.hit && (persons.length > 0);

  /**
   * Logged here rather than at the call sites — see skipTraceLog.service for why.
   *
   * Awaited, so a trace and its record cannot be separated by the process ending between
   * them. The write swallows its own failures, so this can never cost us a trace.
   */
  await logTrace({
    leadId: String(l.id),
    propertyId: l.propertyId ? String(l.propertyId) : null,
    provider: 'tracerfy',
    tier: 'enhanced',
    runId: opts.runId ?? null,
    sentFirstName: first,
    sentLastName: last,
    sentAddress: address,
    sentCity: city,
    sentState: state,
    sentZip: zip,
    requests,
    outcome: matched ? 'hit' : 'miss',
    returnedName: ownerName,
    personCount: persons.length,
    phoneCount: dedupedPhones.length,
    emailCount: dedupedEmails.length,
    // Read from the response, never assumed at 15 a hit — the assumption is precisely what
    // a question about the bill would be checking.
    credits: Number(json?.credits_deducted ?? 0) || 0,
    durationMs: Date.now() - startedAt,
    createdBy: opts.by ?? null,
  });

  return {
    phones: dedupedPhones,
    emails: dedupedEmails,
    matched,
    raw: json,
    insuredPatch,
    personCount: persons.length,
    ownerName,
  };
}
