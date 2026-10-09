import { sql } from '@/lib/neon';
import { cohortLabel, cohortEnd, cohortCode } from './cohort';
import { insuredEmails, coInsuredEmails } from './recipients.service';
import { deliverableAddresses, blockedAddresses } from './emailVerification.service';

/**
 * The Grade B cohort ledger.
 *
 * ── Why this is not the Grade A ledger with a filter ────────────────────────
 * That one measures GRADE RETENTION: Grade A at pull → downgraded → low point → regained →
 * Grade A now, against Frank's 5% loss target. Every column is about holding a grade.
 *
 * A Grade B lead is not being held at anything. It is out of appetite on a roof nobody has
 * confirmed, and the only question worth asking is whether we can reach it: is it in the
 * band Frank set, has it been traced, did the trace find an address, did the address verify.
 * Running Grade B through the retention columns would produce a table where "downgraded"
 * and "regained A" are permanently zero and the one number that matters is absent.
 *
 * So it is its own funnel, measured on the same renewal weeks so the two can be read side
 * by side.
 *
 *   in the cohort → in the roof band → queued → traced → has an address → verified → mailable
 *
 * ── Why "in the roof band" is a stage and not a filter ──────────────────────
 * Frank's criterion is homes 21 to 76 years old. A Grade B outside it is not a lead we are
 * choosing to skip — it is one no carrier will write, and the difference between "we have
 * not got to them" and "they are not eligible" is the whole point of a ledger.
 */

export type GradeBLedgerRow = {
  cohort: string;
  code: string | null;
  label: string;
  endsOn: string | null;
  /** Every Grade B lead renewing that week. */
  total: number;
  /** Of those, in Frank's 21–76 home-age band with an unconfirmed roof. */
  inBand: number;
  /** Waiting in the Grade B skip-trace queue. */
  queued: number;
  /** A blast has traced them. */
  traced: number;
  /** Holds an address for the insured — what a trace is for. */
  withEmail: number;
  /** Of those, an address ZeroBounce passed. */
  verified: number;
  /** Refused by the verifier: invalid, abuse, spamtrap, do_not_mail. */
  failed: number;
  /** Reachable at the insured and not refused — who a campaign could actually mail. */
  mailable: number;
  /** Nothing for the insured and nothing for the co-insured: the post, or nothing. */
  noContact: number;
  /*
   * ── The co-insured, counted rather than only consulted ───────────────────
   *
   * coInsuredEmails() was already read here, but only to decide noContact — the second
   * person could keep a lead out of 'no contact at all' and still have no number of
   * their own anywhere. The same blind spot the Grade A ledger had.
   *
   * Counted over every Grade B lead in the week, exactly like withEmail and verified
   * above, so the columns describe one population. Scoping these to the roof band alone
   * would put two different denominators in one row.
   */
  coWithEmail: number;
  coVerified: number;
  /** Confirmed for the co-insured and not the insured: the only confirmed way in. */
  coOnly: number;
};

export async function getGradeBLedger(params: {
  effFrom?: string;
  effTo?: string;
} = {}): Promise<GradeBLedgerRow[]> {
  const from = params.effFrom || null;
  const to = params.effTo || null;

  /**
   * Read the rows rather than aggregate in SQL.
   *
   * Reachability is decided by insuredEmails(), which walks the trace payload's per-person
   * attribution — a column test both misses addresses and credits the co-insured's to the
   * insured. That mismatch is what had two tabs of this CRM reporting 95 and 93 mailable for
   * the same week, and it is not worth reproducing here for a query that returns a few
   * thousand rows.
   */
  const leads = await sql`
    SELECT "id","cohort","yearBuilt","roofYear","propertyType","landUse",
           "blastQueuedAt","blastQueueGrade","blastSkipTracedAt","deepSkipTracedAt",
           "email1","email2","owner2Email","emailsAll","skipTraceData",
           "owner1FirstName","owner1LastName","owner2FirstName","owner2LastName"
      FROM "Lead"
     WHERE COALESCE("manualGrade","grade") = 'B'
       AND "cohort" IS NOT NULL
       AND (${from}::text IS NULL OR "cohort" >= ${from})
       AND (${to}::text   IS NULL OR "cohort" <= ${to})` as Array<Record<string, unknown>>;

  // Which of those are in the band, answered by the same SQL the roof report uses so the
  // two screens cannot disagree about who is eligible.
  const banded = await sql`
    SELECT "id" FROM "Lead"
     WHERE COALESCE("manualGrade","grade") = 'B'
       AND "cohort" IS NOT NULL
       AND (${from}::text IS NULL OR "cohort" >= ${from})
       AND (${to}::text   IS NULL OR "cohort" <= ${to})
       AND "roofYear" IS NULL
       AND ("propertyType" IS NULL OR "propertyType" <> 'CONDO')
       AND ("landUse" IS NULL OR "landUse" NOT ILIKE '%condo%')
       AND "yearBuilt" IS NOT NULL
       AND (EXTRACT(YEAR FROM NOW())::int - "yearBuilt") BETWEEN 21 AND 76` as Array<{ id: string }>;
  const inBand = new Set(banded.map((r) => String(r.id)));

  const [deliverable, blocked] = await Promise.all([deliverableAddresses(), blockedAddresses()]);
  const norm = (e: unknown) => String(e ?? '').trim().toLowerCase();

  const by = new Map<string, GradeBLedgerRow>();
  const row = (cohort: string): GradeBLedgerRow => {
    let r = by.get(cohort);
    if (!r) {
      r = {
        cohort,
        code: cohortCode(cohort),
        label: cohortLabel(cohort),
        endsOn: cohortEnd(cohort),
        total: 0, inBand: 0, queued: 0, traced: 0,
        withEmail: 0, verified: 0, failed: 0, mailable: 0, noContact: 0,
        coWithEmail: 0, coVerified: 0, coOnly: 0,
      };
      by.set(cohort, r);
    }
    return r;
  };

  for (const l of leads) {
    const r = row(String(l.cohort));
    r.total++;
    if (inBand.has(String(l.id))) r.inBand++;
    if (l.blastQueuedAt != null) r.queued++;
    if (l.blastSkipTracedAt != null || l.deepSkipTracedAt != null) r.traced++;

    const ins = insuredEmails(l).map(norm);
    const co = coInsuredEmails(l).map(norm);

    /*
     * Tallied BEFORE the insured branch below, which only runs when there is an insured
     * address. A lead whose only confirmed address belongs to the co-insured is exactly
     * what coOnly is for, and it would be skipped there.
     */
    const insConfirmed = ins.some((e) => deliverable.has(e));
    if (co.length) {
      r.coWithEmail++;
      if (co.some((e) => deliverable.has(e))) {
        r.coVerified++;
        if (!insConfirmed) r.coOnly++;
      }
    }

    if (ins.length) {
      r.withEmail++;
      if (insConfirmed) r.verified++;
      /**
       * Counted as failed only when EVERY insured address was refused. One bad address
       * beside a good one is not a lead we cannot mail — and reporting it as such would
       * make the verifier look like it was destroying reach it was actually protecting.
       */
      if (ins.every((e) => blocked.has(e))) r.failed++;
      // Mailable is the send list's own test: an address for the insured that is not refused.
      if (ins.some((e) => !blocked.has(e))) r.mailable++;
    } else if (!co.length) {
      r.noContact++;
    }
  }

  return [...by.values()].sort((a, b) => (a.cohort < b.cohort ? -1 : 1));
}
