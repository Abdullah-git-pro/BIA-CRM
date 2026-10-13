import { sql } from '@/lib/neon';
import { deliverableAddresses } from './emailVerification.service';
import { cohortLabel, cohortEnd, cohortOf } from './cohort';
import { LOST_TARGET_PCT } from '@/lib/targets';
import { insuredEmails, coInsuredEmails, assertRecipientCols } from './recipients.service';
import { contactabilityOf, householdReach } from './contactability.service';

/**
 * The cohort ledger (register A43).
 *
 * ── The question this answers ────────────────────────────────────────────────
 * Frank, 17 Sep 2026: "What do we start with grade A poll? What do we end up with due to
 * downgrading because of no contact info? And then what do we get back to by implementing
 * this? And then what's the total percent? Grade A started, grade A previous, we lost 40%.
 * Grade A current, we only lost 5%. That's the target, 5%."
 *
 * Four numbers per renewal week, not one. Reading "the cohort has N Grade A" as though it
 * were "the pull had N Grade A" is what turned a measurable pipeline into a 90-minute
 * argument: both figures are correct and they are not the same measurement, and until the
 * drop between them is shown as its own column nobody can say whether the skip trace is
 * recovering leads or whether they are simply being lost.
 *
 * ── Where the numbers come from ──────────────────────────────────────────────
 *   at pull    "Lead"."gradeAtPull"  — the grade the lead carried when its cohort was
 *                                     pulled (register A8, recovered from the activity
 *                                     feed while that feed was still complete)
 *   left A     a "GradeChange" row with fromGrade = 'A'
 *   regained A left A, and is Grade A again today
 *   email found the contact-recovery pipeline found the insured an email
 *   now        COALESCE(manualGrade, grade), i.e. what the CRM shows
 *
 * Nothing here is stored or cached. Every figure is derived on read from the grade log, so
 * it cannot fall out of step with the cards the way a snapshot would.
 */

