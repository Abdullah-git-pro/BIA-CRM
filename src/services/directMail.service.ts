import { sql } from '@/lib/neon';
import { mergeVarsFor } from './mergeVars.service';
import { numberedCohorts } from './cohort';

/**
 * Who gets a letter, what it says, and who is held back.
 *
 *     REAPI pull → tax roll (Gate 0) → carrier rating → direct mail
 *
 * ── Why direct mail needs its own list and not the email list ────────────────
 * An email can be sent to anyone we hold an address for and withdrawn mid-sequence if it
 * turns out wrong. A letter is printed, posted and in somebody's hand; there is no recall.
 * So this list is built from what we can STAND BEHIND rather than from what we can reach,
 * and every exclusion is a positive decision rather than an absence.
 *
 * ── The four gates, and why each one ─────────────────────────────────────────
 *   grade        Grade A only. Grade B has no band at all — 0 of 3,481 carry a carrier
 *                premium — so "the same letter for Grade B" is not a thing that exists.
 *   Gate 0       ownerVerifyStatus = 'match'. Frank's name validation, which in this CRM is
 *                the municipal tax roll: the deed confirms the name we hold. Anything else
 *                goes to a person. 10 of C2's 61 are held back by this and that is the gate
 *                working — a named letter quoting a premium to the wrong household
 *                discloses who we think lives where, and is the one mistake no retry fixes.
 *   band         A letter whose whole payload is a price must have a price. The band is
 *                ABSENT, not null, when no carrier rated the home eligible.
 *   address      A mailing address. 47 Grade A households mail somewhere other than the
 *                property, and the letter follows the owner, not the building.
 *
 * ── The band is not computed here ────────────────────────────────────────────
 * It comes from mergeVarsFor, the same function the campaign emails use. Two definitions of
 * one number is how a household receives an email saying $925–$1,075 and a letter saying
 * something else, over the same renewal, from the same agency, in the same week.
 */

/** A lead's state with respect to being mailable. Every Grade A lead is in exactly one. */
export type MailState =
  /** Everything holds. This one can be printed. */
  | 'ready'
  /** The roll was consulted and could not settle the name — a person has to look. */
  | 'needs_person'
  /** The name is confirmed and nothing is wrong; no carrier has rated the home eligible. */
  | 'awaiting_rating'
  /** The roll has never been run on this lead. */
  | 'roll_not_run'
  /** A town we cannot query at all. Nobody can action it. */
  | 'blocked'
  /** Confirmed and priced, but we hold nowhere to send it. */
  | 'no_address';

export type MailRecipient = {
  leadId: string;
  propertyId: string;
  name: string;
  street: string;
  city: string;
  state: string;
  zip: string;
  /** True when the letter goes somewhere other than the insured property. */
  mailsElsewhere: boolean;
  vars: Record<string, string>;
};

/**
 * The merge variables a LETTER may use.
 *
 * A deliberate subset of the email set. Subject lines, CTA wording and the booking link are
 * email furniture — a letter has no subject and its call to action is a phone number printed
 * on the page. Offering them in the editor would invite a template that references a
 * variable this channel never supplies.
 */
export const LETTER_VARS = [
  'first_name', 'last_name', 'full_name',
  'property_address', 'renewal_date', 'month',
  'band_low', 'band_high',
  'crm_property_id',
] as const;

/** `{{ var }}` tokens in a template, de-duplicated, in the order they first appear. */
export function templateVars(html: string): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  for (const m of String(html ?? '').matchAll(/\{\{\s*([a-zA-Z0-9_]+)\s*\}\}/g)) {
    const v = m[1];
    if (!seen.has(v)) { seen.add(v); out.push(v); }
  }
  return out;
}

function nameOf(lead: Record<string, any>): string {
  return [lead.owner1FirstName, lead.owner1LastName].filter(Boolean).join(' ').trim();
}

/**
 * The letter's variables for one household.
 *
 * band_low / band_high are copied through from mergeVarsFor only when it supplied them. A
 * key present with an empty value is worse than a missing key: the vendor renders it as an
 * empty string mid-sentence and the letter reads "somewhere between  and ", printed, posted
 * and unrecallable. Absent is the honest state and the caller is built to notice it.
 */
export function letterVarsFor(lead: Record<string, any>): Record<string, string> {
  const email = mergeVarsFor(lead, 'insured');
  const take = (k: string) => {
    const v = email[k];
    return v == null || String(v).trim() === '' ? undefined : String(v);
  };

  const vars: Record<string, string> = {};
  const put = (k: string, v: string | undefined) => { if (v !== undefined) vars[k] = v; };

  /**
   * The salutation name is the first token, not the whole field.
   *
   * owner1FirstName carries the middle initial on some records — "Jeffrey J", "Joseph P" —
   * because that is how the property data supplies it. In an email that reads as a data
   * artefact; printed on a letter as "Dear Jeffrey J," it reads as a mail merge nobody
   * checked, which is the exact impression a renewal letter cannot afford. 2 of C2's 50 are
   * like this. The untouched value is still available as full_name.
   */
  put('first_name', String(lead.owner1FirstName ?? '').trim().split(/\s+/)[0] || undefined);
  put('last_name', String(lead.owner1LastName ?? '').trim() || undefined);
  put('full_name', nameOf(lead) || undefined);
  put('property_address', take('property_address'));
  put('renewal_date', take('renewal_date'));
  put('month', take('month'));
  put('band_low', take('band_low'));
  put('band_high', take('band_high'));
  put('crm_property_id', String(lead.propertyId ?? '').trim() || undefined);
  return vars;
}

