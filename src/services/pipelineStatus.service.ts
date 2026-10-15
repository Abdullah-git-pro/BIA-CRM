import { sql } from '@/lib/neon';
import { cohortLabel, cohortEnd, cohortCode, numberedCohorts } from './cohort';

/**
 * Where each cohort has got to in the three-phase pipeline (Frank, 13 Oct 2026).
 *
 *     REAPI (the cohort pull) → WIIP (the tax roll) → skip trace
 *
 * ── Why this screen exists ──────────────────────────────────────────────────
 * The cadence was settled in the 13 Oct meeting: the roll is consulted BEFORE the trace, so
 * the trace is run against a name somebody has checked. Frank's condition was that he can
 * see where a batch is without asking — "before we do a mass whip, we need to understand how
 * this functionality is now working". A pipeline nobody can watch is one he has to take on
 * trust, and he has said twice that he will not.
 *
 * ── The number this screen exists to show ───────────────────────────────────
 * `tracedBeforeRoll` counts leads that were skip traced while ownerVerifyAt was still null —
 * traced on the REAPI name, unchecked, under the old order. 300 Grade A and 1,179 leads
 * overall are in that state. They are not "done": they are done the way that produced the
 * flipped-name card Frank brought to the meeting, and no completion bar should imply
 * otherwise.
 *
 * ── Read-only, and deliberately so ──────────────────────────────────────────
 * Nothing here starts work. Running the roll over a cohort spends somebody's goodwill and
 * running traces spends credits, and the rule set on 13 Oct is that neither happens without
 * explicit permission. This module answers "where is it"; acting is a separate, deliberate
 * POST that a person makes.
 */

/** The phase a cohort is in, decided by what has actually been done to its leads. */
export type PipelinePhase = 'pulled' | 'roll' | 'tracing' | 'complete';

export type PipelineCohort = {
  cohort: string;
  code: string | null;
  label: string;
  endsOn: string | null;
  grade: string;
  phase: PipelinePhase;
  /** Leads in the cohort at this grade — the denominator for everything below. */
  total: number;

  /** ── Phase 2: the tax roll ─────────────────────────────────────────── */
  rollChecked: number;
  rollMatch: number;
  rollPartial: number;
  rollMismatch: number;
  rollNotFound: number;
  rollAmbiguous: number;
  /** Checked, and the roll could not settle it: a person has to look. */
  rollNeedsReview: number;

  /** The second owner, as the roll reports them. */
  coMatch: number;
  coNoneOnRoll: number;
  coNeedsReview: number;

  /** ── Phase 3: the skip trace ───────────────────────────────────────── */
  traced: number;
  /**
   * Traced while the roll had never been consulted — the old cadence.
   *
   * Counted apart from `traced` because it is the opposite of progress: these cards were
   * searched for using a name nobody had checked, which is the defect the new order exists
   * to prevent. Folding them into "traced" would show a full bar over the exact population
   * most likely to be wrong.
   */
  tracedBeforeRoll: number;

  /** ── Phase 4: the contact check ────────────────────────────────────── */
  /**
   * Cards carrying at least one identity verdict, and cards carrying at least one number
   * the provider says is NOT the insured's.
   *
   * Counted as CARDS, not as contact points, and with no denominator — on purpose. How many
   * numbers a card holds is a per-person attribution that has to be walked lead by lead
   * (numbersOnCard), and putting that walk inside the cohort list would turn one query into
   * a thousand-row read on every page load. The exact remaining count is what the button's
   * dry run answers, in front of the person who is about to spend the money.
   */
  contactsCards: number;
  contactsNotTheirs: number;
};

const REVIEW_STATUSES = ['partial', 'mismatch', 'ambiguous', 'unknown'];

