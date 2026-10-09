import { sql } from '@/lib/neon';
import { insuredEmails, assertRecipientCols } from './recipients.service';
import { deliverableAddresses } from './emailVerification.service';
import { cohortLabel, cohortOf } from './cohort';
import { computeMetrics } from './protectiveMetrics.service';
import { RENEWAL_PULL_LEAD_DAYS } from './pipeline.service';

/**
 * The outreach dashboard (directive Sec. 10.7).
 *
 * ── Where the definitions come from ─────────────────────────────────────────
 * Not invented here. Every stage, target and pause rule below is transcribed from Frank's
 * own KPI Tracker (v12 Target Model) — the funnel in section 1, the guardrails in section
 * 2. Building a dashboard on a second set of definitions would produce a screen that
 * disagrees with the spreadsheet it is meant to replace, which is worse than no screen.
 *
 * ── The funnel is a ladder, and each rung divides by the one above ──────────
 * That matters: a rate is only meaningful against its own denominator. "Coverage" is
 * cards-with-email over Grade A WORKED, not over Grade A at pull, because a lead that
 * left Grade A was never a candidate. Quoting one denominator as another is how a funnel
 * reports 61% and 81% for the same week, which is discrepancy D2 in Frank's own log.
 *
 * ── Honest zeroes ───────────────────────────────────────────────────────────
 * Everything from "people emailed" down reads zero until outreach starts, and that is
 * reported as "not started" rather than as a failing rate. A dashboard that shows 0%
 * engagement before a single email has gone out is not measuring engagement; it is
 * measuring that nothing has happened, and the two must not look alike.
 */

/** A rung of the funnel. `of` names the rung it is measured against. */
export type FunnelStage = {
  key: string;
  label: string;
  count: number;
  /** The stage this one's rate is computed against — the ladder, made explicit. */
  of: string | null;
  rate: number | null;
  /** Frank's target for that rate, where the tracker sets one. */
  target: number | null;
  /** Below this, the tracker says stop and diagnose. */
  floor: number | null;
  /** True once anything at all has happened at this stage. */
  started: boolean;
  note?: string;
};

export type Guardrail = {
  key: string;
  label: string;
  value: number | null;
  target: number | null;
  /**
   * The threshold that actually stops a send, where one exists.
   *
   * Distinct from `target` on purpose. Inbox placement targets 80% and pauses below 75%;
   * this dashboard originally carried 75 as the TARGET, which quietly reported a campaign
   * sitting on the pause line as having hit its goal.
   */
  pauseAt: number | null;
  /** The pause rule has fired: past the threshold and over the minimum volume. */
  breached: boolean;
  /** Something a person should look at even though no rule fired. */
  needsAttention: string | null;
  /** The period this is measured over — these are not all the same, so each says. */
  scope: string;
  /** The tracker's pause rule, verbatim in spirit — shown next to the number it governs. */
  pause: string | null;
  /** Which way is good. A bounce rate falling is progress; coverage falling is not. */
  direction: 'higher' | 'lower';
  started: boolean;
  definition: string;
};

export type DashboardCohort = {
  cohort: string;
  label: string;
  atPull: number;
  /** Grade A at pull AND Grade A now — the retention numerator. */
  kept: number;
  /** Not Grade A at pull, Grade A now. Worked, but not retention. */
  gained: number;
  worked: number;
  withEmail: number;
  loaded: number;
  emailed: number;
  delivered: number;
  engaged: number;
  quoted: number;
  bound: number;
};

/** The renewal weeks the outreach programme actually covers. */
export type PullWindow = {
  from: string;
  to: string;
  /** Plain-English account of how both ends were derived, shown on the screen. */
  reason: string;
};

/**
 * What a defaulted range leaves out — published so the default cannot hide anything.
 *
 * Defaulting to the programme window is the right view and a dangerous one: the weeks it
 * drops are mostly finished business, but 28 Sep was pulled with 699 cards and never
 * prepared for outreach, and a default that silently omitted that would be a worse lie
 * than the diluted percentage it fixes.
 */
export type ExcludedWeeks = {
  cohorts: number;
  atPull: number;
  worked: number;
  withEmail: number;
  /** The weeks themselves, so the screen can name them. */
  labels: string[];
};