/** Where one lead stands. Ordered: the first thing that fails is the thing to fix. */
export function mailStateOf(lead: Record<string, any>): MailState {
  const status = String(lead.ownerVerifyStatus ?? '').trim();
  if (!status) return 'roll_not_run';
  if (status === 'unsupported') return 'blocked';
  /**
   * Anything that is not an outright match needs a person — partial, mismatch, ambiguous,
   * not_found and unavailable alike. They are listed apart on the review screen because the
   * question a person is asked differs, but for the purpose of mailing they are one answer:
   * the roll did not confirm this name, so nothing goes in an envelope.
   */
  if (status !== 'match') return 'needs_person';

  const vars = letterVarsFor(lead);
  if (!vars.band_low || !vars.band_high) return 'awaiting_rating';

  const street = String(lead.mailStreet ?? '').trim();
  const zip = String(lead.mailZip ?? '').trim();
  if (!street || !zip) return 'no_address';

  return 'ready';
}

/**
 * The letters a cohort would produce, and nothing else.
 *
 * Returns ONLY the ready ones. The counts of everything held back come from readiness()
 * below — a caller building a batch should not be able to accidentally iterate a list that
 * includes the excluded, which is how an exclusion becomes a send.
 */
export async function mailListFor(cohort: string, grade = 'A'): Promise<MailRecipient[]> {
  return (await cohortMail(cohort, grade)).recipients;
}

/**
 * One read of a cohort, two answers: who gets a letter and why the rest do not.
 *
 * They were two calls, each doing its own `SELECT *` over the same rows. Against a database
 * in another region every round trip is the cost — the same reason a 10s connect timeout
 * once made local pages hang for forty seconds — so asking twice for the same 61 cards was
 * most of a three-second screen. It also guarantees the count and the breakdown describe the
 * same instant, which two separate reads cannot promise.
 */
export async function cohortMail(
  cohort: string,
  grade = 'A',
): Promise<{ recipients: MailRecipient[]; readiness: MailReadiness }> {
  const rows = await sql`
    SELECT * FROM "Lead"
     WHERE "cohort" = ${cohort}
       AND COALESCE("manualGrade","grade") = ${grade}
     ORDER BY "propertyId"` as Array<Record<string, any>>;

  const r: MailReadiness = {
    cohort, total: 0, ready: 0, needsPerson: 0,
    awaitingRating: 0, rollNotRun: 0, blocked: 0, noAddress: 0,
  };
  const out: MailRecipient[] = [];

  for (const lead of rows) {
    r.total++;
    const state = mailStateOf(lead);
    switch (state) {
      case 'ready': r.ready++; break;
      case 'needs_person': r.needsPerson++; break;
      case 'awaiting_rating': r.awaitingRating++; break;
      case 'roll_not_run': r.rollNotRun++; break;
      case 'blocked': r.blocked++; break;
      case 'no_address': r.noAddress++; break;
    }
    if (state !== 'ready') continue;
    const street = String(lead.mailStreet ?? '').trim();
    const zip = String(lead.mailZip ?? '').trim();
    out.push({
      leadId: String(lead.id),
      propertyId: String(lead.propertyId),
      name: nameOf(lead),
      street,
      city: String(lead.mailCity ?? '').trim(),
      state: String(lead.mailState ?? 'NJ').trim(),
      zip,
      mailsElsewhere:
        street.toLowerCase() !== String(lead.addressStreet ?? '').trim().toLowerCase()
        || zip !== String(lead.addressZip ?? '').trim(),
      vars: letterVarsFor(lead),
    });
  }
  return { recipients: out, readiness: r };
}

export type MailReadiness = {
  cohort: string;
  total: number;
  ready: number;
  needsPerson: number;
  awaitingRating: number;
  rollNotRun: number;
  blocked: number;
  noAddress: number;
};

/**
 * Readiness per cohort — the four reasons a Grade A lead is not getting a letter.
 *
 * `awaiting_rating` is the one that did not previously exist anywhere on screen. Those
 * leads pass the roll check cleanly, so the Pipeline bar counts them as confirmed and the
 * review queue correctly ignores them: there is nothing for a person to adjudicate. They are
 * simply unpriced, which for a letter whose payload IS the price is as disqualifying as a
 * name mismatch. ~157 Grade A leads were in that state on 15 Oct and a screen that showed
 * them green was telling the truth about the wrong question.
 *
 * It is also not a review task. It belongs to a producer, who rates the home.
 */
