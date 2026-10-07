import { sql } from '@/lib/neon';
import { insuredEmails, coInsuredName } from './recipients.service';
import { numbersOnCard, liveNumbersOnCard, invalidPhonesOf } from './callLog.service';
import { deliverableAddresses } from './emailVerification.service';
import { COHORT_LABEL } from './campaignSegment.service';
import { CALL_STATUS_LABEL, isReachedStatus, type CallStatus } from '@/lib/callOutcomes';
import { getQcReport } from './reports.service';
import { cohortCode } from './cohort';

/**
 * The phone outreach dashboard (Frank, 25 Sep 2026).
 *
 * "Mirror email outreach dashboard; filter by cohort, date, and no-verified-email accounts
 *  based on the final verified email results... C1-C3 total rated = 178, Total verified
 *  Insured email = 106, Non-verified = 72. We call these first and as soon as ready."
 *
 * ── Why this is not just the email dashboard with a different column ────────
 * The email dashboard answers "how is the campaign doing". This answers "who does Ruben ring
 * next", which is a different question with a different shape: it is a queue, ordered, and
 * its top line is the accounts email cannot reach at all.
 *
 * The three numbers Frank quotes are the whole point — rated, of those reachable by a
 * verified address, and the remainder. That remainder is the work. Everything else here
 * exists to say how far through it we are.
 *
 * ── Verified means a verifier said so ───────────────────────────────────────
 * Not "we hold an address". Those differ by 26 accounts on C1–C3 alone, and the 26 look
 * reachable in every other report. Until a verification run lands, `verified` is zero and
 * the dashboard says so rather than reporting the whole book as unreachable.
 */

export type PhoneFilters = {
  cohortFrom?: string;
  cohortTo?: string;
  /** 'unverified' is the call-first list; 'all' is everything rated. */
  reach?: 'all' | 'verified' | 'unverified';
  status?: CallStatus | 'all';
};

export type PhoneQueueRow = {
  propertyId: string;
  leadId: string;
  owner: string;
  address: string;
  cohort: string;
  cohortLabel: string;
  renewal: string;
  premium: number | null;
  /** Has an insured address a verifier confirmed. */
  verified: boolean;
  hasAnyEmail: boolean;
  numbers: number;
  /** Retired by a bad-number or wrong-person outcome. Not worth ringing again. */
  deadNumbers: number;
  dncNumbers: number;
  callable: number;
  callStatus: CallStatus;
  callStatusLabel: string;
  attempts: number;
  /** Of those attempts, how many went to a co-insured number. */
  coInsuredAttempts: number;
  /** Whose number answered when contact was made. Null until reached. */
  reachedVia: 'insured' | 'co_insured' | null;
  /** The co-insured's name — who to ask for when one of their numbers answers. */
  coInsuredName: string | null;
  /** Numbers on the card belonging to the co-insured, and how many are worth ringing. */
  coInsuredNumbers: number;
  coInsuredLive: number;
  /** Live numbers belonging to the insured. Zero means the co-insured is the only way in. */
  insuredLive: number;
  lastAttemptAt: string | null;
};

export type PhoneDashboard = {
  filters: Required<Pick<PhoneFilters, 'cohortFrom' | 'cohortTo'>> & PhoneFilters;
  /** Frank's three headline numbers. */
  rated: number;
  verifiedEmail: number;
  nonVerified: number;
  /** Whether any verification has happened at all — the three numbers mean nothing without it. */
  verificationRun: boolean;
  /** How far through the call-first list we are. */
  funnel: Array<{ key: string; label: string; count: number; of: string | null; note?: string }>;
  byCohort: Array<{
    cohort: string; label: string; rated: number; verified: number; nonVerified: number;
    called: number; reached: number; noNumbers: number;
  }>;
  queue: PhoneQueueRow[];
  /** Accounts with nothing to ring — neither email nor a usable number. */
  unreachableAnyChannel: number;
};

const WAVE_FROM = '2026-10-05';
const WAVE_TO = '2026-11-16';

