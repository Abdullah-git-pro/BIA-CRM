import { matchInsuredPerson, matchCoInsuredPerson } from './skipTrace.service';

/**
 * Who a household can actually be reached at.
 *
 * One definition, shared by the campaign push and the reachability report. They must not
 * drift: a report that counts addresses the push would never use promises reach we do
 * not have, and the gap would only show up as a cohort quietly under-performing its own
 * forecast.
 *
 * Reachability only — no suppression, no holdout, no primary-contact routing. Those are
 * decisions about whether to mail someone we CAN reach, and they belong to the push.
 */

/** A lead row as it comes back from the DB. Columns vary by query, so this stays loose. */
type LeadLike = Record<string, any>;

export const EMAIL_RE = /^[^@\s]+@[^@\s]+\.[^@\s]+$/;

/**
 * Every address belonging to the NAMED INSURED — and nobody else.
 *
 * ── Why not emailsAll ────────────────────────────────────────────────────────
 * emailsAll is everything the skip trace returned for the PROPERTY, which routinely
 * includes relatives, prior owners and unrelated co-residents. One live example carries
 * 16 addresses across six surnames. Mailing that pool would send insurance-renewal
 * outreach to people who do not own the property — a complaint and bounce risk on
 * domains that have to stay clean.
 *
 * The raw trace payload attributes emails PER PERSON, so the insured's own addresses can
 * be picked out exactly. For the same lead that is 3 addresses, not 16.
 *
 * The co-insured is excluded here because they are a different person — see
 * coInsuredEmails, which is what the reachability report counts separately.
 */
/**
 * The stored payload is the vendor's snake_case shape; the matchers expect the REAPI
 * camelCase one. Normalised once here rather than per-caller.
 */
function tracedPersons(lead: LeadLike): any[] {
  /**
   * The current trace's people AND those the previous trace attributed.
   *
   * A re-trace replaces skipTraceData, so without priorPersons an address the first
   * vendor tied to the insured stops being counted as theirs the moment a second vendor
   * answers — the lead looks less reachable than it is, and the campaign quietly skips
   * an address we already hold and paid for. Current first, so the freshest attribution
   * wins any tie; de-duplication happens downstream in cleanEmails / cleanPhones.
   */
  const current = Array.isArray(lead?.skipTraceData?.persons) ? lead.skipTraceData.persons : [];
  const prior = Array.isArray(lead?.skipTraceData?.priorPersons) ? lead.skipTraceData.priorPersons : [];
  const raw = [...current, ...prior];
  return raw.map((p: any) => ({
    ...p,
    firstName: p.firstName ?? p.first_name,
    lastName: p.lastName ?? p.last_name,
    emails: (Array.isArray(p.emails) ? p.emails : [])
      .map((e: any) => (typeof e === 'string' ? e : e?.email))
      .filter(Boolean),
    phones: (Array.isArray(p.phones) ? p.phones : [])
      .map((x: any) => (typeof x === 'string' ? x : x?.number ?? x?.phone))
      .filter(Boolean),
  }));
}

/** Lower-cased, de-duplicated, syntactically valid addresses, in the order given. */
function cleanEmails(values: unknown[], exclude: Set<string> = new Set()): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const value of values) {
    const email = String(value ?? '').trim().toLowerCase();
    if (!email || exclude.has(email) || seen.has(email) || !EMAIL_RE.test(email)) continue;
    seen.add(email);
    out.push(email);
  }
  return out;
}

/**
 * Household addresses whose local part NAMES the co-insured.
 *
 * ── Why this is needed ──────────────────────────────────────────────────────
 * Attribution lives in the trace payload, and a payload can be replaced by a later trace
 * from another vendor. When that happens the household's addresses survive in emailsAll
 * while the record linking them to a person does not, so a lead can plainly hold
 * suma_sreejith@hotmail.com for a co-insured called Suma Sreejith and still report no
 * co-insured email — the evidence is on the card and the rule cannot see it.
 *
 * ── Why BOTH names are required ─────────────────────────────────────────────
 * The insured and co-insured usually share a surname, so "sreejith@hotmail.com" could
 * belong to either and must not be claimed for the second party. Requiring the first name
 * AND the surname in the local part is what separates them. This is the same test
 * addressRank already applies when ranking an address against the person it is meant to
 * reach; it is deliberately the strict half of it.
 */
