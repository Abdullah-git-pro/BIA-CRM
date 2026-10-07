import { sql } from '@/lib/neon';
import { updateLead, addActivity, getLeadByPropertyId } from '@/services/storage.service';
import { runTracerfy } from './tracerfy.service';
import { runBatchData } from './batchData.service';
import { buildTraceUpdate, withPriorPersons, mergeContacts, coInsuredContactPatch } from './skipTraceApply.service';
import { insuredEmails, insuredPhones, coInsuredEmails, coInsuredPhones } from './recipients.service';
import { calculateLeadGrade } from './grade.service';
import { recordGradeChange } from './gradeHistory.service';
import { isRunFatal, VendorError } from './vendorErrors';
import { ownerEntityOf } from '@/lib/ownerEntity';
import { logRecapture } from './recapture.service';
import { startRun, finishRun } from './processRun.service';
import { cohortOf } from './cohort';

/**
 * The contact-recovery pipeline (Frank, 18 Sep 2026).
 *
 * An isolated lead — Grade A, quote-ready, no insured email — is worked through two
 * vendors in a fixed order, and each stage is a tab in QC → Blast Skip Traces:
 *
 *   isolated  ──Tracerfy──▶  recovered
 *        │
 *        └── no data ──▶  tracerfy  ──BatchData──▶  recovered
 *                              │
 *                              └── no data ──▶  batchdata   (exhausted)
 *
 * ── Why the stage is stored and not derived ─────────────────────────────────
 * It could be inferred from timestamps, but inference breaks as soon as a lead is traced
 * for some other reason, and these tabs are COUNTED on. A tab whose population is guessed
 * is a tab whose numbers get argued about, which is the entire history of this project.
 *
 * ── What counts as recovered ────────────────────────────────────────────────
 * An insured EMAIL. That is what isolation means and therefore what ends it — a lead that
 * gains only a phone is still unmailable and stays in the pipeline, though the phone is
 * kept and reported, because it is worth having and Ruben can call it.
 */

export type RecoveryStage = 'isolated' | 'tracerfy' | 'batchdata' | 'recovered';

export type StageCounts = {
  isolated: number;
  tracerfy: number;
  batchdata: number;
  recovered: number;
  /** Of the recovered, which vendor produced the address. */
  recoveredByTracerfy: number;
  recoveredByBatchData: number;
  /** Phones found on leads that are still unmailable — real value, not a recovery. */
  phoneOnly: number;
  /**
   * Leads that BELONG in this pipeline and are not in it yet: Grade A, quote-ready, no
   * insured email, never isolated.
   *
   * Without this the panel cannot tell "this week has no unreachable leads" apart from
   * "nobody has pressed Isolate for this week" — and it showed the same four zeros for
   * both. The 11/09 week had 47 leads waiting and read as though it had none, with the
   * only control that could enrol them sitting behind a chip on a different tab.
   */
  awaitingIsolation: number;
};

const RANGE_COLS = `"id","propertyId","status","grade","manualGrade","effectiveDate",
  "owner1FirstName","owner1LastName","owner2FirstName","owner2LastName",
  "addressStreet","addressCity","addressZip",
  "email1","email2","owner2Email","phone1","phone2","owner2Phone",
  "emailsAll","phonesAll","skipTraceData","owner1Dob",
  "isolatedFromStatus","recoveryStage","recoveredBy","recoveredEmail","recoveredPhone",
  "recoveryTracerfyAt","recoveryBatchDataAt","recoveredAt"`;

/**
 * Every lead in the pipeline for a date range, for ONE grade.
 *
 * Grade B joined this pipeline on 28 Sep. The stages, the vendor order and the definition
 * of recovered are identical — Frank asked for Grade B to be recorded the same way — but
 * the two are never counted together. A single "34 recovered" spanning both would hide
 * which population the work actually landed in, and they are worked for different reasons:
 * a Grade A recovery unblocks an account already priced and ready to send, a Grade B
 * recovery unblocks one with no band price at all.
 */