export type CohortLedgerRow = {
  /** Monday of the renewal week, e.g. '2026-10-05'. */
  cohort: string;
  /** "Oct 5 – 11, 2026" */
  label: string;
  /** Inclusive Sunday, for anyone reconciling against a from/to range. */
  endsOn: string | null;
  total: number;
  /** Grade A when the cohort was pulled. */
  aAtPull: number;
  /** Of those, how many have left Grade A at any point, per the grade log. */
  downgraded: number;
  /**
   * The low-water mark: Grade A at pull, still Grade A, and never left.
   *
   * Derived as stillA - recovered, NOT as aAtPull - downgraded. Those two disagree
   * whenever a lead left Grade A without leaving a GradeChange row, and the log is a
   * backfill so a handful do. The first form can exceed the current count — it reported
   * a trough of 274 against 269 Grade A today — and a ledger whose columns do not add up
   * will be the only thing anyone remembers about it. See `unexplained`.
   */
  trough: number;
  /**
   * Left Grade A and is Grade A again today — a GRADE round trip.
   *
   * This is not what the skip trace buys, and reading it as though it were understates
   * the recovery work by an order of magnitude: in the Oct 5 week it is 1, while 11 leads
   * in that same week had an insured email found for them. Those 11 never left Grade A —
   * they were Grade A and unmailable, which is what isolation is — so finding them an
   * address changed their reach and not their grade. `emailRecovered` is that number.
   */
  recovered: number;
  /**
   * contactability inside Grade A (directive Sec. 4.1, task 27).
   *
   * The four values are the channel split: the first two are the email campaign, phone
   * only is Ruben's queue, and neither goes to the post. `mailable` above is the same
   * population as emailAndPhone + emailOnly — kept as its own field because the campaign
   * reads it by that name, and checked against it in scripts/verify-counts.mjs.
   */
  emailAndPhone: number;
  emailOnly: number;
  phoneOnly: number;
  /**
   * Grade A with nothing for the INSURED. Under the grading rule these should not exist
   * — it says D requires neither channel — so a non-zero value is either a lead that has
   * never been traced, or a grading gap. Surfaced rather than folded into phoneOnly,
   * because a call queue that contains people with no phone number is not a queue.
   */
  noInsuredContact: number;
  /** Of those, the ones with nothing anywhere on the card either: the direct-mail segment. */
  directMailOnly: number;
  /**
   * Leads the contact-recovery pipeline found an insured email for.
   *
   * The measurement that answers "what did the skip trace buy?", because it is the one
   * that moves `mailable`. Counted from the lead's own recovery stage, so it cannot
   * disagree with the pipeline tabs in QC → Blast Skip Traces.
   */
  emailRecovered: number;
  /** Grade A at pull and Grade A today. */
  stillA: number;
  /** Grade A today but NOT at pull — climbed up from below. */
  gainedOther: number;
  /** Grade A today, from any origin. What the Renewal Week chip shows. */
  aNow: number;
  /**
   * Of those, how many have an insured email — the ones the campaign can actually mail.
   *
   * aNow measures eligibility, this measures reach. They are far apart, and quoting the
   * first as though it were the second is how a cohort under-delivers against its own
   * forecast.
   */
  mailable: number;
  /**
   * Of the mailable, how many have an insured address a verifier confirmed exists
   * (Frank, 25 Sep 2026 — "right next to mailable").
   *
   * Mailable means the CRM holds an address. Verified means somebody checked the mailbox is
   * real. On C1–C3 those were 132 and 106 — the 26 in between look reachable in every report
   * we have and are not. Quoting mailable as though it were reach is the same mistake this
   * ledger already records one row up, for aNow against mailable.
   */
  verified: number;
  /** The co-insured programme, counted on its own — see the tally in getCohortLedger. */
  /**
   * Emails actually sent, and how many were opened, for this week.
   *
   * The ledger stopped at 'can we reach them' and never said whether anyone read it —
   * which is the question Frank keeps asking per cohort, and the one number that lived
   * only on the campaigns screen, broken down the wrong way.
   *
   * Counted per ADDRESS, like everything else here, and only where open tracking was
   * actually on: a campaign that recorded nothing would otherwise drag a week to zero.
   */
  emailed: number;
  opened: number;
  coMailable: number;
  coVerified: number;
  /** Confirmed on the co-insured and not on the insured: the only way in. */
  coOnly: number;
  /**
   * Mailable, but the address failed verification or has not been checked. The call-first
   * list.
   *
   * Not the same as "no email": these accounts hold an address that cannot be relied on,
   * which is a different problem from having none, and is worked differently.
   */
  unverified: number;
  /** aAtPull - stillA. */
  lost: number;
  /** lost / aAtPull, as a percentage. Frank's target is <= 5. */
  lostPct: number | null;
  /**
   * Of `downgraded`, the ones that left Grade A because the skip trace found no phone and
   * no email — never contactable, so never really workable.
   */
  downgradedUncontactable: number;
  /** `lostPct` with those excluded: the loss among leads outreach could have worked. */
  workableLostPct: number | null;
  /**
   * Leads in this cohort with no recorded starting grade.
   *
   * Carried on every row rather than footnoted: these leads are outside the measurement
   * entirely, and a loss percentage quoted without saying how many leads it could not see
   * is the kind of number that gets argued about later.
   */
  noPullRecord: number;
  /** Leads in this cohort a producer has rated. Zero means the week has not been worked. */
  rated: number;
  /**
   * Grade A leads still sitting at status 'new' in a cohort that HAS been worked.
   *
   * ── Why this is its own column (register A42) ───────────────────────────
   * Frank, 17 Sep 2026: "There's not a chance in hell you missed these… I know Ruben. I
   * know my guy." He was right — they were not missed. The 10/26 week holds 153 unworked
   * Grade A leads in Middlesex against 12 rated there, while Monmouth in the same week is
   * 46 rated against 5 unworked. The leads existed the whole time and were never put in
   * front of anyone.
   *
   * It matters beyond tidiness: a rated lead gets an indicative price in the second email
   * and an unrated one cannot, so a cohort silently holding unworked Grade A leads breaks
   * the cadence rather than just the count.
   */
  unworkedGradeA: number;
  /** Where those unworked leads sit, when they cluster in one place — the blind spot. */
  unworkedTopCounty: string | null;
  unworkedTopCountyShare: number | null;
  /**
   * Leads that are no longer Grade A and have no logged reason for it.
   *
   * lost - (downgraded - recovered). A non-zero value means the grade log is missing
   * changes for that many leads, so the split between "downgraded for missing contact
   * info" and "downgraded for something else" understates by this much. Shown rather
   * than quietly absorbed: the whole point of the ledger is that a number nobody can
   * account for is what started the argument.
   */
  unexplained: number;
};