function coInsuredNamedInHousehold(lead: LeadLike): string[] {
  const first = String(lead?.owner2FirstName ?? '').toLowerCase().replace(/[^a-z]/g, '');
  const last = String(lead?.owner2LastName ?? '').toLowerCase().replace(/[^a-z]/g, '');
  if (first.length < 3 || last.length < 3) return [];

  // A co-insured slot holding the insured's own name is not a second person — the same
  // guard matchCoInsuredPerson applies.
  const o1First = String(lead?.owner1FirstName ?? '').toLowerCase().replace(/[^a-z]/g, '');
  const o1Last = String(lead?.owner1LastName ?? '').toLowerCase().replace(/[^a-z]/g, '');
  if (first === o1First && last === o1Last) return [];

  const household = Array.isArray(lead?.emailsAll) ? lead.emailsAll : [];
  return cleanEmails(
    household.filter((e: unknown) => {
      const local = String(e ?? '').split('@')[0].toLowerCase().replace(/[^a-z]/g, '');
      return local.includes(first) && local.includes(last);
    }),
  );
}

/** Every address belonging to the co-insured, before the insured's are removed. */
/**
 * The co-insured's own addresses inside the RELATIVES blocks.
 *
 * The email twin of coInsuredRelativePhones, and the same gap: tracedPersons() never
 * descends into `relatives`, so a co-insured the vendor filed there was invisible.
 * Measured across Grade A from C1 onward, 407 of the cards with a named co-insured were
 * holding 712 addresses that way.
 *
 * The guard is identity, exactly as it is for phones — BOTH names must equal the
 * co-insured already on the card — and the insured's own addresses are never taken,
 * because insuredEmails() is built by excluding this pool and a shared household address
 * must not be removed from the person the campaign actually writes to.
 *
 * This is ADDITIVE: it can only give the co-insured addresses nobody else claimed. It
 * does not change who is mailed on email 1, which goes to the named insured only.
 */
function coInsuredRelativeEmails(lead: LeadLike): string[] {
  const first = String(lead?.owner2FirstName ?? '').toLowerCase().replace(/[^a-z]/g, '');
  const last = String(lead?.owner2LastName ?? '').toLowerCase().replace(/[^a-z]/g, '');
  if (!first || !last) return [];

  const iFirst = String(lead?.owner1FirstName ?? '').toLowerCase().replace(/[^a-z]/g, '');
  const iLast = String(lead?.owner1LastName ?? '').toLowerCase().replace(/[^a-z]/g, '');
  if (first === iFirst && last === iLast) return [];

  const out: unknown[] = [];
  for (const r of tracedRelatives(lead)) {
    if (!relativeIs(r, first, last)) continue;
    for (const em of (Array.isArray(r.emails) ? r.emails : []) as Array<Record<string, unknown> | string>) {
      out.push(typeof em === 'string' ? em : em?.email);
    }
  }

  // Never take an address the insured holds: the columns are what the campaign mails.
  const insuredOwn = new Set(cleanEmails([
    lead?.email1,
    lead?.email2,
    ...(matchInsuredPerson(tracedPersons(lead), lead)?.emails ?? []),
  ]));
  return cleanEmails(out).filter((e) => !insuredOwn.has(e));
}

function coInsuredEmailPool(lead: LeadLike): string[] {
  /*
   * Same guard, and it matters more here than on the phone side.
   *
   * insuredEmails() is built by EXCLUDING this pool, so an owner2Email taken for a
   * co-insured who does not exist is not merely mislabelled — it is removed from the
   * insured. Seven addresses from C1 onward were held only in that column, so the
   * campaign had nothing to write to on those cards and they read as unreachable.
   */
  if (!hasDistinctCoInsured(lead)) return [];

  const co = matchCoInsuredPerson(tracedPersons(lead), lead);
  return cleanEmails([
    lead?.owner2Email,
    ...(co?.emails ?? []),
    ...coInsuredNamedInHousehold(lead),
    ...coInsuredRelativeEmails(lead),
  ]);
}