async function pipelineLeads(effFrom?: string, effTo?: string, grade: 'A' | 'B' = 'A'): Promise<any[]> {
  const from = effFrom || null;
  const to = effTo || null;
  const rows = await sql`
    SELECT "id","propertyId","status","grade","manualGrade","effectiveDate",
           "owner1FirstName","owner1LastName","owner2FirstName","owner2LastName",
           "addressStreet","addressCity","addressZip",
           "email1","email2","owner2Email","phone1","phone2","owner2Phone",
           "emailsAll","phonesAll","skipTraceData","owner1Dob",
           "isolatedFromStatus","recoveryStage","recoveredBy","recoveredEmail","recoveredPhone",
           "recoveryTracerfyAt","recoveryBatchDataAt","recoveredAt"
      FROM "Lead"
     WHERE "recoveryStage" IS NOT NULL
       AND COALESCE("manualGrade", "grade") = ${grade}
       AND (${from}::text IS NULL OR "effectiveDate" >= ${from})
       AND (${to}::text   IS NULL OR "effectiveDate" <= ${to})
     ORDER BY "effectiveDate", "owner1LastName"`;
  return rows as any[];
}

export async function stageCounts(effFrom?: string, effTo?: string, grade: 'A' | 'B' = 'A'): Promise<StageCounts> {
  const rows = await pipelineLeads(effFrom, effTo, grade);
  const at = (s: RecoveryStage) => rows.filter((r) => r.recoveryStage === s);
  const rec = at('recovered');

  // The same rule isolate.service uses, so the count here and the number the Isolate
  // action reports cannot differ. Reading the recipient columns rather than
  // "email1 IS NOT NULL": the insured's addresses are attributed per person inside the
  // trace payload, so the column test both misses addresses and credits the co-insured's
  // to the insured.
  const awaiting = await sql`
    SELECT "id","propertyId","status","grade","manualGrade","effectiveDate",
           "owner1FirstName","owner1LastName","owner2FirstName","owner2LastName",
           "email1","email2","owner2Email","phone1","phone2","owner2Phone",
           "emailsAll","skipTraceData"
      FROM "Lead"
     WHERE COALESCE("manualGrade", "grade") = ${grade}
       AND "isolatedAt" IS NULL
       AND "recoveryStage" IS NULL
       AND (${effFrom ?? null}::text IS NULL OR "effectiveDate" >= ${effFrom ?? null})
       AND (${effTo ?? null}::text   IS NULL OR "effectiveDate" <= ${effTo ?? null})` as Record<string, unknown>[];

  return {
    isolated: at('isolated').length,
    tracerfy: at('tracerfy').length,
    batchdata: at('batchdata').length,
    recovered: rec.length,
    recoveredByTracerfy: rec.filter((r) => r.recoveredBy === 'tracerfy').length,
    recoveredByBatchData: rec.filter((r) => r.recoveredBy === 'batchdata').length,
    // Counted across the still-unrecovered stages: a phone we did not have before.
    phoneOnly: rows.filter((r) => r.recoveryStage !== 'recovered' && r.recoveredPhone === true).length,
    awaitingIsolation: awaiting.filter((l) => insuredEmails(l).length === 0).length,
  };
}

export type PipelineRow = {
  id: string;
  owner: string;
  /** Street line — city and ZIP do not identify a property. */
  address: string | null;
  city: string | null;
  zip: string | null;
  effectiveDate: string | null;
  grade: string | null;
  status: string | null;
  stage: RecoveryStage;
  /** The thing isolation is about — an address the campaign can actually mail. */
  hasEmail: boolean;
  hasPhone: boolean;
  triedTracerfyAt: string | null;
  triedBatchDataAt: string | null;
  recoveredBy: string | null;
  /**
   * Set when the owner of record is a trust, company or municipality (Frank Sep-2026).
   * These sit at their stage and are never sent to a vendor — there is no named person
   * to look up — so the pipeline reports them rather than quietly never draining them.
   */
  entity: { label: string; matched: string } | null;
  /**
   * No insured first AND last name on file, so no person-level trace is possible.
   *
   * ── Why this is its own flag and not folded into `entity` ───────────────────
   * Both end the same way — the lead cannot go to a vendor, so it is held back rather
   * than queued — but they are not the same fact. A trust IS the owner of record; a
   * blank name is a HOLE in our data, usually a new-build where the deed has not caught
   * up. Four of these sit on one street in Howell. Filing them as "trust or company
   * owned" would state something untrue about the property and bury a data problem we
   * could actually fix by re-pulling the record.
   *
   * Tracerfy refuses them outright — "Skip trace needs the insured first + last name on
   * file" — and three refusals in a row stop the whole run, so 97 perfectly traceable
   * leads in the same batch went unattempted because of them.
   */
  noName: boolean;
};