export { LOST_TARGET_PCT };

/** Below this many unworked leads, a county share is noise rather than a blind spot. */
const MIN_CLUSTER = 10;

export async function getCohortLedger(
  params: { effFrom?: string; effTo?: string } = {},
): Promise<CohortLedgerRow[]> {
  const { effFrom, effTo } = params;

  /**
   * The range selects WHOLE renewal weeks, not a slice of days.
   *
   * Filtering leads by effectiveDate and then labelling each group "Oct 26 – Nov 1, 2026"
   * reports a partial week under a full-week heading: ask for 10/28–11/02 and the Oct 26
   * row silently drops the Mon/Tue leads while still claiming to be the whole week, so
   * "Grade A at pull" reads low and nothing on screen says why. Every column here is a
   * per-week measurement, so the unit of selection has to be the week too.
   *
   * Any week the range touches is included in full. cohortOf() gives the Monday of the
   * week containing a date, and cohorts sort correctly as ISO strings.
   */
  const fromCohort = effFrom ? cohortOf(effFrom) : null;
  const toCohort = effTo ? cohortOf(effTo) : null;

  const rows = await sql`
    WITH scoped AS (
      SELECT l."id",
             l."cohort",
             l."gradeAtPull",
             l."status",
             l."recoveryStage",
             -- The two carrier premiums ARE the rated test (Frank, 23 Sep 2026); see the
             -- note on the rated aggregate below for why the status column cannot serve.
             l."travelersPremium",
             l."plymouthPremium",
             COALESCE(l."manualGrade", l."grade") AS now_grade
        FROM "Lead" l
       WHERE l."cohort" IS NOT NULL
         AND (${fromCohort}::text IS NULL OR l."cohort" >= ${fromCohort})
         AND (${toCohort}::text   IS NULL OR l."cohort" <= ${toCohort})
    ),
    flagged AS (
      SELECT s.*,
             EXISTS (SELECT 1 FROM "GradeChange" g
                      WHERE g."leadId" = s."id" AND g."fromGrade" = 'A') AS left_a,
             /*
              * Of those, the ones that left because nobody could ever contact them.
              *
              * Frank's target is a loss of 5% or less, and without this split the
              * ledger reports a loss of 20-40% against it with no way to see what the
              * loss is made of. A lead the skip trace could find no phone and no email
              * for was never workable — it is a data outcome, not outreach attrition,
              * and averaging the two together makes the number mean nothing.
              *
              * Matched on the reason text written by the re-grade, which is the only
              * place that distinction is recorded.
              */
             EXISTS (SELECT 1 FROM "GradeChange" g
                      WHERE g."leadId" = s."id" AND g."fromGrade" = 'A'
                        AND g."reason" ILIKE '%no phone and no email%') AS left_a_uncontactable
        FROM scoped s
    )
    SELECT "cohort",
           COUNT(*)::int                                                              AS total,
           COUNT(*) FILTER (WHERE "gradeAtPull" = 'A')::int                           AS a_at_pull,
           COUNT(*) FILTER (WHERE "gradeAtPull" = 'A' AND left_a)::int                AS downgraded,
           COUNT(*) FILTER (WHERE "gradeAtPull" = 'A' AND left_a
                              AND left_a_uncontactable)::int                          AS downgraded_uncontactable,
           COUNT(*) FILTER (WHERE "gradeAtPull" = 'A' AND left_a
                              AND now_grade = 'A')::int                               AS recovered,
           COUNT(*) FILTER (WHERE "recoveryStage" = 'recovered')::int                 AS email_recovered,
           COUNT(*) FILTER (WHERE "gradeAtPull" = 'A' AND now_grade = 'A')::int        AS still_a,
           COUNT(*) FILTER (WHERE "gradeAtPull" IS DISTINCT FROM 'A'
                              AND now_grade = 'A')::int                               AS gained_other,
           COUNT(*) FILTER (WHERE now_grade = 'A')::int                               AS a_now,
           COUNT(*) FILTER (WHERE "gradeAtPull" IS NULL)::int                         AS no_pull_record,
           /*
            * Rated means a carrier premium exists, not that the status column says so.
            *
            * Frank, 23 Sep 2026: "The dashboard's 'Rated 48' is wrong. The cause: lead
            * status was changed from 'rated' to 'new' so leads without an email could be
            * pulled for the skip trace blast. New rule: a lead counts as rated if it has a
            * premium in Travelers or Plymouth Rock, whatever its status says."
            *
            * Two bugs were in that one number, and only one of them was the status:
            *
            *  1. It read the status column, which the blast and the isolation step both
            *     overwrite. A lead rated on Monday and pulled for tracing on Tuesday
            *     stopped counting.
            *  2. It counted EVERY lead in the week regardless of grade, so C2 reported 82
            *     rated against 65 Grade A — more rated leads than there were leads to rate.
            *
            * expectedPremium is deliberately not used: it is the pricing engine's own
            * output and sits on 9,661 of 9,937 leads, so it would report almost everything
            * as rated. The carrier premiums are the ones a producer enters.
            */
           COUNT(*) FILTER (WHERE now_grade = 'A'
                              AND ("travelersPremium" IS NOT NULL
                                OR "plymouthPremium" IS NOT NULL))::int                AS rated,
           /* The complement of rated, for the same reason — not status = 'new'. */
           COUNT(*) FILTER (WHERE now_grade = 'A'
                              AND "travelersPremium" IS NULL
                              AND "plymouthPremium" IS NULL)::int                      AS unworked_a
      FROM flagged
     GROUP BY "cohort"
     ORDER BY "cohort"`;

  /**
   * Where the unworked Grade A leads sit.
   *
   * Reported only when they CLUSTER: leads spread evenly across counties are simply work
   * still to do, while a week whose untouched leads are almost all in one county is a
   * blind spot — that is the shape the 10/26 Middlesex leads made, and the shape nobody
   * could see until it was counted this way.
   */
  /**
   * How many of the Grade A leads can actually be emailed.
   *
   * The grade columns measure eligibility; this measures reach, and the two diverge badly
   * — the Oct 12 week holds 87 Grade A of which 46 are mailable. A ledger that reports
   * only the grade reads as though the whole 87 are workable, and a week can look like its
   * best on the loss column while barely half of it can be contacted.
   *
   * Computed with the SAME rule the Renewal Week chips and the campaign push use, so the
   * ledger cannot promise reach the push would not act on. That means reading the
   * recipient columns rather than a SQL predicate: the insured's addresses are attributed
   * per person inside the trace payload, and `email1 IS NOT NULL` both misses addresses
   * and counts the co-insured's as the insured's.
   */
  const reachRows = await sql`
    SELECT "cohort", "email1", "email2", "owner2Email",
           "phone1", "phone2", "owner2Phone",
           "owner1FirstName", "owner1LastName", "owner2FirstName", "owner2LastName",
           "skipTraceData", "emailsAll", "phonesAll",
           COALESCE("manualGrade", "grade") AS now_grade
      FROM "Lead"
     WHERE "cohort" IS NOT NULL
       AND (${fromCohort}::text IS NULL OR "cohort" >= ${fromCohort})
       AND (${toCohort}::text   IS NULL OR "cohort" <= ${toCohort})`;
  assertRecipientCols((reachRows as any[])[0], 'cohort ledger (mailable)');

  const mailableByCohort = new Map<string, number>();
  const verifiedByCohort = new Map<string, number>();

  /**
   * ── The co-insured, counted separately because it is a separate programme ──
   *
   * `verified` above is the INSURED only — insuredEmails() excludes everything belonging
   * to the second person. That was never a mix; the co-insured simply was not counted
   * anywhere on this screen.
   *
   * It needs to be, because the co-insured is mailed in its own right: 77 sends to 77
   * co-insured addresses, 414 leads carrying their own co-insured subject line and CTA
   * arm, and verification sheets that already split by role (C1 36, C2 46, C3 16 against
   * 202, 213 and 193 insured). Two programmes, one of which had no numbers.
   *
   * What it immediately shows is the gap: C4 onward have no co-insured verification at
   * all, which is invisible while only the insured is reported.
   *
   * Counted in the same pass as the insured, over the same rows, so the two can never
   * describe different populations — the mistake `mailable` and `verified` were written
   * to avoid one row up.
   */
  const coHoldByCohort = new Map<string, number>();
  const coVerifiedByCohort = new Map<string, number>();
  /** Verified on the co-insured and NOT on the insured: the only confirmed way in. */
  const coOnlyByCohort = new Map<string, number>();
  const bump = (m: Map<string, number>, k: string) => m.set(k, (m.get(k) ?? 0) + 1);
  /** Loaded once. A lookup per lead across thousands of leads is a query per lead. */
  const deliverable = await deliverableAddresses();

  /**
   * contactability inside Grade A, per cohort (Sec. 4.1, task 27).
   *
   * Tallied from the same rows as `mailable` and in the same pass, so the four values and
   * the mailable count are guaranteed to describe one population. Computed through
   * contactability.service rather than inline, so the ledger, the QC rows and the campaign
   * export all answer this question the same way.
   */
  type Tally = {
    emailAndPhone: number; emailOnly: number; phoneOnly: number;
    noInsuredContact: number; directMailOnly: number;
  };
  const contactByCohort = new Map<string, Tally>();
  const tallyFor = (cohort: string): Tally => {
    let t = contactByCohort.get(cohort);
    if (!t) {
      t = { emailAndPhone: 0, emailOnly: 0, phoneOnly: 0, noInsuredContact: 0, directMailOnly: 0 };
      contactByCohort.set(cohort, t);
    }
    return t;
  };

  for (const r of reachRows as any[]) {
    if (r.now_grade !== 'A') continue;
    const t = tallyFor(r.cohort);
    switch (contactabilityOf(r)) {
      case 'email_and_phone': t.emailAndPhone++; break;
      case 'email_only': t.emailOnly++; break;
      case 'phone_only': t.phoneOnly++; break;
      default:
        t.noInsuredContact++;
        // Nothing for the insured AND nothing for the household: the post is the only
        // way left. A co-insured number keeps the lead in the call queue instead.
        if (householdReach(r) === 'none') t.directMailOnly++;
    }
    /*
     * The co-insured tally sits ABOVE the insured `continue` below.
     *
     * That line skips any lead with no insured address — and a lead whose only confirmed
     * address belongs to the co-insured is exactly the case this is meant to surface.
     * Counting after it would drop the rows that matter most.
     */
    const coAddresses = coInsuredEmails(r);
    const insuredVerified = insuredEmails(r).some((e) => deliverable.has(String(e).trim().toLowerCase()));
    if (coAddresses.length) {
      bump(coHoldByCohort, r.cohort);
      if (coAddresses.some((e) => deliverable.has(String(e).trim().toLowerCase()))) {
        bump(coVerifiedByCohort, r.cohort);
        if (!insuredVerified) bump(coOnlyByCohort, r.cohort);
      }
    }

    if (insuredEmails(r).length === 0) continue;
    mailableByCohort.set(r.cohort, (mailableByCohort.get(r.cohort) ?? 0) + 1);
    /**
     * An account counts as verified when ANY of its insured addresses passed.
     *
     * The campaign sends to one address, and one confirmed address is enough to reach the
     * person. Requiring all of them would mark an account unreachable because a stale
     * second address failed, which is the opposite of what the number is for.
     */
    if (insuredEmails(r).some((e) => deliverable.has(String(e).trim().toLowerCase()))) {
      verifiedByCohort.set(r.cohort, (verifiedByCohort.get(r.cohort) ?? 0) + 1);
    }
  }

  /**
   * What was sent and opened, per week.
   *
   * Read from OutreachEvent rather than the platform, so the ledger stays a single
   * database query and does not hang on fifteen vendor calls. The cost is coverage: the
   * CRM holds 44 of the 70 opens the platform knows about, the gap being addresses that
   * were mailed with no send record on our side. The column says so rather than
   * pretending to be complete.
   */
  /*
   * ── Grade A only, because every other column on this row is ──────────────
   *
   * Without the join this counted every send in the week whatever its grade, and C1 read
   * 48 mailable against 181 emailed — more mail than there were addresses to send it to.
   * The Grade B sends are real and belong on the Grade B ledger, which has its own
   * version of this column; here they only made the row impossible.
   *
   * Same mistake the outreach ladder made, one screen over, found the same way: a
   * subset larger than the set it is drawn from.
   */
  const engagementRows = await sql`
    SELECT o."cohort",
           COUNT(DISTINCT o."leadId") FILTER (WHERE o."sentAt" IS NOT NULL)::int AS emailed,
           COUNT(DISTINCT o."leadId") FILTER (WHERE o."openedAt" IS NOT NULL)::int AS opened
      FROM "OutreachEvent" o
      JOIN "Lead" l ON l."id" = o."leadId"
     WHERE o."cohort" IS NOT NULL
       AND COALESCE(l."manualGrade", l."grade") = 'A'
       -- CARDS, not addresses, and insured ones only — because every other figure on this
       -- row is a card. Frank mails every verified address the insured has, so 48 mailable
       -- cards produced 63 sent addresses and the row read as more mail than there was
       -- anywhere to send it from.
       -- Insured only, because the mailable column beside it counts cards that have an
       -- insured email. Counting the co-insured here too put more mail on the row than
       -- there were cards to send it from — C1 read 48 mailable against 74 emailed. The
       -- co-insured has its own table underneath, which is where their sends belong.
       AND o."personRole" = 'insured'
     GROUP BY o."cohort"` as Array<Record<string, unknown>>;
  const engagementByCohort = new Map(engagementRows.map((r) => [String(r.cohort),
    { emailed: Number(r.emailed ?? 0), opened: Number(r.opened ?? 0) }]));

  const clusters = await sql`
    SELECT "cohort", "addressCounty" AS county, COUNT(*)::int n
      FROM "Lead"
     WHERE "cohort" IS NOT NULL
       AND "status" = 'new'
       AND COALESCE("manualGrade", "grade") = 'A'
       AND (${fromCohort}::text IS NULL OR "cohort" >= ${fromCohort})
       AND (${toCohort}::text   IS NULL OR "cohort" <= ${toCohort})
     GROUP BY 1, 2`;

  const topByCohort = new Map<string, { county: string | null; n: number; total: number }>();
  for (const c of clusters as any[]) {
    const seen = topByCohort.get(c.cohort) ?? { county: null, n: 0, total: 0 };
    seen.total += Number(c.n);
    if (Number(c.n) > seen.n) { seen.n = Number(c.n); seen.county = c.county ?? null; }
    topByCohort.set(c.cohort, seen);
  }

  return (rows as any[]).map((r) => {
    const aAtPull = Number(r.a_at_pull);
    const stillA = Number(r.still_a);
    const downgraded = Number(r.downgraded);
    const recovered = Number(r.recovered);
    const lost = aAtPull - stillA;
    return {
      cohort: r.cohort,
      label: cohortLabel(r.cohort),
      endsOn: cohortEnd(r.cohort),
      total: Number(r.total),
      aAtPull,
      downgraded,
      trough: stillA - recovered,
      recovered,
      emailRecovered: Number(r.email_recovered),
      unexplained: lost - (downgraded - recovered),
      stillA,
      gainedOther: Number(r.gained_other),
      aNow: Number(r.a_now),
      mailable: mailableByCohort.get(r.cohort) ?? 0,
      verified: verifiedByCohort.get(r.cohort) ?? 0,
      unverified: (mailableByCohort.get(r.cohort) ?? 0) - (verifiedByCohort.get(r.cohort) ?? 0),
      emailed: engagementByCohort.get(r.cohort)?.emailed ?? 0,
      opened: engagementByCohort.get(r.cohort)?.opened ?? 0,
      coMailable: coHoldByCohort.get(r.cohort) ?? 0,
      coVerified: coVerifiedByCohort.get(r.cohort) ?? 0,
      coOnly: coOnlyByCohort.get(r.cohort) ?? 0,
      emailAndPhone: contactByCohort.get(r.cohort)?.emailAndPhone ?? 0,
      emailOnly: contactByCohort.get(r.cohort)?.emailOnly ?? 0,
      phoneOnly: contactByCohort.get(r.cohort)?.phoneOnly ?? 0,
      noInsuredContact: contactByCohort.get(r.cohort)?.noInsuredContact ?? 0,
      directMailOnly: contactByCohort.get(r.cohort)?.directMailOnly ?? 0,
      lost,
      // A cohort with no Grade A at pull has no loss rate — not a loss rate of zero.
      lostPct: aAtPull ? Math.round((lost / aAtPull) * 1000) / 10 : null,
      downgradedUncontactable: Number(r.downgraded_uncontactable),
      /**
       * The loss with the never-contactable leads taken out — what outreach actually lost.
       *
       * Both rates are reported, never one. `lostPct` is the honest total and stays the
       * headline; this one answers the question the total cannot: of the leads we could
       * have worked, how many did we lose. Quoting only this would flatter the number,
       * and quoting only the total buries a real result under a data problem.
       */
      workableLostPct: aAtPull - Number(r.downgraded_uncontactable) > 0
        ? Math.round(((lost - Number(r.downgraded_uncontactable))
          / (aAtPull - Number(r.downgraded_uncontactable))) * 1000) / 10
        : null,
      noPullRecord: Number(r.no_pull_record),
      rated: Number(r.rated),
      unworkedGradeA: Number(r.unworked_a),
      /**
       * Surfaced only on a clear majority AND enough leads to mean something.
       *
       * The share alone is not a signal: a week with three unworked leads that happen to
       * share a county reports 100% and reads as urgently as the week with 153. A note
       * that fires on noise stops being read, and the one case worth investigating goes
       * out with it.
       */
      ...(() => {
        const top = topByCohort.get(r.cohort);
        const share = top && top.total ? Math.round((top.n / top.total) * 100) : 0;
        const worthNaming = top && top.county && share >= 70 && top.total >= MIN_CLUSTER;
        return worthNaming
          ? { unworkedTopCounty: top!.county, unworkedTopCountyShare: share }
          : { unworkedTopCounty: null, unworkedTopCountyShare: null };
      })(),
    };
  });
}