export async function getPipelineStatus(params: {
  grade?: string;
  effFrom?: string;
  effTo?: string;
} = {}): Promise<PipelineCohort[]> {
  const grade = params.grade || 'A';
  const from = params.effFrom || null;
  const to = params.effTo || null;

  /**
   * Aggregated in SQL rather than by reading rows.
   *
   * Every column here is a count of CARDS keyed off a timestamp or a status the lead
   * already carries — there is no per-person attribution to walk, which is the thing that
   * forces the ledgers to read rows. A cohort list is a handful of counters and should
   * cost one query, not 1,800 rows pulled across the wire to be tallied in JavaScript.
   */
  const rows = await sql`
    SELECT "cohort",
           COUNT(*)::int AS total,
           COUNT(*) FILTER (WHERE "ownerVerifyAt" IS NOT NULL)::int AS roll_checked,
           COUNT(*) FILTER (WHERE "ownerVerifyStatus" = 'match')::int      AS roll_match,
           COUNT(*) FILTER (WHERE "ownerVerifyStatus" = 'partial')::int    AS roll_partial,
           COUNT(*) FILTER (WHERE "ownerVerifyStatus" = 'mismatch')::int   AS roll_mismatch,
           COUNT(*) FILTER (WHERE "ownerVerifyStatus" = 'not_found')::int  AS roll_not_found,
           COUNT(*) FILTER (WHERE "ownerVerifyStatus" = 'ambiguous')::int  AS roll_ambiguous,
           COUNT(*) FILTER (WHERE "ownerVerifyStatus" = ANY(${REVIEW_STATUSES}))::int AS roll_needs_review,
           COUNT(*) FILTER (WHERE "coInsuredVerifyStatus" = 'match')::int        AS co_match,
           COUNT(*) FILTER (WHERE "coInsuredVerifyStatus" = 'none_on_roll')::int AS co_none,
           COUNT(*) FILTER (WHERE "coInsuredVerifyStatus" = ANY(${REVIEW_STATUSES}))::int AS co_needs_review,
           COUNT(*) FILTER (WHERE "skipTracedAt" IS NOT NULL
                               OR "blastSkipTracedAt" IS NOT NULL
                               OR "deepSkipTracedAt" IS NOT NULL)::int AS traced,
           COUNT(*) FILTER (WHERE ("skipTracedAt" IS NOT NULL
                                OR "blastSkipTracedAt" IS NOT NULL
                                OR "deepSkipTracedAt" IS NOT NULL)
                              AND "ownerVerifyAt" IS NULL)::int AS traced_before_roll
      FROM "Lead"
     WHERE COALESCE("manualGrade","grade") = ${grade}
       AND "cohort" IS NOT NULL
       /**
        * The numbered waves only — C1 through C8, nothing either side.
        *
        * The book holds renewal weeks from before the programme started (April–September
        * 2026) and at least one far beyond it (24 May 2027). Left in, the early ones were
        * summed into the totals — "leads in the book" read 1,829 against a numbered
        * programme of 994, the same mixed-population error the ledgers were fixed for — and
        * the late one rendered as "C34" beside C8, which reads as a bug on a screen whose
        * whole job is to be trusted.
        *
        * Matched against numberedCohorts() rather than a date range, so the set follows
        * COHORT_COUNT: when a wave is added, this follows it without being edited. Note a
        * lead outside these weeks is not deleted or hidden from the CRM — it is simply not
        * part of the sequence this screen reports on.
        */
       AND "cohort" = ANY(${numberedCohorts()})
       AND (${from}::text IS NULL OR "cohort" >= ${from})
       AND (${to}::text   IS NULL OR "cohort" <= ${to})
     GROUP BY "cohort"
     ORDER BY "cohort" DESC` as Array<Record<string, unknown>>;

  /**
   * The contact check, asked separately rather than joined into the aggregate above.
   *
   * A card holds up to 24 numbers, so joining the verdict table into the Lead aggregate
   * would multiply every other counter by the number of verdicts and quietly inflate the
   * whole row — the same shape of error that made the campaign ledger count a send once per
   * recipient. Two small queries merged by cohort cannot do that.
   */
  const contactRows = await sql`
    SELECT l."cohort",
           COUNT(DISTINCT v."leadId")::int AS cards,
           COUNT(DISTINCT v."leadId") FILTER (
             WHERE v."channel" = 'phone' AND v."nameMatch" IS FALSE
           )::int AS not_theirs
      FROM "ContactVerification" v
      JOIN "Lead" l ON l."id" = v."leadId"
     WHERE COALESCE(l."manualGrade", l."grade") = ${grade}
       AND l."cohort" = ANY(${numberedCohorts()})
     GROUP BY l."cohort"` as Array<Record<string, unknown>>;

  const contactsBy = new Map(
    contactRows.map((r) => [String(r.cohort), { cards: Number(r.cards ?? 0), notTheirs: Number(r.not_theirs ?? 0) }]),
  );

  const n = (v: unknown) => Number(v ?? 0);

  return rows.map((r) => {
    const total = n(r.total);
    const rollChecked = n(r.roll_checked);
    const traced = n(r.traced);
    const tracedBeforeRoll = n(r.traced_before_roll);

    /**
     * The phase is what has actually happened, not what was scheduled.
     *
     * 'complete' requires the roll to have been consulted on everything it can be AND the
     * tracing to be done — a cohort that is fully traced but never rolled is NOT complete,
     * it is the old cadence, and it reports as 'pulled' so it shows up as work rather than
     * hiding behind a finished bar.
     */
    const phase: PipelinePhase =
      rollChecked === 0 ? 'pulled'
      : rollChecked < total ? 'roll'
      : traced < total ? 'tracing'
      : 'complete';

    return {
      cohort: String(r.cohort),
      code: cohortCode(String(r.cohort)),
      label: cohortLabel(String(r.cohort)),
      endsOn: cohortEnd(String(r.cohort)),
      grade,
      phase,
      total,
      rollChecked,
      rollMatch: n(r.roll_match),
      rollPartial: n(r.roll_partial),
      rollMismatch: n(r.roll_mismatch),
      rollNotFound: n(r.roll_not_found),
      rollAmbiguous: n(r.roll_ambiguous),
      rollNeedsReview: n(r.roll_needs_review),
      coMatch: n(r.co_match),
      coNoneOnRoll: n(r.co_none),
      coNeedsReview: n(r.co_needs_review),
      traced,
      tracedBeforeRoll,
      contactsCards: contactsBy.get(String(r.cohort))?.cards ?? 0,
      contactsNotTheirs: contactsBy.get(String(r.cohort))?.notTheirs ?? 0,
    };
  });
}