export async function getPhoneDashboard(f: PhoneFilters = {}): Promise<PhoneDashboard> {
  const cohortFrom = f.cohortFrom || WAVE_FROM;
  const cohortTo = f.cohortTo || WAVE_TO;
  const reach = f.reach ?? 'all';
  const wantStatus = f.status ?? 'all';

  const leads = await sql`
    SELECT * FROM "Lead"
     WHERE "cohort" BETWEEN ${cohortFrom} AND ${cohortTo}
       AND COALESCE("manualGrade", "grade") = 'A'
       -- Rated only. Frank's three numbers are all "of the rated", because an unrated
       -- account has no band price to talk about and belongs in a different conversation.
       AND ("travelersPremium" IS NOT NULL OR "plymouthPremium" IS NOT NULL)
     ORDER BY "cohort", "owner1LastName"` as Array<Record<string, any>>;

  const deliverable = await deliverableAddresses();
  const [{ n: checked }] = await sql`
    SELECT COUNT(*)::int AS n FROM "EmailVerification"` as Array<{ n: number }>;

  /**
   * Call state comes from the call_outcome report, not from CallAttempt again.
   *
   * That report already derives status and quote stage, and its suite asserts it agrees
   * with the lead card lead by lead. A second reading here would be a third implementation
   * of the stop rule, and the first change to it would leave this dashboard on the old one.
   */
  const callRows = await getQcReport('call_outcome', {});
  const byProperty = new Map(callRows.map((r) => [String(r.propertyId), r]));

  const queue: PhoneQueueRow[] = [];
  let verifiedCount = 0;
  let unreachableAnyChannel = 0;
  const cohorts = new Map<string, {
    rated: number; verified: number; called: number; reached: number; noNumbers: number;
  }>();

  for (const l of leads) {
    const cohort = String(l.cohort);
    if (!cohorts.has(cohort)) {
      cohorts.set(cohort, { rated: 0, verified: 0, called: 0, reached: 0, noNumbers: 0 });
    }
    const c = cohorts.get(cohort)!;
    c.rated++;

    const addresses = insuredEmails(l);
    const isVerified = addresses.some((e) => deliverable.has(String(e).trim().toLowerCase()));
    if (isVerified) { verifiedCount++; c.verified++; }

    const nums = numbersOnCard(l);
    /*
     * Not do-not-call AND not already proven dead.
     *
     * This counted only the do-not-call flag, so a number Ruben had already logged as a
     * bad number still counted as one he could ring. The queue is SORTED by this, "most
     * live numbers first", so cards with nothing left to dial sorted to the top of his
     * list — the opposite of what the ordering is for.
     */
    const coName = coInsuredName(l);
    const live = liveNumbersOnCard(l);
    const callable = live.length;
    // Counted directly, not as a subtraction: a number can be BOTH flagged and dead, and
    // nums - live - dnc would quietly count it twice and report a negative.
    const dead = new Set(invalidPhonesOf(l));
    const deadNumbers = nums.filter((n) => dead.has(n.number)).length;
    if (!nums.length) c.noNumbers++;
    if (!callable && !isVerified) unreachableAnyChannel++;

    const call = byProperty.get(String(l.propertyId));
    const status = (call?.callStatus ?? 'not_attempted') as CallStatus;
    if (status !== 'not_attempted') c.called++;
    if (isReachedStatus(status)) c.reached++;

    if (reach === 'verified' && !isVerified) continue;
    if (reach === 'unverified' && isVerified) continue;
    if (wantStatus !== 'all' && status !== wantStatus) continue;

    queue.push({
      propertyId: String(l.propertyId),
      leadId: String(l.id),
      owner: [l.owner1FirstName, l.owner1LastName].filter(Boolean).join(' ') || '—',
      address: [l.addressStreet, l.addressCity].filter(Boolean).join(', '),
      cohort,
      cohortLabel: cohortCode(cohort) ?? cohort,
      renewal: String(l.effectiveDate ?? '').slice(0, 10),
      premium: l.travelersPremium ?? l.plymouthPremium ?? null,
      verified: isVerified,
      hasAnyEmail: addresses.length > 0,
      numbers: nums.length,
      dncNumbers: nums.filter((n) => n.dnc).length,
      deadNumbers,
      callable,
      callStatus: status,
      callStatusLabel: CALL_STATUS_LABEL[status] ?? status,
      attempts: call?.callAttempts ?? 0,
      /*
       * Who the calls went to, and whose number answered.
       *
       * Stored on every attempt since the call panel was built and read by nothing, so
       * 65 calls to a co-insured were reported as though they had been to the insured.
       * It matters twice on this screen: Ruben needs to know he will be asking for
       * somebody else by name, and 3 of the 11 households reached so far answered on a
       * co-insured number — the only evidence that carrying them is worth the credits.
       */
      coInsuredAttempts: coName ? (call?.callCoInsuredTries ?? 0) : 0,
      /*
       * The stored role is history, and on a few cards the history is wrong.
       *
       * Every attempt records whose number was dialled, but until today owner2Phone was
       * taken for a co-insured even on the 11 cards where the owner2 columns hold a copy
       * of the insured's own name. Angela Matera answering her own third number was
       * logged as a co-insured pickup, and she was 1 of the 3 that make the case for
       * ringing them at all.
       *
       * Corrected here rather than by editing CallAttempt: the row is a true record of
       * what Ruben dialled. What was wrong is the label we printed beside the number,
       * and a card with no second person on it cannot have been reached through one.
       */
      reachedVia: coName ? (call?.reachedVia ?? null) : null,
      /*
       * The co-insured side of the card, broken out for its own table.
       *
       * "7 worth ringing" tells Ruben nothing about who answers. Two of those seven can
       * be the co-insured's, which is a different person to ask for — and on some cards
       * every live number is theirs, so the insured is not reachable by phone at all.
       */
      coInsuredName: coName,
      coInsuredNumbers: nums.filter((n) => n.role === 'co_insured').length,
      coInsuredLive: live.filter((n) => n.role === 'co_insured').length,
      insuredLive: live.filter((n) => n.role === 'insured').length,
      lastAttemptAt: null,
    });
  }

  /**
   * The queue order IS the instruction: "we call these first and as soon as ready".
   *
   * Never called before called; then most callable numbers, because an account with six
   * live numbers is likelier to answer than one with a single DNC-flagged line; then
   * soonest renewal, because that is the one running out of time.
   */
  queue.sort((a, b) =>
    Number(a.attempts > 0) - Number(b.attempts > 0)
    || b.callable - a.callable
    || a.renewal.localeCompare(b.renewal));

  const rated = leads.length;
  const nonVerified = rated - verifiedCount;
  const called = queue.filter((q) => q.attempts > 0).length;
  const reached = queue.filter((q) => isReachedStatus(q.callStatus)).length;
  const reachedViaCoInsured = queue.filter((q) => q.reachedVia === 'co_insured').length;
  const quoting = queue.filter((q) => q.callStatus === 'quoting').length;

  return {
    filters: { cohortFrom, cohortTo, reach, status: wantStatus },
    rated,
    verifiedEmail: verifiedCount,
    nonVerified,
    verificationRun: checked > 0,
    unreachableAnyChannel,
    funnel: [
      {
        key: 'to_call', label: 'In this list', count: queue.length, of: null,
        note: reach === 'unverified'
          ? 'Rated accounts with no verified email — the ones email cannot reach.'
          : 'Rated accounts matching the filters.',
      },
      { key: 'called', label: 'Called at least once', count: called, of: 'to_call' },
      {
        key: 'reached', label: 'Reached a person', count: reached, of: 'called',
        note: 'Actually spoke to someone — not merely dialled.'
          + (reachedViaCoInsured
            ? ` ${reachedViaCoInsured} of them answered on a co-insured's number, not the insured's.`
            : ''),
      },
      { key: 'quoting', label: 'Quoting', count: quoting, of: 'reached' },
    ],
    byCohort: [...cohorts].sort().map(([cohort, v]) => ({
      cohort,
      label: cohortCode(cohort) ?? cohort,
      rated: v.rated,
      verified: v.verified,
      nonVerified: v.rated - v.verified,
      called: v.called,
      reached: v.reached,
      noNumbers: v.noNumbers,
    })),
    queue,
  };
}