export function insuredEmails(lead: LeadLike): string[] {
  const insured = matchInsuredPerson(tracedPersons(lead), lead);

  // The numbered slots come first: they are the insured's working addresses, and one may
  // have been typed in by a producer and never appear in any trace.
  const ordered = [lead?.email1, lead?.email2, ...(insured?.emails ?? [])];

  // Everything the co-insured owns is excluded, not just owner2Email. Once the
  // co-insured's other addresses are read out of the trace payload, an address that
  // belongs to them can appear in the insured's person record too, and counting it as
  // insured reach would mean the campaign mails the wrong person.
  return cleanEmails(ordered, new Set(coInsuredEmailPool(lead)));
}

/**
 * Every address belonging to the CO-INSURED — not just owner2Email.
 *
 * The co-insured used to be read from that one column, so a co-insured with three
 * addresses in the trace payload counted as one and the other two were invisible to the
 * report and to any export. The trace attributes addresses per person, so theirs can be
 * picked out exactly the same way the insured's are.
 *
 * Not mailed on email 1 — campaigns open to the named insured only. Counted separately
 * so the report can answer the question that raises: how many households we could reach
 * if the rule changed, and how many we can reach ONLY that way.
 */
export function coInsuredEmails(lead: LeadLike): string[] {
  // An address that is also one of the insured's is not extra reach. It happens: a
  // shared household address gets typed into both slots, and counting it twice would
  // overstate what mailing the co-insured would actually add.
  const insured = new Set(insuredEmails(lead));
  return coInsuredEmailPool(lead).filter((e) => !insured.has(e));
}

/** Digits only, so 732-690-2327 and 7326902327 are recognised as one number. */
const digits = (v: unknown): string => String(v ?? '').replace(/\D/g, '');

/** A US number is 10 digits, or 11 starting with the country code. */
function normalisePhone(v: unknown): string | null {
  let d = digits(v);
  if (d.length === 11 && d.startsWith('1')) d = d.slice(1);
  return d.length === 10 ? d : null;
}

/**
 * Every phone number belonging to the NAMED INSURED — the exact mirror of insuredEmails,
 * and for the same reason: phonesAll is everything the trace returned for the PROPERTY,
 * so counting it answers "is anyone at this address contactable" rather than "can we
 * reach the person whose policy is renewing".
 *
 * The two vendors disagree on the field name — Tracerfy returns `number`, REAPI returns
 * `phone` — so both are read. A shape that carries neither yields nothing rather than a
 * string of "[object Object]".
 */
/** Normalised, de-duplicated numbers, in the order given. */
function cleanPhones(values: unknown[], exclude: Set<string> = new Set()): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const value of values) {
    const phone = normalisePhone(value);
    if (!phone || exclude.has(phone) || seen.has(phone)) continue;
    seen.add(phone);
    out.push(phone);
  }
  return out;
}

/** Every number belonging to the co-insured, before the insured's are removed. */
/**
 * The co-insured's own records inside the RELATIVES blocks.
 *
 * ── Why this is needed ──────────────────────────────────────────────────────
 * tracedPersons() reads `persons` and `priorPersons` and never descends into
 * `relatives`, so a co-insured the vendor happened to file as a relative of the insured
 * was invisible to the matcher. Measured across Grade A from C1 onward: 245 of the 760
 * cards with a named co-insured were in that state, hiding 813 phone numbers we had
 * already paid for. Alpesh Patel's card showed 8 numbers and held 5 more for Bhavika
 * Patel, the named co-insured, sitting in the relatives list.
 *
 * ── Why this is NOT the contamination bug coming back ───────────────────────
 * On 5 Oct the co-insured slot was filling with whoever the trace happened to return —
 * Tracerfy handed back a "relative" called Ashraf Waqas, the insured's own name
 * reversed, and his email landed against the co-insured's name. The guard against that
 * is identity, not location: BOTH names must equal the co-insured already on the card.
 * This applies exactly that test, so a relative who is not the co-insured is still
 * ignored. It widens where we look, not who counts.
 *
 * Deliberately separate from tracedPersons(): widening that would let
 * matchInsuredPerson search relatives too, which is precisely how the 5 Oct fault
 * happened.
 */
type TracedRelative = Record<string, unknown>;