export async function leadsAtStage(
  stage: RecoveryStage, effFrom?: string, effTo?: string, grade: 'A' | 'B' = 'A',
): Promise<PipelineRow[]> {
  const rows = await pipelineLeads(effFrom, effTo, grade);
  /**
   * These columns come back in two shapes: effectiveDate is TEXT ('2026-10-05') while the
   * trace timestamps are real Dates. Slicing String(date) yields 'Tue Aug 25' — wrong, and
   * unsortable. Read the local parts instead; the timestamps are "without time zone", so
   * toISOString would re-interpret them as UTC and shift an evening run to the next day.
   */
  const iso = (d: any): string | null => {
    if (!d) return null;
    if (d instanceof Date) {
      if (Number.isNaN(d.getTime())) return null;
      const pad = (n: number) => String(n).padStart(2, '0');
      return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
    }
    const s = String(d);
    if (/^\d{4}-\d{2}-\d{2}/.test(s)) return s.slice(0, 10);
    const parsed = new Date(s);
    return Number.isNaN(parsed.getTime()) ? null : iso(parsed);
  };
  return rows
    .filter((r) => r.recoveryStage === stage)
    .map((r) => ({
      id: r.id,
      owner: `${r.owner1FirstName ?? ''} ${r.owner1LastName ?? ''}`.trim(),
      address: r.addressStreet,
      city: r.addressCity,
      zip: r.addressZip,
      effectiveDate: iso(r.effectiveDate),
      grade: r.manualGrade || r.grade,
      status: r.status,
      stage,
      hasEmail: insuredEmails(r).length > 0,
      hasPhone: insuredPhones(r).length > 0,
      triedTracerfyAt: iso(r.recoveryTracerfyAt),
      triedBatchDataAt: iso(r.recoveryBatchDataAt),
      recoveredBy: r.recoveredBy ?? null,
      entity: (() => {
        const e = ownerEntityOf(r as any);
        return e ? { label: e.label, matched: e.matched } : null;
      })(),
      // Both names, not either: Tracerfy's enhanced lookup takes first AND last.
      noName: !String(r.owner1FirstName ?? '').trim() || !String(r.owner1LastName ?? '').trim(),
    }));
}

export type BlastResult = {
  /**
   * Recaptures whose cohort had already been frozen, so they did NOT join it (fix 19).
   *
   * Surfaced on the blast's own result because that is the screen somebody is looking at
   * when it happens. "Twelve recovered" and "twelve recovered, nine of which cannot be
   * mailed this cycle" are very different reports, and the first one reads as a good day.
   */
  heldFromFrozenCohort: number;
  vendor: 'tracerfy' | 'batchdata';
  dryRun: boolean;
  /** How many sit at this stage in the range. */
  pool: number;
  attempted: number;
  /** Vendor returned something for the property. */
  matched: number;
  /** Gained an insured EMAIL — the only thing that ends isolation. */
  recovered: number;
  /** Gained a phone but still no email; stays in the pipeline. */
  phoneOnly: number;
  /** Found nothing; moved to the next stage. */
  movedOn: number;
  regraded: number;
  /** Advanced without calling the vendor because it had already run on them. */
  skippedAlreadyTraced: number;
  /**
   * Held back because the owner is a trust, company or municipality. NOT included in
   * `pool` — the pool is what this run could actually work on, and quoting a figure the
   * blast will never touch is how a queue looks stuck for no stated reason.
   */
  entityOwned: number;
  /**
   * Held back because no insured first + last name is on file, so no person-level trace
   * is possible. Also NOT in `pool`, for the same reason entityOwned is not.
   */
  noName: number;
  errors: { id: string; error: string }[];
  /**
   * Set when the run ended itself instead of finishing the pool — out of credits, a bad
   * key, or a vendor that failed on every lead in a row. The leads it never reached are
   * untouched and still at their stage, so the same button picks up where this left off.
   */
  stopped?: {
    reason: 'no_credits' | 'auth' | 'vendor_error';
    vendor: string;
    /** The vendor's own words. */
    detail: string;
    /** How many of the pool were never attempted because of the stop. */
    remaining: number;
  };
};