export async function readiness(grade = 'A', cohort?: string): Promise<MailReadiness[]> {
  /**
   * Scoped to one week when the caller only asked about one.
   *
   * Whether a household has a band depends on carrier eligibility, which is a rule in code
   * rather than a column, so this reads leads instead of counting rows — and reading all 993
   * Grade A cards to answer a question about a cohort of 61 made the direct-mail screen take
   * six seconds and sit under a spinner. The screen asks for one week; the Pipeline asks for
   * all of them, and only it should pay for all of them.
   */
  const cohorts = cohort ? [cohort] : numberedCohorts();
  const rows = await sql`
    SELECT * FROM "Lead"
     WHERE COALESCE("manualGrade","grade") = ${grade}
       AND "cohort" = ANY(${cohorts})
     ORDER BY "cohort"` as Array<Record<string, any>>;

  const by = new Map<string, MailReadiness>();
  for (const lead of rows) {
    const cohort = String(lead.cohort);
    const r = by.get(cohort) ?? {
      cohort, total: 0, ready: 0, needsPerson: 0,
      awaitingRating: 0, rollNotRun: 0, blocked: 0, noAddress: 0,
    };
    r.total++;
    switch (mailStateOf(lead)) {
      case 'ready': r.ready++; break;
      case 'needs_person': r.needsPerson++; break;
      case 'awaiting_rating': r.awaitingRating++; break;
      case 'roll_not_run': r.rollNotRun++; break;
      case 'blocked': r.blocked++; break;
      case 'no_address': r.noAddress++; break;
    }
    by.set(cohort, r);
  }
  return [...by.values()].sort((a, b) => b.cohort.localeCompare(a.cohort));
}

export type TemplateCheck = {
  used: string[];
  /** Referenced but not a variable this channel can ever supply. */
  unknown: string[];
  /** A real letter variable that some households on the list do not have. */
  missingFor: Array<{ variable: string; propertyIds: string[] }>;
};

/**
 * Would every household on this list render this letter completely?
 *
 * Checked against the ACTUAL recipients rather than against a list of variable names,
 * because the only question worth answering is whether a specific person's letter comes out
 * whole. Lob's merge-variable strictness decides what happens to an unsupplied variable —
 * either the request errors or it renders as an empty string — and neither is something to
 * discover after 50 letters are in the post.
 */
export function checkTemplate(html: string, recipients: MailRecipient[]): TemplateCheck {
  const used = templateVars(html);
  const known = new Set<string>(LETTER_VARS);
  const unknown = used.filter((v) => !known.has(v));

  const missing = new Map<string, string[]>();
  for (const v of used) {
    if (!known.has(v)) continue;
    const without = recipients.filter((r) => !r.vars[v]).map((r) => r.propertyId);
    if (without.length) missing.set(v, without);
  }

  return {
    used,
    unknown,
    missingFor: [...missing.entries()].map(([variable, propertyIds]) => ({ variable, propertyIds })),
  };
}

/**
 * The space at the top of page one that belongs to the vendor, not to us.
 *
 * Lob prints the recipient address and a routing barcode over the top-left of the first
 * page, because that is what shows through the envelope window. Its documentation says to
 * "leave ample space" and publishes no measurement.
 *
 * Measured instead, from a rendered proof: the address block and barcode together end at
 * roughly 2.7in. A letter written with a 0.75in page padding had its address line, its
 * salutation and the first half of its opening paragraph printed underneath them —
 * unreadable, and invisible in any HTML preview, because the overlap only exists once the
 * vendor composes the page. 3.25in clears it with room to spare; re-rendered and confirmed.
 */
const ADDRESS_CLEARANCE = '3.25in';
const SIDE_MARGIN = '0.75in';

/**
 * Wrap a letter body in the page the vendor expects.
 *
 * The reserved area is applied by the system rather than left to whoever writes the letter.
 * It is invisible in the editor, impossible to verify without sending a real proof, and
 * catastrophic to forget — every letter in the batch prints with its opening obscured. A
 * rule that can only be checked after fifty letters are in the post is not a rule anybody
 * should be asked to remember.
 */
export function wrapLetter(bodyHtml: string): string {
  return `<div style="font-family: Georgia, serif; font-size: 11pt; line-height: 1.5; `
    + `padding: ${ADDRESS_CLEARANCE} ${SIDE_MARGIN} ${SIDE_MARGIN} ${SIDE_MARGIN};">`
    + `${bodyHtml}</div>`;
}

/** Substitute the variables for one recipient — used for the editor preview and the proof. */
export function renderLetter(html: string, vars: Record<string, string>): string {
  return String(html ?? '').replace(
    /\{\{\s*([a-zA-Z0-9_]+)\s*\}\}/g,
    (whole, name: string) => (vars[name] !== undefined ? vars[name] : whole),
  );
}