/**
 * Every relative record the trace filed under any traced person.
 *
 * Deliberately NOT folded into tracedPersons(): widening that would let
 * matchInsuredPerson search relatives too, which is exactly how the 5 Oct contamination
 * happened — a "relative" called Ashraf Waqas, the insured's own name reversed, matched
 * as the insured. This is read only by the two co-insured helpers below, and both
 * require an exact match on BOTH names before taking anything.
 */
function tracedRelatives(lead: LeadLike): TracedRelative[] {
  const data = lead?.skipTraceData as { persons?: unknown } | undefined;
  const persons = Array.isArray(data?.persons) ? data.persons : [];
  const out: TracedRelative[] = [];
  for (const p of persons as Array<Record<string, unknown>>) {
    for (const r of (Array.isArray(p?.relatives) ? p.relatives : []) as TracedRelative[]) out.push(r);
  }
  return out;
}

/** Is this relative record the person named in the co-insured slot? Both names, exactly. */
function relativeIs(r: TracedRelative, first: string, last: string): boolean {
  const key = (v: unknown) => String(v ?? '').toLowerCase().replace(/[^a-z]/g, '');
  return key(r.first_name ?? r.firstName) === first && key(r.last_name ?? r.lastName) === last;
}

function coInsuredRelativePhones(lead: LeadLike): string[] {
  const first = String(lead?.owner2FirstName ?? '').toLowerCase().replace(/[^a-z]/g, '');
  const last = String(lead?.owner2LastName ?? '').toLowerCase().replace(/[^a-z]/g, '');
  if (!first || !last) return [];

  // A co-insured slot holding the insured's own name is not a second person.
  const iFirst = String(lead?.owner1FirstName ?? '').toLowerCase().replace(/[^a-z]/g, '');
  const iLast = String(lead?.owner1LastName ?? '').toLowerCase().replace(/[^a-z]/g, '');
  if (first === iFirst && last === iLast) return [];

  const out: unknown[] = [];
  for (const r of tracedRelatives(lead)) {
    if (!relativeIs(r, first, last)) continue;
    for (const ph of (Array.isArray(r.phones) ? r.phones : []) as Array<Record<string, unknown> | string>) {
      out.push(typeof ph === 'string' ? ph : ph?.number ?? ph?.phone);
    }
  }

  /**
   * Never take a number the insured already owns.
   *
   * insuredPhones() is built by EXCLUDING the co-insured pool, so anything added here is
   * removed from the insured. Without this guard the first version of this function took
   * Alpesh Patel's phone1 — the number that came with the policy — and relabelled it as
   * Bhavika Patel's, because the vendor lists shared household numbers under both people.
   * Two of his eight numbers moved that way.
   *
   * The insured's claim is the stronger one: phone1 and phone2 are on the policy, and the
   * matched insured person is a direct attribution rather than a relative entry. A number
   * shared by a household should be offered as the insured's, with the co-insured's own
   * numbers added beside it — not swapped.
   */
  const insuredOwn = new Set(cleanPhones([
    lead?.phone1,
    lead?.phone2,
    ...(matchInsuredPerson(tracedPersons(lead), lead)?.phones ?? []),
  ]));
  return cleanPhones(out).filter((p) => !insuredOwn.has(p));
}

function coInsuredPhonePool(lead: LeadLike): string[] {
  // No second person, no pool. Without this, owner2Phone was tagged as a co-insured's
  // number on 9 cards where owner2 is the insured herself — and one of the three
  // "reached on a co-insured's number" was Angela Matera answering her own phone.
  if (!hasDistinctCoInsured(lead)) return [];

  const co = matchCoInsuredPerson(tracedPersons(lead), lead);
  const pool = cleanPhones([
    lead?.owner2Phone,
    ...(co?.phones ?? []),
    ...coInsuredRelativePhones(lead),
  ]);

  /**
   * A number on the POLICY stays the insured's, whoever else also lists it.
   *
   * insuredPhones() is built by excluding this pool, so anything in here is taken away
   * from the insured. Across Grade A from C1 onward that moved 119 policy numbers onto
   * the co-insured, and 113 of them for the same mundane reason: one household line
   * recorded in both phone1/phone2 AND owner2Phone. Yefim Shvarts' card showed both of
   * his policy numbers as his wife's.
   *
   * phone1 and phone2 arrive with the policy, in the named insured's name. That is the
   * strongest attribution in the record and it is not a tie to be broken — so the
   * columns win, and the co-insured keeps every number that is genuinely only theirs.
   * No number leaves the card either way; only the name beside it changes.
   */
  const policyNumbers = new Set(cleanPhones([lead?.phone1, lead?.phone2]));
  return pool.filter((p) => !policyNumbers.has(p));
}