/**
 * Apply one vendor's answer and move the lead to wherever it now belongs.
 *
 * Both blasts share this so the two tabs cannot drift into behaving differently — the
 * failure mode that put full contact lists on one trace path and dropped them on the
 * other.
 */
async function applyAndAdvance(
  lead: any,
  vendor: 'tracerfy' | 'batchdata',
  found: { emails: string[]; phones: string[]; matched: boolean; raw?: unknown; persons?: any[]; ownerName?: string | null; insuredPatch?: Record<string, any>; ownerVerified?: boolean },
  createdBy: string | null,
  out: BlastResult,
): Promise<void> {
  const now = new Date();
  const stamp = vendor === 'tracerfy'
    ? { recoveryTracerfyAt: now }
    : { recoveryBatchDataAt: now };

  let update: Record<string, any>;
  if (vendor === 'tracerfy') {
    update = buildTraceUpdate(lead, found as any, now);
  } else {
    /**
     * Only a VERIFIED person's details go in the insured's own fields.
     *
     * BatchData resolves one person from a property and that person is not always ours:
     * a lead owned by Narayan Sreejith came back as "Valerie Pinnola", and because this
     * branch wrote email1 unconditionally, capinnola@yahoo.com became the insured's
     * primary address. The lead then counted as recovered and mailable, and the campaign
     * would have emailed a stranger under the insured's name — the precise failure the
     * "This is not my property" button exists to catch after the fact.
     *
     * runBatchData already compares the response's own property-owner block to our
     * owner1 and reports ownerVerified. That answer was computed and thrown away here.
     *
     * Unverified results are still KEPT — in emailsAll/phonesAll and the payload, so
     * nothing is lost and a producer can see them — they are simply not claimed as the
     * insured's. insuredEmails() reads the numbered slots and name-matched people, so an
     * unverified lead correctly stays unreachable rather than counting as recovered.
     */
    const verified = found.ownerVerified === true;
    update = {
      skipTraced: true,
      skipTracedAt: now,
      deepSkipTracedAt: now,
      skipTraceData: withPriorPersons(
        { provider: 'batchdata', persons: found.persons ?? [], ownerVerified: verified, raw: found.raw },
        lead.skipTraceData,
      ),
      skipTraceOwnerName: found.ownerName ?? null,
    };
    if (verified) {
      if (found.phones[0] && !lead.phone1) update.phone1 = found.phones[0];
      if (found.phones[1] && !lead.phone2) update.phone2 = found.phones[1];
      if (found.emails[0] && !lead.email1) update.email1 = found.emails[0];
      if (found.emails[1] && !lead.email2) update.email2 = found.emails[1];
      Object.assign(update, found.insuredPatch ?? {});
    }
    // Held either way — the data is real, it just may not be this insured's.
    if (found.emails.length) update.emailsAll = mergeContacts(found.emails, lead.emailsAll);
    if (found.phones.length) update.phonesAll = mergeContacts(found.phones, lead.phonesAll);
  }
  Object.assign(update, stamp);

  // The transition — stage, recovery stamps, regrade, recapture, activity — is shared with
  // the skip-trace blast so both paths record a recovery the same way.
  await advanceAfterTrace({
    before: lead,
    after: { ...lead, ...update },
    update,
    found: { emails: found.emails, phones: found.phones, matched: found.matched },
    vendor,
    createdBy,
    out,
    now,
  });
}