export type OutreachDashboard = {
  range: { from: string | null; to: string | null };
  /**
   * The first and last renewal week the database actually holds.
   *
   * Sent so the date inputs can bound themselves. A renewal week of 2099 is not a filter
   * anyone wants, and the screen has no business accepting one — but the bound has to come
   * from the data rather than from a number picked here, or it goes stale the first time
   * the pull reaches past it.
   */
  cohortBounds: { first: string | null; last: string | null };
  /** True when no range was asked for and the programme window was applied. */
  defaultedRange: boolean;
  /** Set whenever the range was defaulted — null when the caller chose the range. */
  window: PullWindow | null;
  excluded: ExcludedWeeks | null;
  funnel: FunnelStage[];
  guardrails: Guardrail[];
  byCohort: DashboardCohort[];
  /** Set when nothing has been sent — the screen says so once, loudly, instead of per row. */
  outreachStarted: boolean;
  generatedAt: string;
};

/**
 * The rolling window the §08 protective metrics are read over.
 *
 * 7 days because §08 calls them daily metrics and computeMetrics defaults to a week: a
 * campaign that sent badly in October and well since should not be paused by history.
 * Named here so this screen cannot quietly disagree with the service it is quoting.
 */
const PROTECTIVE_WINDOW_DAYS = 7;

const pct = (n: number, d: number): number | null =>
  d > 0 ? Math.round((n / d) * 1000) / 10 : null;

/**
 * The renewal weeks the outreach programme covers.
 *
 * Both ends are derived, because both move:
 *
 *  · The START is the earliest cohort that has had blast skip tracing. That is the first
 *    thing done to a week to prepare it for outreach, so it is the point a week joins the
 *    programme. `gradeAtPull` cannot serve here — gradeHistory backfills it from `grade`
 *    on every lead ever loaded, including the March–July weeks that predate outreach.
 *  · The END is the week the weekly pull is currently reaching: renewals are worked
 *    RENEWAL_PULL_LEAD_DAYS ahead, so today + 60 days names the furthest week that can
 *    have been pulled.
 *
 * Returns null when nothing has been blast traced — there is no programme yet, and
 * inventing a window would be worse than showing everything.
 */
export async function getActivePullWindow(runDate: Date = new Date()): Promise<PullWindow | null> {
  const [row] = await sql`
    SELECT MIN("cohort") AS first_blast
      FROM "Lead"
     WHERE "blastSkipTracedAt" IS NOT NULL AND "cohort" IS NOT NULL` as Array<Record<string, unknown>>;
  const from = row?.first_blast ? String(row.first_blast) : null;
  if (!from) return null;

  const ahead = new Date(runDate);
  ahead.setUTCDate(ahead.getUTCDate() + RENEWAL_PULL_LEAD_DAYS);
  const to = cohortOf(ahead.toISOString().slice(0, 10));
  if (!to || to < from) return null;

  return {
    from,
    to,
    reason: `Weeks ${cohortLabel(from)} to ${cohortLabel(to)}: from the first week prepared `
      + `for outreach, to the furthest week the weekly pull reaches today `
      + `(renewals are worked ${RENEWAL_PULL_LEAD_DAYS} days ahead).`,
  };
}