export function insuredPhones(lead: LeadLike): string[] {
  const insured = matchInsuredPerson(tracedPersons(lead), lead);
  const ordered = [lead?.phone1, lead?.phone2, ...(insured?.phones ?? [])];
  return cleanPhones(ordered, new Set(coInsuredPhonePool(lead)));
}

/** Every number belonging to the co-insured, minus any that are already the insured's. */
export function coInsuredPhones(lead: LeadLike): string[] {
  const insured = new Set(insuredPhones(lead));
  return coInsuredPhonePool(lead).filter((p) => !insured.has(p));
}

/**
 * Is there a second person on this policy at all?
 *
 * The owner2 columns are not evidence of one. On 11 Grade A cards from C1 onward they
 * hold a verbatim copy of the insured's own name — "Angela Matera", co-insured "Angela
 * Matera" — and on those cards owner2Phone and owner2Email are simply a third number
 * and a third address belonging to the insured.
 *
 * Every other co-insured rule already checked this (matchCoInsuredPerson, the relatives
 * lookups, the household-address match). The two POOLS did not, because they read the
 * owner2 columns directly before any of those ran. One rule, one place.
 */
function hasDistinctCoInsured(lead: LeadLike): boolean {
  return coInsuredName(lead) !== null;
}

/**
 * The co-insured's name, when there genuinely is one.
 *
 * Uses the same identity guard as the address functions: a co-insured slot holding a
 * copy of the insured's own name is not a second person, and reporting it as one would
 * have the second email in the cadence addressed to the insured twice.
 */
export function coInsuredName(lead: LeadLike): string | null {
  const first = String(lead?.owner2FirstName ?? '').trim();
  const last = String(lead?.owner2LastName ?? '').trim();
  if (!first || !last) return null;
  const same = first.toLowerCase() === String(lead?.owner1FirstName ?? '').trim().toLowerCase()
    && last.toLowerCase() === String(lead?.owner1LastName ?? '').trim().toLowerCase();
  return same ? null : `${first} ${last}`;
}

/**
 * Every "Lead" column these rules read.
 *
 * A query whose rows are passed to the functions above must select ALL of these. This is
 * not obvious from the call site: a missing column does not throw, it silently changes
 * the answer. The reachability report selected owner1FirstName/LastName but not the
 * owner2 pair, so matchCoInsuredPerson found nobody, the co-insured's addresses were
 * never excluded, and that tab reported 521 insured-reachable leads where the Renewal
 * Week tab — which selects every column — reported 518. Two tabs, same question, three
 * leads apart, and nothing failed.
 */
export const RECIPIENT_COLS = [
  'email1', 'email2', 'owner2Email',
  'phone1', 'phone2', 'owner2Phone',
  'owner1FirstName', 'owner1LastName',
  'owner2FirstName', 'owner2LastName',
  'skipTraceData',
  // Read by coInsuredNamedInHousehold. Omitted at first, and the effect was textbook:
  // insuredEmails quietly stopped excluding the co-insured's household addresses in every
  // query that did not select it, so the Cohort Ledger reported 95 mailable where Renewal
  // Week reported 93. Nothing threw; the two tabs simply disagreed.
  'emailsAll',
] as const;

/**
 * Throws if a row is missing a column the rules need.
 *
 * Called once per query rather than per row. Loud on purpose: a wrong count that looks
 * plausible costs more than a failed report.
 */
export function assertRecipientCols(row: LeadLike | undefined, source: string): void {
  if (!row) return;
  const missing = RECIPIENT_COLS.filter((c) => !(c in row));
  if (missing.length) {
    throw new Error(
      `${source}: SELECT is missing column(s) the recipient rules read: ${missing.join(', ')}. `
      + 'Reach counts would be silently wrong.',
    );
  }
}