/**
 * ── Where a lead goes after a trace, decided and written in ONE place ───────
 *
 * This used to live inside applyAndAdvance, which only the pipeline's own runner calls.
 * The skip-trace blast traces leads through a different path (traceAndApply) and therefore
 * never advanced anything — so a lead the blast had traced, charged for and stamped
 * blastSkipTracedAt still sat at stage 'isolated', and the pipeline panel reported it as
 * "Not traced yet" two inches below a queue card saying "1 already traced".
 *
 * Two places deciding the same fact and disagreeing is the defect this project keeps
 * paying for. There is now one.
 *
 * ── The arguments, and why before and after are both required ───────────────
 * `before` is the lead as it was when the vendor was called; `after` is the lead as it will
 * be once `update` is written. The pipeline has not written yet, so it passes its pending
 * delta as `update` and a merged object as `after`. The blast has already written through
 * traceAndApply, so it passes the re-read lead as `after` and an empty `update`.
 *
 * Both are needed because "gained a phone" is a comparison, not a state: a lead that
 * already had a phone has not recovered one, and reading only `after` would count every
 * lead that has ever had a number.
 */
export async function advanceAfterTrace(opts: {
  before: any;
  after: any;
  /** Pending changes to write with the transition. Empty when the caller already wrote. */
  update: Record<string, any>;
  found: { emails: string[]; phones: string[]; matched: boolean };
  vendor: 'tracerfy' | 'batchdata';
  createdBy: string | null;
  out: BlastResult;
  now: Date;
}): Promise<void> {
  const { before: lead, after: incomingAfter, update, found, vendor, createdBy, out, now } = opts;
  // Decide on the lead AS IT WILL BE, not as it was.
  const after = incomingAfter;
  // The co-insured's address belongs in the co-insured's field, not only in a list.
  Object.assign(update, coInsuredContactPatch(after, coInsuredEmails(after), coInsuredPhones(after)));
  const gotEmail = insuredEmails(after).length > 0;
  const gotPhone = insuredPhones(after).length > 0 && insuredPhones(lead).length === 0;
  if (gotPhone) update.recoveredPhone = true;

  if (gotEmail) {
    /**
     * Back in play.
     *
     * A status is only put back if isolation took one away. Leads isolated before 23 Sep
     * 2026 had theirs overwritten with 'isolated', and isolatedFromStatus is the only
     * record of what they were; leads isolated since keep their status throughout, so
     * writing the old value over the top would undo anything done while they were parked.
     *
     * Where it does apply, it returns to what the lead held BEFORE isolation rather than a
     * blanket 'new' — a rated lead gets an indicative price in the second email and an
     * unrated one cannot, so resetting them all would change which copy they receive.
     */
    const legacyIsolation = lead.status === 'isolated';
    const back = lead.isolatedFromStatus || 'new';
    Object.assign(update, {
      ...(legacyIsolation ? { status: back } : {}),
      isolatedAt: null,
      isolatedFromStatus: null,
      isolatedReason: null,
      recoveryStage: 'recovered',
      recoveredAt: now,
      recoveredBy: vendor,
      recoveredEmail: true,
    });

    // Re-grade by the rules rather than forcing A. These leads are Grade A already —
    // that is what isolation selects for — so this confirms it; and if a rule now says
    // otherwise, the rules win. Asserting A regardless would make the grade a label
    // instead of a result.
    const computed = calculateLeadGrade(after as any);
    if (!lead.manualGrade && computed !== lead.grade) {
      update.grade = computed;
      out.regraded++;
    }
    const finalGrade = update.grade ?? lead.manualGrade ?? lead.grade;

    await updateLead(lead.propertyId ?? lead.id, update);

    /**
     * ── The recapture event (Frank, fixes 17, 19, 22) ──────────────────────
     *
     * Written here, at the moment it happens, because two of the facts it records stop
     * being true immediately afterwards: what the account read as before it came back, and
     * whether its cohort had already been frozen. Both are unrecoverable a day later — the
     * Lead columns will have moved on and the send list may have been rebuilt.
     *
     * It never blocks the recovery. A lead that came back and failed to log is a reporting
     * gap; a lead that came back and was then rolled back because the log failed is a lead
     * nobody can mail.
     */
    const recapture = await logRecapture({
      leadId: lead.id,
      propertyId: lead.propertyId ?? null,
      cohort: lead.cohort ?? null,
      process: vendor,
      priorStatus: lead.status ?? null,
      priorGrade: lead.grade ?? null,
      newGrade: finalGrade ?? null,
      note: `${found.emails.length} email(s), ${found.phones.length} phone(s) recovered`,
    }).catch(() => ({ logged: false, held: false }));
    if (recapture.held) out.heldFromFrozenCohort++;

    if (update.grade) {
      await recordGradeChange({
        leadId: lead.id,
        fromGrade: lead.grade ?? null,
        toGrade: update.grade,
        source: 'system',
        reason: `Contact recovered via ${vendor === 'tracerfy' ? 'Tracerfy' : 'BatchData'}`,
        changedBy: `system: recovery (${vendor})`,
        at: now,
      }).catch(() => {});
    }

    await addActivity(
      lead.id,
      'status_change',
      `After ${vendor === 'tracerfy' ? 'Tracerfy' : 'BatchData'} skip trace — Lead Grade ${finalGrade}, `
        + `no longer isolated`
        + (legacyIsolation ? ` (status restored to ${back})` : ` (status unchanged)`)
        + ` — ${found.emails.length} email(s), ${found.phones.length} phone(s) recovered`
        // Said on the record, not left for somebody to work out from a tab.
        + (recapture.held
          ? ` — held from cohort ${lead.cohort}: its send list was already built`
          : ''),
      {
        changes: [{ field: 'Isolated', from: 'yes', to: 'no' }],
        recovery: { vendor, stage: 'recovered' },
        emails: found.emails,
        phones: found.phones,
        grade: finalGrade,
      },
      createdBy ? `recovery · ${createdBy}` : `recovery (${vendor})`,
    );
    out.recovered++;
    return;
  }

  // Nothing mailable. Move to the next stage and say what was tried.
  const nextStage: RecoveryStage = vendor === 'tracerfy' ? 'tracerfy' : 'batchdata';
  update.recoveryStage = nextStage;
  await updateLead(lead.propertyId ?? lead.id, update);

  await addActivity(
    lead.id,
    'skip_trace',
    `${vendor === 'tracerfy' ? 'Tracerfy' : 'BatchData'} recovery attempt — `
      + (found.matched
        ? `${found.phones.length} phone(s), no insured email`
        : 'no match')
      + (nextStage === 'batchdata' ? ' · both tools exhausted' : ' · moving to BatchData'),
    { recovery: { vendor, stage: nextStage }, emails: found.emails, phones: found.phones },
    createdBy ? `recovery · ${createdBy}` : `recovery (${vendor})`,
  );
  if (gotPhone) out.phoneOnly++;
  out.movedOn++;
}