export async function getOutreachDashboard(params: {
  effFrom?: string;
  effTo?: string;
  /**
   * Show every week ever loaded instead of defaulting to the programme window.
   *
   * A flag, not a pair of wide dates. Expressing it as a range meant the screen had to put
   * 01/01/2000 and 12/31/2099 in the date boxes to mean "no range", which reads as a
   * mistake and is one keystroke away from becoming a real filter nobody intended.
   */
  allWeeks?: boolean;
} = {}): Promise<OutreachDashboard> {
  /**
   * With no range asked for, show the programme rather than the whole database.
   *
   * Unfiltered, this screen spans back to March and reports email coverage of 48.7%
   * "below floor" — true of every card ever loaded, and false of the campaign. About 418
   * Grade A cards sit in weeks that were pulled before outreach existed and were never
   * skip traced; they are not a coverage failure, they are not the programme.
   *
   * An explicit range is always honoured exactly as given.
   */
  const asked = Boolean(params.effFrom || params.effTo);
  const window = asked || params.allWeeks ? null : await getActivePullWindow();
  const effFrom = params.effFrom ?? window?.from;
  const effTo = params.effTo ?? window?.to;
  const defaultedRange = !asked && !params.allWeeks && window != null;

  /**
   * Read the recipient columns, not "email1 IS NOT NULL".
   *
   * Addresses are attributed per person inside the trace payload, so the column test both
   * misses addresses and credits the co-insured's to the insured. The campaign mails the
   * INSURED at E1, so coverage has to be measured on the insured or the dashboard
   * promises reach the send will not act on.
   */
  const leads = await sql`
    SELECT "id","cohort","gradeAtPull","grade","manualGrade","status",
           "email1","email2","owner2Email","emailsAll","skipTraceData",
           -- The phone columns are read even though this dashboard counts email reach:
           -- the recipient rules attribute addresses per person from the same payload,
           -- and assertRecipientCols refuses a partial SELECT precisely so a reach figure
           -- cannot come out quietly wrong.
           "phone1","phone2","owner2Phone","phonesAll",
           "owner1FirstName","owner1LastName","owner2FirstName","owner2LastName",
           "quotedPremium","boundPremium","boundDate","lostAt",
           "indicativeBandLow","indicativeBandHigh","publishedBandLow","publishedBandHigh",
           "bandHit","campaignStatus"
      FROM "Lead"
     WHERE "cohort" IS NOT NULL
       AND (${effFrom ?? null}::text IS NULL OR "cohort" >= ${effFrom ?? null})
       AND (${effTo ?? null}::text   IS NULL OR "cohort" <= ${effTo ?? null})` as Record<string, unknown>[];
  assertRecipientCols(leads[0], 'outreach dashboard');

  const gradeNow = (l: Record<string, unknown>) => String(l.manualGrade || l.grade || '');
  const workedRows = leads.filter((l) => gradeNow(l) === 'A');
  const atPull = leads.filter((l) => l.gradeAtPull === 'A').length;
  const worked = workedRows.length;

  /**
   * Grade A is not a closed set. Cards are upgraded INTO it after the pull — the 17 Aug
   * week was pulled with 16 Grade A and holds 39 today — so "Grade A now" is not "Grade A
   * from the pull that survived". Dividing one by the other gives that week a retention
   * of 244%, and across all weeks it quietly inflates the figure the 87% target is read
   * against.
   *
   * So the two are counted apart, exactly as the Cohort Ledger already counts them
   * (stillA / gainedOther). `kept` is what the retention target governs; `worked` is the
   * population everything BELOW this rung is measured against, because a card upgraded
   * into Grade A is worked like any other.
   */
  const kept = leads.filter((l) => l.gradeAtPull === 'A' && gradeNow(l) === 'A').length;
  const gained = worked - kept;
  const withEmail = workedRows.filter((l) => insuredEmails(l).length > 0).length;

  /**
   * ── Verified valid ────────────────────────────────────────────────────────
   *
   * An account counts as verified when ANY of its insured addresses passed — the same rule
   * the cohort ledger applies, deliberately word for word. The campaign sends to one
   * address, and one confirmed address reaches the person; requiring all of them would mark
   * an account unreachable because a stale second address failed.
   *
   * Two screens counting "verified" differently is how the ledger and this dashboard end up
   * quoting different numbers to Frank in the same meeting.
   */
  const deliverable = await deliverableAddresses();
  const verified = workedRows.filter((l) =>
    insuredEmails(l).some((e) => deliverable.has(String(e).trim().toLowerCase()))).length;

  /**
   * Whether the stage has been MEASURED at all, which is not the same as whether it is zero.
   *
   * Nothing had been verified when this was built, so the rung was hardcoded to 0 and
   * "not started" with a note saying no verifier had been chosen. ZeroBounce has since been
   * chosen and 378 verdicts imported — and the stage went on reporting itself unmeasured,
   * because the note was true when it was written and nothing re-read it.
   *
   * Derived from whether any verdict exists at all, so it answers itself from now on.
   */
  const verifierUsed = deliverable.size > 0;

  /**
   * Everything below here comes from OutreachEvent, which is the record of what was
   * actually sent — never from a flag on the Lead. A per-lead flag says "this lead is in
   * a campaign"; the event rows say who was written to, when, and what came back, which
   * is the only thing a delivery or engagement rate can honestly be built from.
   */
  /**
   * ── Grade A only, because the rung above it is ────────────────────────────
   *
   * `loaded` is declared `of: 'with_email'`, so it renders as a percentage of a Grade A
   * rung — but it counted every lead with an outreach event, whatever its grade. On C1
   * that was 160 against 62 Grade A worked, a subset larger than the set it is drawn
   * from, and the same mismatch ran down every rung below it.
   *
   * The Grade B sends are real and correctly recorded; they simply are not part of a
   * Grade A funnel. Reporting them here made both numbers unusable rather than either
   * one informative.
   */
  const [ev] = await sql`
    SELECT
      -- Recipients, not cards. See the unit note above the rung below.
      COUNT(DISTINCT o."recipientEmail")                            FILTER (WHERE TRUE)                       AS loaded,
      COUNT(DISTINCT o."recipientEmail")                            FILTER (WHERE o."sentAt" IS NOT NULL)     AS emailed,
      -- Observed where the platform reports it, derived as "sent and not bounced" where it
      -- does not — which is every message today, because the platform has no delivery
      -- event at all. See the delivered rung's note below.
      COUNT(DISTINCT o."recipientEmail")                            FILTER (WHERE o."deliveredAt" IS NOT NULL
                                                                            OR (o."sentAt" IS NOT NULL
                                                                            AND o."bouncedAt" IS NULL)) AS delivered,
      COUNT(DISTINCT o."recipientEmail")                            FILTER (WHERE o."repliedAt" IS NOT NULL
                                                                            OR o."clickedAt" IS NOT NULL)     AS engaged,
      -- Bounces, complaints and unsubscribes are deliberately NOT counted here: they are
      -- playbook §08 metrics with enforced thresholds, and this screen quotes the service
      -- that owns them rather than deriving a second, softer copy.
      COUNT(*) FILTER (WHERE o."sentAt" IS NOT NULL)::int                                                     AS sends
      FROM "OutreachEvent" o
      JOIN "Lead" l ON l."id" = o."leadId"
     WHERE COALESCE(l."manualGrade", l."grade") = 'A'
       AND (${effFrom ?? null}::text IS NULL OR o."cohort" >= ${effFrom ?? null})
       AND (${effTo ?? null}::text   IS NULL OR o."cohort" <= ${effTo ?? null})` as Array<Record<string, unknown>>;

  const n = (v: unknown) => Number(v ?? 0);
  const loaded = n(ev?.loaded);
  const emailed = n(ev?.emailed);
  const delivered = n(ev?.delivered);
  const engaged = n(ev?.engaged);
  const sends = n(ev?.sends);

  /**
   * Quotes and binds are counted over every card in range, not over the ones still graded
   * A. A lead quoted in week one and downgraded in week three was still quoted, and the
   * bind is still revenue; dropping it from the numerator would understate the funnel.
   *
   * They must use the SAME population as each other. Counting binds over all cards while
   * counting quotes over current-Grade-A only lets bound exceed quoted the moment one
   * quoted card is downgraded, and the screen would report a close rate above 100%.
   */
  const quoted = leads.filter((l) => l.quotedPremium != null).length;
  const bound = leads.filter((l) => l.boundPremium != null || l.status === 'bound').length;

  const outreachStarted = sends > 0;

  /**
   * Targets and floors, from the tracker's rate guardrails. Where it gives a target and a
   * "floor if engagement lands at 20%", both are carried — a single number would hide
   * which side of the plan a figure sits on.
   */
  const funnel: FunnelStage[] = [
    {
      key: 'at_pull', label: 'Grade A at pull', count: atPull, of: null,
      rate: null, target: null, floor: null, started: atPull > 0,
    },
    {
      /**
       * No target on this rung. The 87% is a RETENTION target and belongs on `kept`,
       * which is the guardrail below; hanging it here would grade a number that upgrades
       * can push past 100%.
       */
      key: 'worked', label: 'Grade A worked (now)', count: worked, of: 'at_pull',
      rate: pct(worked, atPull), target: null, floor: null, started: worked > 0,
      note: gained > 0
        ? `${kept.toLocaleString()} kept from the pull plus ${gained.toLocaleString()} upgraded into Grade A since. Retention against the 87% target is the "Grade A kept" guardrail.`
        : 'All of these were Grade A at pull. Downgrades after pull should be rare and always reason-coded.',
    },
    {
      key: 'with_email', label: 'Cards with an insured email', count: withEmail, of: 'worked',
      rate: pct(withEmail, worked), target: 90, floor: 82, started: withEmail > 0,
      note: 'Measured on the named insured, because E1 mails the insured only.',
    },
    {
      key: 'verified', label: 'Verified valid', count: verified, of: 'with_email',
      rate: verifierUsed ? pct(verified, withEmail) : null,
      target: 85, floor: 77,
      started: verifierUsed,
      /**
       * Unverified is NOT the same as failed, and the note has to say so. Most of the gap
       * is addresses nobody has submitted yet — 616 across insured #2, #3 and co-insured
       * were never sent to the verifier — not addresses that came back bad.
       */
      note: verifierUsed
        ? 'An account counts once any of its insured addresses passed ZeroBounce — the same '
          + 'rule the cohort ledger uses. The gap to "cards with an insured email" is mostly '
          + 'addresses not yet submitted to the verifier, not addresses that failed.'
        : 'No verification results imported yet — this stage is unmeasured, not zero. '
          + 'Import a result file under Verification.',
    },
    {
      /**
       * ── The rung where cards become people ──────────────────────────────
       *
       * Everything above counts CARDS; everything from here down counts RECIPIENTS, and
       * the two are not the same because the co-insured is mailed in their own right. On
       * C1, 55 Grade A cards carry 103 addresses — 86 insured and 27 co-insured.
       *
       * This counted cards while "People emailed" below it counted addresses, and
       * divided one into the other: C1 read 55 loaded and 74 emailed, a rate of 135%.
       * Counting recipients here puts the whole lower funnel in one unit, and the rate
       * against `with_email` becomes the honest "how many people are we reaching per
       * emailable card", which is above 100% by design and says so.
       *
       * The label carries the unit, because a number whose unit changes mid-column is
       * only readable if the column admits it.
       */
      key: 'loaded', label: 'Recipients loaded to campaign', count: loaded, of: 'with_email',
      rate: pct(loaded, withEmail), target: 100, floor: null, started: loaded > 0,
      note: 'Addresses in the sequence, not cards — the insured and the co-insured are '
        + 'each a recipient, so this runs above the card count wherever a co-insured is '
        + 'being mailed. Every emailable card should be represented.',
    },
    {
      key: 'emailed', label: 'People emailed (E1)', count: emailed, of: 'loaded',
      rate: pct(emailed, loaded), target: null, floor: null, started: emailed > 0,
      note: 'Stamped in the send log when the lead is pushed to the campaign platform, so '
        + 'this tracks loading closely. Delivered, below, is the honest measure of reach.',
    },
    {
      key: 'delivered', label: 'People delivered', count: delivered, of: 'emailed',
      rate: pct(delivered, emailed), target: null, floor: null, started: delivered > 0,
      /**
       * The rung everything below is measured against, and the one that was silently
       * unmeasurable: until 24 Sep 2026 the webhook classified a delivery event as a send,
       * so nothing ever wrote deliveredAt. Anything sent before that fix has no delivery
       * record, because the event that would have filled it was discarded on arrival.
       */
      note: 'Sent and not bounced. The campaign platform reports no delivery events — none '
        + 'of its analytics fields mentions delivery — so this is derived rather than '
        + 'observed, and inbox placement is what catches a silent drop.',
    },
    {
      key: 'engaged', label: 'Positive engagements', count: engaged, of: 'delivered',
      rate: pct(engaged, delivered), target: 27, floor: 18, started: engaged > 0,
      note: 'The v12 thesis. Below ~18% for three straight cohorts triggers the Pivot Plan.',
    },
    {
      key: 'quoted', label: 'Firm bindable quotes', count: quoted, of: 'engaged',
      rate: pct(quoted, engaged), target: 65, floor: null, started: quoted > 0,
    },
    {
      key: 'bound', label: 'Bound accounts', count: bound, of: 'quoted',
      rate: pct(bound, quoted), target: 32, floor: 32, started: bound > 0,
      note: 'Playbook close rate 25–40%; floor ~32% if engagement lands at 20%.',
    },
  ];

  const bandsMeasured = leads.filter((l) => l.bandHit != null).length;
  const bandHits = leads.filter((l) => l.bandHit === true).length;

  /**
   * The four deliverability guards come from the §08 protective-metrics service, not from
   * a second derivation here.
   *
   * This dashboard originally computed its own hard-bounce, complaint and unsubscribe
   * rates and carried NO target for any of them, plus an inbox-placement target of 75 —
   * which is the PAUSE threshold, not the target. The result was a screen that reported a
   * campaign on the pause line as meeting its goal, and three rates rendered as "no
   * target" while protectiveMetrics would have paused sending over the same numbers.
   *
   * Those thresholds are playbook §08, they are enforced by enforceMetrics(), and a
   * reporting screen has no business holding a softer copy of them. Two numbers under one
   * name is the defect this project keeps paying for.
   *
   * They are measured over a rolling window and across ALL sending, so they do not follow
   * the renewal-week range the rest of this screen uses. Each one says so in `scope`,
   * because a guardrail whose period is unstated is a guardrail nobody can act on.
   */
  const metrics = await computeMetrics({ windowDays: PROTECTIVE_WINDOW_DAYS });
  const reading = (k: string) => metrics.readings.find((r) => r.key === k);
  const rollingScope = `Last ${metrics.windowDays} days, all sending (§08)`;

  /** Map a §08 reading onto this screen's guardrail shape, thresholds intact. */
  const fromMetric = (
    key: string,
    metricKey: string,
    label: string,
    direction: 'higher' | 'lower',
    scope: string,
  ): Guardrail => {
    const r = reading(metricKey);
    return {
      key,
      label,
      value: r?.value ?? null,
      target: r?.target ?? null,
      pauseAt: r?.pauseAt ?? null,
      breached: r?.breached ?? false,
      needsAttention: r?.needsAttention ?? null,
      scope,
      pause: r ? `Pause ${direction === 'higher' ? 'below' : 'at or above'} ${r.pauseAt}%.` : null,
      direction,
      // A rate with no sends behind it is not a measurement. Placement is different: it is
      // a seed test, so it counts as measured the moment a reading exists at any volume.
      started: r != null && r.value != null,
      definition: r?.note ?? '',
    };
  };

  const guardrails: Guardrail[] = [
    {
      key: 'kept', label: 'Grade A kept after pull', value: pct(kept, atPull),
      target: 87, pauseAt: null, breached: false, needsAttention: null, scope: 'Selected renewal weeks',
      pause: null, direction: 'higher', started: atPull > 0,
      definition: 'Still Grade A ÷ Grade A at pull. Counts only cards that were Grade A at '
        + 'the pull, so an upgrade into Grade A cannot flatter retention.',
    },
    {
      key: 'gained', label: 'Upgraded into Grade A after pull', value: gained,
      target: null, pauseAt: null, breached: false, needsAttention: null, scope: 'Selected renewal weeks',
      pause: null, direction: 'higher', started: worked > 0,
      definition: 'A count, not a rate — cards that were not Grade A at pull and are now. '
        + 'They are worked like any other, but they are not retention.',
    },
    {
      key: 'coverage', label: 'Email coverage', value: pct(withEmail, worked),
      target: 90, pauseAt: null, breached: false, needsAttention: null, scope: 'Selected renewal weeks',
      pause: null, direction: 'higher', started: worked > 0,
      definition: 'Cards with an insured email ÷ Grade A worked. Floor ~82%.',
    },
    {
      /**
       * Armed by loading having begun, not by there being emailable cards.
       *
       * Keyed on `withEmail > 0` this reads "781 cards not loaded, off plan" before the
       * campaign exists — when every emailable card is unloaded by definition and none of
       * it is a finding. A guardrail that is red on day one is one nobody looks at on the
       * day it turns red for a reason.
       */
      key: 'not_loaded', label: 'Emailable cards not loaded',
      value: Math.max(0, withEmail - loaded),
      target: 0, pauseAt: null, breached: false, needsAttention: null, scope: 'Selected renewal weeks',
      pause: null, direction: 'lower', started: loaded > 0,
      definition: 'A count, not a rate — every emailable card belongs in the sequence. '
        + 'Measured once loading has begun.',
    },
    {
      key: 'delivery', label: 'Delivery rate', value: pct(delivered, emailed),
      target: null, pauseAt: null, breached: false, needsAttention: null, scope: 'Selected renewal weeks',
      pause: null, direction: 'higher', started: emailed > 0,
      definition: 'Delivered ÷ emailed.',
    },
    fromMetric('inbox', 'inbox_placement', 'Inbox placement — Primary (seed test)', 'higher',
      'Latest seed test, whatever its age'),
    fromMetric('hard_bounce', 'bounce_rate', 'Bounce rate', 'lower', rollingScope),
    fromMetric('complaints', 'complaint_rate', 'Spam complaint rate', 'lower', rollingScope),
    fromMetric('unsub', 'unsubscribe_rate', 'Unsubscribe rate', 'lower', rollingScope),
    {
      key: 'engagement', label: 'Positive engagement', value: pct(engaged, delivered),
      target: 27, pauseAt: 18, breached: false, needsAttention: null, scope: 'Selected renewal weeks',
      pause: 'Below ~18% for three straight cohorts → Pivot Plan.',
      direction: 'higher', started: delivered > 0,
      definition: 'Quote/savings click or interested reply ÷ delivered.',
    },
    {
      key: 'band_hit', label: 'Band-hit rate', value: pct(bandHits, bandsMeasured),
      target: null, pauseAt: null, breached: false, needsAttention: null, scope: 'Selected renewal weeks',
      pause: null, direction: 'higher', started: bandsMeasured > 0,
      definition: 'Bound premium inside the indicative band ÷ binds that got a band.',
    },
    {
      key: 'lead_to_bind', label: 'Lead-to-bind', value: pct(bound, worked),
      target: 2.6, pauseAt: null, breached: false, needsAttention: null, scope: 'Selected renewal weeks',
      pause: null, direction: 'higher', started: bound > 0,
      definition: 'Bound ÷ Grade A worked. The v12 model expects ~2.6%.',
    },
    {
      /** Frank calls this the verdict metric, so it is last and it is per thousand. */
      key: 'bound_per_1k', label: 'Bound per 1,000 people emailed',
      value: emailed > 0 ? Math.round((bound / emailed) * 1000 * 10) / 10 : null,
      target: null, pauseAt: null, breached: false, needsAttention: null, scope: 'Selected renewal weeks',
      pause: null, direction: 'higher', started: emailed > 0,
      definition: 'The verdict metric — bound ÷ people emailed × 1,000.',
    },
  ];

  // Per cohort, so a week that is drifting is visible before the average hides it.
  const byCohortMap = new Map<string, DashboardCohort>();
  for (const l of leads) {
    const key = String(l.cohort);
    const c = byCohortMap.get(key) ?? {
      cohort: key, label: cohortLabel(key),
      atPull: 0, kept: 0, gained: 0, worked: 0, withEmail: 0, loaded: 0,
      emailed: 0, delivered: 0, engaged: 0, quoted: 0, bound: 0,
    };
    if (l.gradeAtPull === 'A') c.atPull++;
    if (gradeNow(l) === 'A') {
      c.worked++;
      if (l.gradeAtPull === 'A') c.kept++; else c.gained++;
      if (insuredEmails(l).length > 0) c.withEmail++;
    }
    // Outside the grade test, for the reason given at the totals above.
    if (l.quotedPremium != null) c.quoted++;
    if (l.boundPremium != null || l.status === 'bound') c.bound++;
    byCohortMap.set(key, c);
  }

  /*
   * ── Delivered, derived here exactly as the funnel above derives it ────────
   *
   * This read `deliveredAt IS NOT NULL` on its own while the funnel twenty lines up
   * already fell back to "sent and not bounced". The platform emits no delivery event at
   * all — deliveredAt has never been written on any row, ever — so this column was zero
   * for every week on the screen while the funnel above it reported a real number. Two
   * definitions of one word on one page, and the per-week one could only ever read nil.
   *
   * Same expression, same meaning, and it still prefers a real deliveredAt if the
   * platform ever starts sending one.
   */
  /**
   * ── Grade A only, because every column to the left of these already is ────
   *
   * This counted every lead with an outreach event, whatever its grade, while Grade A at
   * pull, kept, worked and with-insured-email beside it count Grade A. One row, two
   * populations, read as a funnel: C1 showed 62 worked and 160 loaded, which cannot
   * happen if loaded is a subset. The extra were the Grade B sends — 105 on C1, 125 on
   * C2, 116 on C3 — real sends, correctly recorded, on the wrong row.
   *
   * Four Grade D leads on C2 and seven on C7 were also sitting in here, which is a
   * separate question about how they reached a campaign at all.
   *
   * Grade B outreach is not lost by this; it is simply not reported inside a Grade A
   * ladder. If it needs its own numbers it needs its own table, the way the co-insured
   * did — counting it here only ever made both numbers unusable.
   *
   * COALESCE(manualGrade, grade) is the same test every other screen grades by, so a
   * producer's override is honoured here too.
   */
  const perCohortEvents = await sql`
    SELECT o."cohort",
           COUNT(DISTINCT o."recipientEmail")                                           AS loaded,
           COUNT(DISTINCT o."recipientEmail") FILTER (WHERE o."sentAt" IS NOT NULL)      AS emailed,
           COUNT(DISTINCT o."recipientEmail") FILTER (WHERE o."deliveredAt" IS NOT NULL
                                                        OR (o."sentAt" IS NOT NULL
                                                        AND o."bouncedAt" IS NULL))      AS delivered,
           COUNT(DISTINCT o."recipientEmail") FILTER (WHERE o."repliedAt" IS NOT NULL
                                                        OR o."clickedAt" IS NOT NULL)    AS engaged
      FROM "OutreachEvent" o
      JOIN "Lead" l ON l."id" = o."leadId"
     WHERE o."cohort" IS NOT NULL
       AND COALESCE(l."manualGrade", l."grade") = 'A'
     GROUP BY o."cohort"` as Array<Record<string, unknown>>;
  for (const e of perCohortEvents) {
    const c = byCohortMap.get(String(e.cohort));
    if (!c) continue;
    c.loaded = n(e.loaded); c.emailed = n(e.emailed);
    c.delivered = n(e.delivered); c.engaged = n(e.engaged);
  }

  /**
   * What the default left out, measured the same way the funnel measures what it kept.
   *
   * Only computed when the range WAS defaulted: if the user picked a range, the weeks
   * outside it are their choice and reporting them as "excluded" would be noise.
   */
  let excluded: ExcludedWeeks | null = null;
  if (defaultedRange && effFrom && effTo) {
    const outside = await sql`
      SELECT "cohort",
             COUNT(*) FILTER (WHERE "gradeAtPull" = 'A')::int AS at_pull,
             COUNT(*) FILTER (WHERE COALESCE("manualGrade", "grade") = 'A')::int AS worked
        FROM "Lead"
       WHERE "cohort" IS NOT NULL AND ("cohort" < ${effFrom} OR "cohort" > ${effTo})
       GROUP BY "cohort"
      HAVING COUNT(*) FILTER (WHERE COALESCE("manualGrade", "grade") = 'A') > 0
       ORDER BY "cohort"` as Array<Record<string, unknown>>;

    if (outside.length > 0) {
      /**
       * withEmail has to be counted on the leads themselves: reach is decided by
       * insuredEmails() over the recipient columns, not by a column test, and a SQL
       * "email1 IS NOT NULL" here would disagree with the same figure inside the window.
       */
      const outsideLeads = await sql`
        SELECT "email1","email2","owner2Email","emailsAll","skipTraceData",
               "phone1","phone2","owner2Phone","phonesAll",
               "owner1FirstName","owner1LastName","owner2FirstName","owner2LastName"
          FROM "Lead"
         WHERE "cohort" IS NOT NULL AND ("cohort" < ${effFrom} OR "cohort" > ${effTo})
           AND COALESCE("manualGrade", "grade") = 'A'` as Record<string, unknown>[];
      assertRecipientCols(outsideLeads[0], 'outreach dashboard (excluded weeks)');

      excluded = {
        cohorts: outside.length,
        atPull: outside.reduce((a2, r) => a2 + n(r.at_pull), 0),
        worked: outside.reduce((a2, r) => a2 + n(r.worked), 0),
        withEmail: outsideLeads.filter((l) => insuredEmails(l).length > 0).length,
        labels: outside.map((r) => cohortLabel(String(r.cohort))),
      };
    }
  }

  // Deliberately unfiltered: these bound the date pickers, so they must describe the whole
  // book rather than whatever slice is on screen.
  const [bounds] = await sql`
    SELECT MIN("cohort") AS first, MAX("cohort") AS last
      FROM "Lead" WHERE "cohort" IS NOT NULL` as Array<Record<string, unknown>>;

  return {
    range: { from: effFrom ?? null, to: effTo ?? null },
    cohortBounds: {
      first: bounds?.first ? String(bounds.first) : null,
      last: bounds?.last ? String(bounds.last) : null,
    },
    defaultedRange,
    window,
    excluded,
    funnel,
    guardrails,
    /**
     * A week with nothing in any column is not reported.
     *
     * Three weeks — 23 Mar, 30 Mar and 20 Apr 2026 — hold 3, 2 and 1 leads between them
     * and not one Grade A. They appeared as full rows of zeros: the table named a renewal
     * week and then had nothing to say about it, which reads as a week that failed rather
     * than a week this screen does not cover.
     *
     * Every column is tested, not just Grade A at pull. C8 has none at pull but 159
     * upgraded in, and a week whose only figure is a single loaded recipient is still a
     * week something happened in. A row is dropped only when the answer to every
     * question on it is zero.
     */
    byCohort: [...byCohortMap.values()]
      .filter((c) => c.atPull || c.kept || c.gained || c.worked || c.withEmail
        || c.loaded || c.emailed || c.delivered || c.engaged || c.quoted || c.bound)
      .sort((a, b) => (a.cohort < b.cohort ? -1 : 1)),
    outreachStarted,
    generatedAt: new Date().toISOString(),
  };
}