async function runBlast(
  vendor: 'tracerfy' | 'batchdata',
  opts: {
    effFrom?: string; effTo?: string; limit?: number; dryRun?: boolean; createdBy?: string | null;
    /**
     * Which pipeline to run. Defaults to A, which is all this used to do.
     *
     * ── Why it was wrong without this ────────────────────────────────────────
     * The screen's GET already passed a grade and drew the Grade B pipeline — 628 leads
     * waiting at the Tracerfy stage. The POST did not, so the blast read the Grade A
     * stage, found it empty, and reported "tried 0, matched 0, recovered 0". The button
     * appeared to do nothing because it was working on a different pipeline from the one
     * on screen.
     *
     * Same fault as the Isolate button one panel up, fixed the same day.
     */
    grade?: 'A' | 'B';
  },
): Promise<BlastResult> {
  const { effFrom, effTo, limit = 25, dryRun = true, createdBy = null, grade = 'A' } = opts;
  const fromStage: RecoveryStage = vendor === 'tracerfy' ? 'isolated' : 'tracerfy';

  const stageRows = await leadsAtStage(fromStage, effFrom, effTo, grade);

  /**
   * Entity-owned leads never go to a vendor (Frank Sep-2026).
   *
   * Split BEFORE the limit is applied, not inside the loop. Filtering later would let a
   * run of 100 spend its whole allowance skipping trusts and never reach the people
   * behind them — the pool is ordered, so a cluster of trusts at the front would stall
   * the pipeline while reporting a successful run.
   *
   * They keep their stage rather than being advanced. Advancing them would claim a
   * vendor had been asked and found nothing, which is not what happened; the honest
   * statement is that we never asked, and `entityOwned` below is how the tab says so
   * instead of leaving a queue that mysteriously never drains.
   */
  const entityOwned = stageRows.filter((r) => r.entity !== null);
  /**
   * Leads with no name on file are held back for the same reason and at the same point.
   *
   * Tracerfy rejects them — "Skip trace needs the insured first + last name on file" —
   * and the run's three-strikes guard counts those refusals as vendor failures. On the
   * first real Grade B run that stopped the batch after three of them and left 97
   * traceable leads unattempted. Splitting them out before the limit, exactly as the
   * trusts are, means a cluster of nameless records can neither consume the allowance
   * nor halt the run.
   *
   * Counted after entityOwned so a lead that is both is reported once, as the trust it is.
   */
  const noName = stageRows.filter((r) => r.entity === null && r.noName);
  const pool = stageRows.filter((r) => r.entity === null && !r.noName);

  const out: BlastResult = {
    vendor, dryRun, pool: pool.length,
    attempted: 0, matched: 0, recovered: 0, phoneOnly: 0, movedOn: 0, regraded: 0,
    skippedAlreadyTraced: 0, entityOwned: entityOwned.length, noName: noName.length,
    heldFromFrozenCohort: 0, errors: [],
  };
  if (dryRun) return out;

  const batch = pool.slice(0, limit);

  /**
   * ── The run log (Frank, fix 20) ──────────────────────────────────────────
   *
   * Opened here, before the first vendor call. Three separate reasons it cannot wait until
   * the run ends:
   *
   *   - A run that finds nothing writes no Activity rows at all, so by any after-the-fact
   *     method it leaves no trace. "We traced that week and got nothing" would keep reading
   *     as "nobody has ever traced it" — which is how 11/09 sat untouched with 47 waiting.
   *   - The pool size is only known here. Three recoveries out of a pool of 47 and three
   *     out of a pool of three leave identical per-lead history and mean opposite things.
   *   - A run that dies mid-call still has to be visible, and that is the moment somebody
   *     actually asks what is happening.
   *
   * A run that crashes outright is never closed and stays at 'running'. That is deliberate
   * rather than unhandled: stalledRuns() is what surfaces it, and a row that says it is
   * still going is a truer account of a crash than one that claims to know why it stopped.
   */
  const runId = await startRun({
    process: vendor === 'tracerfy' ? 'tracerfy_blast' : 'batchdata_blast',
    cohortFrom: effFrom ?? null,
    cohortTo: effTo ?? null,
    considered: pool.length,
    runBy: createdBy,
    dryRun: false,
    detail: { limit, entityOwned: entityOwned.length, noName: noName.length, batch: batch.length },
  });

  /**
   * A vendor that is simply down looks like a per-lead failure over and over. Three in a
   * row is no longer a coincidence, and there is nothing to learn from the fourth.
   */
  const MAX_CONSECUTIVE_FAILURES = 3;
  let consecutiveFailures = 0;

  for (const [i, row] of batch.entries()) {
    const lead = await getLeadByPropertyId(row.id) as any;
    if (!lead) continue;

    /**
     * Re-checked on the freshly read lead, not just on the row from the pool.
     *
     * The re-read above exists because the lead may have changed since the pool was
     * built — and the owner name is one of the things that changes, when a property
     * transfers into a trust. This costs one regex and is the last point before a charge.
     */
    if (ownerEntityOf(lead)) { out.entityOwned++; continue; }

    /*
     * Re-checked here for the same reason the entity test is: the lead is read fresh
     * inside the loop, and this is the last point before a charge. A name that has gone
     * missing since the pool was built would otherwise be sent to a vendor that cannot
     * use it — and the refusal counts toward the three-in-a-row stop.
     */
    if (!String(lead.owner1FirstName ?? '').trim() || !String(lead.owner1LastName ?? '').trim()) {
      out.noName++;
      continue;
    }

    /**
     * Never pay a vendor to answer a question it has already answered.
     *
     * Belt and braces behind the enrolment rule: if a lead reaches the Tracerfy stage
     * already carrying a deep trace, it is advanced for free rather than re-run. Asking
     * the same vendor about the same address costs 15 credits on a match and returns what
     * it returned last time — which is why this lead was isolated in the first place.
     *
     * A producer can still deliberately re-run one from the card; that is a considered
     * choice about a single lead, not a blast.
     */
    if (vendor === 'tracerfy' && lead.deepSkipTracedAt) {
      await updateLead(lead.propertyId ?? lead.id, {
        recoveryStage: 'tracerfy',
        recoveryTracerfyAt: lead.deepSkipTracedAt,
      });
      out.skippedAlreadyTraced++;
      out.movedOn++;
      continue;
    }

    out.attempted++;
    try {
      if (vendor === 'tracerfy') {
        const r = await runTracerfy(lead);
        if (r.matched) out.matched++;
        await applyAndAdvance(lead, 'tracerfy', r as any, createdBy, out);
      } else {
        const r = await runBatchData(lead);
        if (r.matched) out.matched++;
        await applyAndAdvance(lead, 'batchdata', r as any, createdBy, out);
      }
    } catch (err: any) {
      out.errors.push({ id: row.id, error: err?.message ?? `${vendor} call failed` });

      /**
       * Out of credits or a rejected key: every remaining lead would fail the same way,
       * and each attempt that DOES somehow bill is money spent on nothing. Stop here and
       * say so. The Tracerfy blast once made ~290 pointless calls after the account ran
       * dry because it carried on regardless.
       *
       * The leads below this point are untouched — still at this stage, still in the tab,
       * still counted — so topping up and pressing the same button resumes the run rather
       * than restarting it.
       */
      if (isRunFatal(err)) {
        const e = err as VendorError;
        out.stopped = {
          reason: e.fault === 'auth' ? 'auth' : 'no_credits',
          vendor: e.vendor,
          detail: e.detail,
          remaining: batch.length - i - 1,
        };
        break;
      }

      // Anything else is this lead's problem until it happens three times running, at
      // which point it is the vendor's.
      if (++consecutiveFailures >= MAX_CONSECUTIVE_FAILURES) {
        out.stopped = {
          reason: 'vendor_error',
          vendor: vendor === 'tracerfy' ? 'Tracerfy' : 'BatchData',
          detail: err?.message ?? 'three calls in a row failed',
          remaining: batch.length - i - 1,
        };
        break;
      }
      continue;
    }
    consecutiveFailures = 0;
  }

  /**
   * Closed with the counts as they actually ended up, including a run cut short by
   * out.stopped — which is 'aborted', not 'ok'. A run that ran out of vendor credits after
   * nine leads and reported success would agree with itself and disagree with the bill.
   */
  await finishRun(runId, {
    outcome: out.stopped ? 'aborted' : 'ok',
    touched: out.attempted,
    changed: out.recovered,
    byCohort: byCohortCounts(batch),
    detail: {
      matched: out.matched,
      phoneOnly: out.phoneOnly,
      movedOn: out.movedOn,
      regraded: out.regraded,
      skippedAlreadyTraced: out.skippedAlreadyTraced,
      entityOwned: out.entityOwned,
      heldFromFrozenCohort: out.heldFromFrozenCohort,
      errors: out.errors.length,
      stopped: out.stopped ?? null,
    },
    error: out.stopped ? `${out.stopped.reason}: ${out.stopped.detail ?? ''}` : null,
  });

  return out;
}

/**
 * The per-week split Frank asked for alongside the count.
 *
 * Taken from the batch's own rows, so it describes the leads this run actually reached
 * rather than everything that qualified. A total across seven weeks cannot answer which
 * week is behind, which is the only question the number gets asked.
 *
 * Keyed on the COHORT, not the renewal date. The renewal dates inside one week are all
 * different, so keying on them would produce a hundred buckets of one and nothing that
 * lines up with anything Frank reads.
 */
function byCohortCounts(batch: PipelineRow[]): Record<string, number> {
  const n: Record<string, number> = {};
  for (const r of batch) {
    const c = cohortOf(r.effectiveDate) ?? 'unknown';
    n[c] = (n[c] ?? 0) + 1;
  }
  return n;
}

export const runTracerfyBlast = (o: Parameters<typeof runBlast>[1]) => runBlast('tracerfy', o);
export const runBatchDataBlast = (o: Parameters<typeof runBlast>[1]) => runBlast('batchdata', o);
