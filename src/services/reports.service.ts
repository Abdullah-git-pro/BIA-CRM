import { sql } from '@/lib/neon';
import { STATUS_FOR_OUTCOME, type CallStatus, type CallOutcome } from '@/lib/callOutcomes';
import { mergeVarsFor } from './mergeVars.service';
import { eligibilityReasonLabel } from '@/types/carrier';
import { compareOwnerNames } from './ownerNameMatch.service';
import { insuredEmails, coInsuredEmails, insuredPhones, coInsuredPhones, coInsuredName, assertRecipientCols } from './recipients.service';
import {
  contactabilityOf, householdReach, channelOf, isDirectMailOnly,
  type Contactability, type Channel,
} from './contactability.service';
import { cohortLabel } from './cohort';
import { classifyGradeChange } from './gradeChangeReason';
import { agencyWebsite } from './mergeVars.service';
import { globalMergeVars } from './globalMergeVars.service';
import { ctaWordings } from './campaignCta.service';
import { subjectTemplates } from './campaignSubject.service';

/**
 * QC / data-validation reports (Frank Jul-2026). The CRM captures producer notes,
 * variance notes, carrier-eligibility overrides and grade overrides — these reports
 * let Frank/Ruben pull that data back out to spot trends without cross-referencing
 * the Travelers portal by hand.
 */
export type QcReportType = 'referral' | 'grade_overrides' | 'keyword' | 'roof_b' | 'type_mismatch' | 'owner_verify' | 'contact_coverage' | 'skiptrace_mismatch' | 'blast_skiptrace' | 'cohort' | 'reachability' | 'call_outcome' | 'emails_insured' | 'emails_all' | 'recapture_log' | 'already_ours' | 'co_insured_verify' | 'coinsured_contact_mix';

export interface QcRow {
  propertyId: string;
  owner: string;
  /**
   * The street line. City and ZIP alone do not identify a property, and every export is
   * ultimately about one: a producer reading a file, or Frank reconciling two of them,
   * needs to see the house, not just the town it is in.
   */
  address: string | null;
  city: string | null;
  zip: string | null;
  effectiveDate: string | null;
  grade: string | null;
  manualGrade: string | null;
  propertyType: string | null;
  travelersEligible: string | null;
  plymouthEligible: string | null;
  /** Structured producer-selected reason (dropdown) — this is what trends are counted on. */
  reason: string | null;
  context: string;        // the matching comment / detail / grade transition
  by: string | null;
  at: string | null;
  // Contact-coverage report only — lets the UI tally the breakdown.
  // On the Renewal Week report these two mean the INSURED's contact details.
  hasPhone?: boolean;
  hasEmail?: boolean;
  hasDob?: boolean;
  isCondo?: boolean;
  /**
   * Renewal Week report — reach split by PERSON.
   *
   * Kept apart because they are not interchangeable: campaigns go to the named insured
   * only, so a co-insured address is reach we hold but do not use. One combined "has
   * email" number hid that entirely.
   */
  hasInsuredEmail?: boolean;
  hasCoInsuredEmail?: boolean;
  hasInsuredPhone?: boolean;
  hasCoInsuredPhone?: boolean;
  /**
   * The actual addresses and numbers, not just whether any exist.
   *
   * A Yes/No column answers "can we reach them" but not "at what", so anyone wanting to
   * check a specific homeowner — or hand the list to someone — had to open every card.
   * Carried on the row so the table and the export show the same values.
   */
  insuredEmailList?: string[];
  coInsuredEmailList?: string[];
  insuredPhoneList?: string[];
  coInsuredPhoneList?: string[];
  /**
   * Who the co-insured addresses belong to.
   *
   * The report carried the co-insured's email but never their name, so an export could
   * not be addressed — there was no way to write "Dear ___" for the second email in the
   * cadence, and no way to tell whether an address belonged to a spouse or to whoever
   * the trace happened to attach.
   */
  coInsuredName?: string | null;
  /** The co-insured as the municipal roll writes them, for side-by-side comparison. */
  rollCoInsured?: string | null;
  /**
   * Grade Changes report only — what the change was FOR (see gradeChangeReason.ts).
   * Lets the downgrades that a better trace could reverse be separated from the ones no
   * amount of tracing will.
   */
  changeCategory?: string;
  // Reachability report only — the UI tallies the cohort summary from these.
  cohort?: string | null;
  /**
   * contactability (directive Sec. 4.1) — how this lead can be reached, as its own
   * dimension rather than a grade. Campaign lists are built from this, never from grade.
   *
   * Measured on the NAMED INSURED, because that is who E1 sends to. `householdReach` is
   * the same question asked of the whole card, which is what the grading rule tests —
   * they differ on 310 leads across C1–C7, so both are carried rather than one being
   * quoted as the other.
   */
  contactability?: Contactability;
  /**
   * Calls & Outcomes report only — where the lead stands on the two things a producer
   * does to it. Derived, never stored: the card derives the same values on read, and a
   * cached copy would be the first thing to go stale.
   */
  callStatus?: CallStatus;
  callAttempts?: number;
  /** Distinct DAYS dialled — half of Frank's Sec. 10.5 stop rule, and not the same as attempts. */
  callDays?: number;
  callLastOutcome?: string | null;
  quoteStage?: 'not_rated' | 'rated' | 'quoted' | 'sold' | 'lost';
  quotedPremium?: number | null;
  boundPremium?: number | null;
  lostReason?: string | null;
  householdReach?: Contactability;
  /** Which queue works this lead: email campaign, Ruben's calls, or the post. */
  channel?: Channel;
  /** Nothing anywhere on the card — the direct-mail segment. Flagged, never regraded. */
  directMailOnly?: boolean;
  /**
   * Recapture Log only (Frank, fix 22) — read from RecaptureLog, never recomputed.
   *
   * These are what was true at the MOMENT the account came back. Deriving them now from
   * the Lead would answer a different question: the account has since been re-graded, its
   * send list may have been rebuilt, and the status it held before is gone. The whole
   * point of the log is that the event survives the record moving on.
   */
  /**
   * Email-list reports only — everything the campaign email merges, under the names the
   * sending tool uses. Carried so an export can be imported and mapped without anything
   * being rebuilt by hand at the other end.
   */
  campaignVars?: Record<string, string | number | null>;
  recaptureProcess?: string;
  recaptureHeld?: boolean;
  recaptureNotifiedAt?: string | null;
  priorGrade?: string | null;
  priorStatus?: string | null;
  /** Addresses belonging to the named insured — exactly what the push would mail. */
  insuredEmailCount?: number;
  /** A co-insured address we hold and do NOT mail, and which the insured set lacks. */
  coInsuredOnly?: boolean;
  // Blast report only — groups the rows of one run.
  runId?: string | null;
  /** Whether Tracerfy matched. Credits are deliberately NOT reported here
   *  (Frank Sep-2026): QC is for data quality, and a per-lead price turns a
   *  coverage review into a spend review. Low balance is surfaced instead. */
  matched?: boolean;
}

export interface QcReportParams {
  carrier?: 'travelers' | 'plymouth' | 'any';
  value?: 'review' | 'ineligible' | 'eligible'; // 'review' == Referral
  /**
   * Who put the lead in this state (Frank, Jul-2026 — "when I filter on referral I want
   * the ones WE did"). The appetite rules flag far more leads than producers actually
   * review, so the two get mixed in one list. A producer-set eligibility always carries
   * a reason code; a system flag never does — that is the distinction, no extra column.
   */
  setBy?: 'any' | 'producer' | 'system';
  q?: string;
  effFrom?: string;
  effTo?: string;
  /**
   * Grade-B roof report only: how old the HOUSE is, in years.
   *
   * Frank, 24 Sep 2026: "The criterion is homes 75 years or newer where an unknown or aged
   * roof is the only disqualifier. Our grading rules were written against the year the
   * house was built, not the age of the roof."
   *
   * Note this is the house's age, not the roof's. Every row in that report has a roof year
   * of NULL — that is what the report selects for — so a roof-year range would return
   * nothing at all. What varies between rows, and what Frank's criterion is written
   * against, is how old the house is.
   */
  ageMin?: number;
  ageMax?: number;
  /**
   * Which grade the email lists are for.
   *
   * 'A' is the wave-one go-live. 'B' is what Frank asked for on 28 Sep: "Email outreach may
   * be more important on these accounts than Grade As since we don't have a band price."
   * They are separate populations sent different copy — a Grade B has no band price and one
   * CTA arm, not two — so this picks one, never both at once.
   */
  grade?: 'A' | 'B';
}

const nm = (r: any) => `${String(r.owner1FirstName ?? '').replace('null', '').trim()} ${String(r.owner1LastName ?? '').trim()}`.trim();
/**
 * Date columns come back in two shapes: effectiveDate and friends are TEXT
 * ('2026-09-11'), while real timestamps (gradeOverrideAt, ownerVerifyAt,
 * blastSkipTracedAt, Activity.createdAt) come back as Date objects. Slicing
 * String(date) yielded 'Fri Sep 11' — wrong, and unsortable. Nobody noticed
 * because the QC table never rendered the "at" column until Sep-2026.
 *
 * Those columns are "timestamp WITHOUT time zone", so the driver hands back a
 * Date already in local terms. toISOString() would re-interpret it as UTC and
 * shift it — an evening run would be reported as the next day. Read the local
 * parts instead.
 */
const iso = (d: any): string | null => {
  if (!d) return null;
  const local = (x: Date) => {
    const pad = (n: number) => String(n).padStart(2, '0');
    return `${x.getFullYear()}-${pad(x.getMonth() + 1)}-${pad(x.getDate())}`;
  };
  if (d instanceof Date) {
    return Number.isNaN(d.getTime()) ? null : local(d);
  }
  const s = String(d);
  // NOTE the backslashes. This was /^d{4}-d{2}-d{2}/ — matching a literal "d" — so no
  // real date ever took this branch. Every TEXT date fell through to `new Date(s)`,
  // which reads a bare 'YYYY-MM-DD' as UTC midnight; local() then rendered it in local
  // time and, west of UTC, handed back the PREVIOUS day. Effective dates were reported
  // and range-filtered one day early in every report, which is invisible unless you
  // reconcile a count against the database.
  if (/^\d{4}-\d{2}-\d{2}/.test(s)) return s.slice(0, 10); // already ISO text
  const parsed = new Date(s);
  return Number.isNaN(parsed.getTime()) ? null : local(parsed);
};
const eligLabel = (v: any) => (v === 'review' ? 'Referral' : v === 'ineligible' ? 'Non-eligible' : v === 'eligible' ? 'Eligible' : (v ?? '—'));

/** Apply an optional effective-date range in JS (row counts are small). */
function inRange(effDate: string | null, from?: string, to?: string): boolean {
  if (!effDate) return !from && !to;
  if (from && effDate < from) return false;
  if (to && effDate > to) return false;
  return true;
}

export async function getQcReport(type: QcReportType, params: QcReportParams = {}): Promise<QcRow[]> {
  const { carrier = 'any', value = 'review', setBy = 'any', q = '', effFrom, effTo } = params;

  let rows: any = [];

  /**
   * ── Recapture Log (Frank, 24 Sep 2026 · fix 22) ───────────────────────────
   *
   * "Recapture Log tab — date, cohort, accounts affected, process, whether Ruben was
   * notified."
   *
   * One row per event, read straight from RecaptureLog. The Lead is joined for the name
   * and address only — everything that describes the event itself comes off the log row,
   * because those facts stop being true on the Lead the moment anything else happens to it.
   *
   * It goes through the ordinary report machinery rather than getting its own table, so it
   * inherits the CSV export, the column tooltips and the date filters. A tab that renders
   * itself is a tab whose export drifts from what is on screen, which this page has already
   * been through once.
   */
  if (type === 'recapture_log') {
    rows = await sql`
      SELECT g."id" AS "eventId", g."cohort" AS "logCohort", g."recapturedAt", g."process",
             g."priorStatus", g."priorGrade", g."newGrade", g."heldFromCohort",
             g."rubenNotifiedAt", g."note",
             l."propertyId", l."owner1FirstName", l."owner1LastName",
             l."addressStreet", l."addressCity", l."addressZip", l."effectiveDate",
             l."grade", l."manualGrade", l."propertyType",
             l."travelersEligible", l."plymouthEligible"
        FROM "RecaptureLog" g
        LEFT JOIN "Lead" l ON l."id" = g."leadId"
       ORDER BY g."recapturedAt" DESC`;

    const PROC: Record<string, string> = {
      tracerfy: 'Tracerfy skip trace',
      batchdata: 'BatchData skip trace',
      grade_change: 'Re-grade',
      manual: 'Entered by hand',
    };
    return (rows as any[])
      // Filtered on the cohort the event was logged against, not the lead's current one:
      // a lead re-dated afterwards must not fall out of a week that already reported.
      .filter((r) => inRange(r.logCohort ?? iso(r.effectiveDate), effFrom, effTo))
      .filter((r) => (!q ? true : [r.propertyId, r.owner1FirstName, r.owner1LastName, r.note]
        .filter(Boolean).join(' ').toLowerCase().includes(q.toLowerCase())))
      .map((r) => ({
        ...rowOf(r, r.note ?? '', PROC[r.process] ?? String(r.process), iso(r.recapturedAt), null),
        cohort: r.logCohort ?? null,
        recaptureProcess: PROC[r.process] ?? String(r.process),
        recaptureHeld: Boolean(r.heldFromCohort),
        recaptureNotifiedAt: iso(r.rubenNotifiedAt),
        priorGrade: r.priorGrade ?? null,
        priorStatus: r.priorStatus ?? null,
      }));
  }

  if (type === 'referral') {
    // Carrier eligibility = Referral (or the requested value) on one/both carriers.
    if (carrier === 'travelers') {
      rows = await sql`SELECT * FROM "Lead" WHERE "travelersEligible" = ${value}`;
    } else if (carrier === 'plymouth') {
      rows = await sql`SELECT * FROM "Lead" WHERE "plymouthEligible" = ${value}`;
    } else {
      rows = await sql`SELECT * FROM "Lead" WHERE "travelersEligible" = ${value} OR "plymouthEligible" = ${value}`;
    }
    // A reason code is only ever written when a producer changes eligibility, so its
    // presence is what separates "we reviewed this" from "the appetite rules flagged it".
    // Only count the reason on the carrier(s) actually in the requested state.
    const producerTouched = (r: any) =>
      (carrier !== 'plymouth' && r.travelersEligible === value && !!r.travelersEligibilityReason)
      || (carrier !== 'travelers' && r.plymouthEligible === value && !!r.plymouthEligibilityReason);
    return rows
      .filter((r: any) => (setBy === 'any' ? true : setBy === 'producer' ? producerTouched(r) : !producerTouched(r)))
      .filter((r: any) => inRange(iso(r.effectiveDate), effFrom, effTo))
      .map((r: any) => {
        // Structured reason (dropdown) is reported on; Detail carries the nuance.
        const reasons: string[] = [];
        const details: string[] = [];
        if (r.travelersEligible === value) {
          if (r.travelersEligibilityReason) reasons.push(`Travelers: ${eligibilityReasonLabel(r.travelersEligibilityReason)}`);
          if (r.travelersEligibilityDetail) details.push(`Travelers — ${r.travelersEligibilityDetail}`);
        }
        if (r.plymouthEligible === value) {
          if (r.plymouthEligibilityReason) reasons.push(`Plymouth: ${eligibilityReasonLabel(r.plymouthEligibilityReason)}`);
          if (r.plymouthEligibilityDetail) details.push(`Plymouth — ${r.plymouthEligibilityDetail}`);
        }
        // Fall back to the system's own carrier note when a producer hasn't set a reason.
        if (!details.length) {
          const sys = (() => {
            try {
              const n = typeof r.travelersNotes === 'string' ? JSON.parse(r.travelersNotes || '[]') : (r.travelersNotes ?? []);
              return (n as string[]).find((x) => !/Meets all/i.test(x)) ?? '';
            } catch { return ''; }
          })();
          if (sys) details.push(sys);
        }
        return rowOf(r, details.join('  |  '), null, null, reasons.join('  |  ') || null);
      });
  }

  /**
   * Accounts already placed with one of our own two carriers.
   *
   * Frank, 1 Oct 2026: "specifically 'currently insured with us' I want all of these
   * accounts flagged — it literally shows the proof of our concept, an account we intended
   * to outreach is already placed with our two carriers."
   *
   * ── Why it reads the free text and not the reason code ───────────────────
   * There is no reason code for this. The dropdown offers prior_loss, underwriting_capacity,
   * fema_flood_adjacent and investor_non_owner_occupied; a producer meeting one of these
   * accounts picks "other" and types what happened. So the fact lives in the detail field,
   * in whatever words were to hand, and the phrasings in the book are:
   *
   *     Currently with Plymouth        x26      Currently insured with PM       x3
   *     Currently w. Plymouth           x3      Currently insured with Plymouth x2
   *     Already with Plymouth           x1      ... and five more one-offs
   *
   * Searching for "currently insured" — the phrase Frank used — finds nine of the
   * forty-two. The dominant wording does not contain the word "insured" at all. Hence the
   * pattern below, which keys on the carrier name next to a word meaning "already".
   *
   * ── Why they are not a dead end ──────────────────────────────────────────
   * Almost every one is Travelers eligible and Plymouth ineligible-or-review: Plymouth
   * declines them BECAUSE the risk is already theirs. So these are not accounts to drop —
   * they are rewrites our other carrier can take, which is exactly the proof Frank means.
   */
  if (type === 'already_ours') {
    rows = await sql`
      SELECT * FROM "Lead"
       WHERE "travelersEligibilityDetail" ~* '(current|already|existing|in ?force)'
          OR "plymouthEligibilityDetail"  ~* '(current|already|existing|in ?force)'` as any[];
    const OURS = /(plymouth|\bpm\b|travelers)/i;
    const ALREADY = /(current|already|existing|in ?force)/i;
    return rows
      .filter((r: any) => {
        const txt = [r.travelersEligibilityDetail, r.plymouthEligibilityDetail].filter(Boolean).join(' | ');
        return ALREADY.test(txt) && OURS.test(txt);
      })
      .filter((r: any) => inRange(iso(r.effectiveDate), effFrom, effTo))
      .map((r: any) => {
        const notes = [
          r.travelersEligibilityDetail ? `Travelers — ${r.travelersEligibilityDetail}` : null,
          r.plymouthEligibilityDetail ? `Plymouth — ${r.plymouthEligibilityDetail}` : null,
        ].filter(Boolean).join('  |  ');
        /**
         * Which carrier could still write it, said plainly. The whole point of the report is
         * the opportunity, and leaving the reader to infer it from two eligibility columns
         * is how a list of forty-two becomes a list nobody works.
         */
        const open = r.travelersEligible === 'eligible' && r.plymouthEligible !== 'eligible'
          ? 'Travelers can still write this'
          : r.plymouthEligible === 'eligible' && r.travelersEligible !== 'eligible'
            ? 'Plymouth can still write this'
            : r.travelersEligible === 'eligible' && r.plymouthEligible === 'eligible'
              ? 'Both carriers eligible'
              : 'Neither carrier eligible';
        return rowOf(r, notes, null, null, open);
      });
  }

  if (type === 'grade_overrides') {
    // BOTH sources: a producer's override and the rules re-grading on re-enrichment.
    //
    // Only the first was ever recorded, which made this report read as "grades barely
    // change" when in truth every system regrade was invisible. grade_system rows are
    // written from Sep-2026 onward; anything the rules changed before that left no
    // trace and cannot be recovered — which is why the drift rows below matter.
    /**
     * Matched on the RECORDED CHANGE, not on the activity type.
     *
     * This used to join a."type" = 'grade_override' and missed most of the data. A
     * grade edited from the lead card is written as a `note` carrying a changes array,
     * and only the dedicated override dialog writes 'grade_override' — so 243 of the
     * 283 A-downgrades in this database were invisible, and the report read as though
     * producers almost never regrade. That is what made a renewal week look like it had
     * lost ~90 Grade A leads: they had been deliberately downgraded, and the evidence
     * was in a row type nobody was looking at.
     *
     * Keying off the metadata means any future writer that records a Grade change shows
     * up here without this query needing to learn its name.
     */
    /**
     * Read from the GradeChange log (register A8), not the activity feed.
     *
     * The commentary above is the history of why: grade changes were scattered across
     * activity types, and matching on the metadata was the workaround. The log is now the
     * single place every change is written — producer and system, with source recorded at
     * the point of change rather than inferred from who happened to be signed in — so this
     * query no longer has to guess.
     *
     * The 360 historical changes were migrated into it, so nothing is lost by no longer
     * reading the feed.
     */
    rows = await sql`
      SELECT l.*,
             g."fromGrade"  AS g_from,
             g."toGrade"    AS g_to,
             g."source"     AS g_source,
             g."reason"     AS a_content,
             g."changedBy"  AS a_by,
             g."changedAt"  AS a_at
      FROM "Lead" l
      JOIN "GradeChange" g ON g."leadId" = l."id"
      ORDER BY g."changedAt" DESC`;
    const recorded: QcRow[] = rows
      .filter((r: any) => inRange(iso(r.effectiveDate), effFrom, effTo))
      .map((r: any) => {
        const transition = `${r.g_from ?? '—'} → ${r.g_to ?? '—'}`;
        // The source is now RECORDED at the moment of the change rather than inferred
        // from whether an author happened to be attached. Inferring it was wrong in both
        // directions: a producer edit with no session attributed to the rules, and a rules
        // change made during a signed-in request attributed to the person.
        const system = r.g_source === 'system';
        const reason = system ? '' : (r.gradeOverrideReason || r.a_content || '');
        return {
          ...rowOf(
            r,
            `${transition}${reason ? ` — ${reason}` : ''}`,
            system ? 'system (rules)' : r.a_by,
            iso(r.a_at),
          ),
          /**
           * The renewal week, so grading changes can be read the way Frank asks for them
           * (fix 20: "with cohort, account count and process").
           *
           * The report carried the effective DATE, which is a different date for every
           * lead — so counting changes per week meant grouping 400 distinct dates by eye.
           * The cohort is the column that lines up with everything else he reads.
           */
          cohort: r.cohort ?? null,
          // The note path records its reason as free text rather than a dropdown code,
          // so fall back to it — otherwise most rows would show no reason at all.
          reason: system
            ? 'System regrade'
            : (r.gradeOverrideReason || (r.a_content ? String(r.a_content).slice(0, 80) : null)),
          // Classified off the CHANGE's own reason, not the lead's current
          // gradeOverrideReason — that column holds the latest override and would
          // mislabel every earlier change on the same lead.
          changeCategory: classifyGradeChange(r.a_content || r.gradeOverrideReason, r.g_source),
        };
      });

    return recorded;
  }

  if (type === 'keyword') {
    const term = q.trim();
    if (!term) return [];
    const like = `%${term}%`;
    rows = await sql`
      SELECT DISTINCT l.*, (
        SELECT string_agg(a."content", ' ¦ ') FROM "Activity" a
        WHERE a."leadId" = l."id" AND a."content" ILIKE ${like}
      ) AS note_hits
      FROM "Lead" l
      WHERE l."varianceNotes" ILIKE ${like}
         OR l."travelersEligibilityReason" ILIKE ${like}
         OR l."plymouthEligibilityReason" ILIKE ${like}
         OR l."gradeOverrideReason" ILIKE ${like}
         OR EXISTS (SELECT 1 FROM "Activity" a WHERE a."leadId" = l."id" AND a."content" ILIKE ${like})`;
    const rx = new RegExp(term.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i');
    const firstMatch = (r: any): string => {
      const candidates = [r.note_hits, r.varianceNotes, r.travelersEligibilityReason, r.plymouthEligibilityReason, r.gradeOverrideReason];
      for (const c of candidates) if (c && rx.test(String(c))) return String(c);
      return r.varianceNotes || r.gradeOverrideReason || '(match in notes)';
    };
    return rows
      .filter((r: any) => inRange(iso(r.effectiveDate), effFrom, effTo))
      .map((r: any) => rowOf(r, firstMatch(r)));
  }

  if (type === 'roof_b') {
    /**
     * Grade-B leads whose only knock is an unconfirmed roof, on a house inside the age band.
     *
     * The upper bound is the part that was missing. The filter tested only "older than 20"
     * with no ceiling, so it returned 941 houses built between 1850 and 1950 — and Frank
     * read the output and said so: "If the filter reads build year we'd be writing to a
     * list of older homes rather than homes with unknown roofs."
     *
     * Both bounds are now the caller's to set, defaulting to the criterion he stated:
     * older than 20, and 75 or newer. The report's own subtitle states them, so nobody has
     * to infer from the rows which band they are looking at.
     */
    /**
     * ── The band is 21 to 76 inclusive, and ageMin is EXCLUSIVE ───────────────
     *
     * Frank, 28 Sep: "the logic we discussed today was homes 21yrs-76 years old, right now
     * it's just showing 20-75 — 20 yrs old is within carrier appetite, older than 20 falls
     * outside."
     *
     * The lower bound was already right: the comparison below is `> ageMin`, so 20 selects
     * homes of 21 and up, which is exactly "older than 20". What was wrong is that every
     * label printed the PARAMETER (20) instead of the band it produces (21), so the screen
     * said 20-75 while the query returned 21-75 — and the only way to notice was to check
     * a row's age by hand.
     *
     * The upper bound was genuinely short by one: 75 where Frank wants 76.
     */
    /**
     * ── Both ends INCLUSIVE, because that is what the boxes say ──────────────
     *
     * The lower bound used to be exclusive: `age > ageMin`. It matched Frank's wording
     * ("older than 20 falls outside") but it meant the "from" box did not mean what it said,
     * and the first person to type Frank's own number into it — 21 — got homes of 22 and up.
     * The screen read "homes 22-76" and the run was quietly a year short at the bottom.
     *
     * A comment explaining a trap is not as good as not having one. 21 now means 21, and
     * the default is 21 rather than a 20 that has to be converted in somebody's head.
     */
    const ageMin = Number.isFinite(params.ageMin) ? Number(params.ageMin) : 21;
    const ageMax = Number.isFinite(params.ageMax) ? Number(params.ageMax) : 76;
    rows = await sql`
      SELECT * FROM "Lead"
      WHERE "grade" = 'B' AND "manualGrade" IS NULL AND "roofYear" IS NULL
        AND ("propertyType" IS NULL OR "propertyType" <> 'CONDO')
        AND ("landUse" IS NULL OR "landUse" NOT ILIKE '%condo%')
        AND "yearBuilt" IS NOT NULL
        AND (EXTRACT(YEAR FROM NOW())::int - "yearBuilt") >= ${ageMin}
        AND (EXTRACT(YEAR FROM NOW())::int - "yearBuilt") <= ${ageMax}
      ORDER BY "yearBuilt" ASC`;
    const year = new Date().getFullYear();
    return rows
      .filter((r: any) => inRange(iso(r.effectiveDate), effFrom, effTo))
      .map((r: any) => {
        const age = r.yearBuilt ? year - Number(r.yearBuilt) : null;
        return rowOf(r, `Home ${age ?? '?'} yrs (built ${r.yearBuilt}) — roof unconfirmed`);
      });
  }

  if (type === 'type_mismatch') {
    // Producer-flagged: REAPI property type looks wrong (e.g. condo that's really a home).
    rows = await sql`SELECT * FROM "Lead" WHERE "propertyTypeMismatch" = true ORDER BY "effectiveDate"`;
    return rows
      .filter((r: any) => inRange(iso(r.effectiveDate), effFrom, effTo))
      .map((r: any) => rowOf(r, `CRM type: ${r.propertyType ?? '—'} — flagged as likely wrong by producer`));
  }

  if (type === 'call_outcome') {
    /**
     * Where every lead stands on the two things a producer actually does to it: the call,
     * and the quote (directive Sec. 10.5, Sec. 10.6, Sec. 10.9).
     *
     * ── Why one report and not two ──────────────────────────────────────────
     * They are one workflow. "Reached — quote requested but never quoted" and "quoted a
     * fortnight ago and neither sold nor lost" are the two questions worth asking of this
     * data, and neither can be asked of the call log or the quote record alone.
     *
     * ── Both states are DERIVED here, from the same rules the card uses ──────
     * callState() and quoteState() run per lead, which would be ~10,000 round trips. So
     * the same logic is expressed once in SQL below. That is a second implementation and
     * therefore a liability, so it is kept deliberately thin: the call status is counted
     * off CallAttempt exactly as callLog.service counts it, and the quote stage reads the
     * same columns quoteOutcomes.service writes. scripts/test-call-quote-report.mjs
     * asserts the two agree lead by lead, so a drift becomes a failing test rather than a
     * report nobody can reconcile.
     */
    rows = await sql`
      WITH attempts AS (
        SELECT "leadId",
               COUNT(*)::int                                            AS tries,
               -- EASTERN days, not UTC ones. attemptedAt holds UTC, so ::date puts a
               -- call placed at 11pm in New Jersey on the following day — splitting one
               -- evening across two, which is what the 3+ day unreachable rule counts.
               COUNT(DISTINCT ("attemptedAt" AT TIME ZONE 'UTC' AT TIME ZONE 'America/New_York')::date)::int AS days,
               MAX("attemptedAt")                                       AS last_at,
               BOOL_OR("outcome" IN ('callback_scheduled','quote_requested',
                                     'not_interested','do_not_call'))   AS reached,
               (ARRAY_AGG("outcome" ORDER BY "attemptedAt" DESC))[1]    AS last_outcome,
               -- The latest outcome that REACHED somebody, which is what the status follows
               -- (Frank, 25 Sep). The plain latest above can be a no-answer placed after the
               -- conversation that decided everything.
               (ARRAY_AGG("outcome" ORDER BY "attemptedAt" DESC)
                  FILTER (WHERE "outcome" IN ('callback_scheduled','quote_requested',
                                              'not_interested','do_not_call')))[1] AS last_reached,
               (ARRAY_AGG("calledBy" ORDER BY "attemptedAt" DESC))[1]   AS last_by
          FROM "CallAttempt" a
          /*
           * The return-to-queue line (migration 046), applied here exactly as callState
           * applies it. A producer who puts a lead back in the queue sets attempts before
           * that moment aside; a report still counting them would show the card as
           * "attempting" while the card itself showed it queued — the two-implementations
           * liability this CTE's own comment warns about, landing on the one feature whose
           * entire purpose is to change what the status says.
           */
          JOIN "Lead" ql ON ql."id" = a."leadId"
         WHERE ql."callQueueReturnedAt" IS NULL
            OR a."attemptedAt" > ql."callQueueReturnedAt"
         GROUP BY a."leadId"
      )
      /*
       * Named columns, not SELECT *.
       *
       * This report reads every workable lead — ~7,800 rows — and a star select carries
       * rawData, a large JSONB blob on each one. It cost eight seconds, which was
       * survivable when only the QC page used it and stopped being survivable when the
       * outreach dashboard's phone funnel started reading the same rows.
       *
       * The reachability report above already names its columns for exactly this reason.
       * Every column below is one the mapper actually reads; adding a field to the output
       * means adding it here too, which is the trade for not shipping the blob.
       */
      SELECT l."id", l."propertyId",
             l."owner1FirstName", l."owner1LastName",
             l."addressStreet", l."addressCity", l."addressZip",
             l."effectiveDate", l."grade", l."manualGrade", l."propertyType",
             l."travelersEligible", l."plymouthEligible",
             l."status", l."quotedPremium", l."quotedAt",
             l."boundPremium", l."boundCarrier", l."boundBy",
             l."lostAt", l."lostReason",
             l."indicativeBandLow", l."indicativeBandHigh",
             l."travelersPremium", l."plymouthPremium",
             COALESCE(a.tries, 0)  AS call_tries,
             a.days                AS call_days,
             a.last_at             AS call_last_at,
             a.reached             AS call_reached,
             a.last_outcome        AS call_last_outcome,
             a.last_by             AS call_last_by
        FROM "Lead" l
        LEFT JOIN attempts a ON a."leadId" = l."id"
       /*
        * Workable grades, OR anything a producer has actually touched.
        *
        * Restricting to A/B/C alone answers "who still needs working" and silently hides
        * every piece of work already done on a lead that has since been downgraded — and
        * a lead is often downgraded BECAUSE of what the call found. Lead 201620523 is
        * exactly that: a call logged as a bad number, a loss recorded, then overridden to
        * D for being a trust. In a report about what producers did, that is the most
        * interesting row there is, and it was the one row being excluded.
        */
       WHERE COALESCE(l."manualGrade", l."grade") IN ('A','B','C')
          OR a."leadId" IS NOT NULL
          OR l."quotedPremium" IS NOT NULL
          OR l."boundPremium" IS NOT NULL
          OR l."lostAt" IS NOT NULL
          -- A loss recorded from the status dropdown sets a reason and no date, so the
          -- lostAt test alone let two Grade D leads marked 'lost' fall out of a report
          -- about what producers did. Same fault as lead 201620523 above, one field over.
          OR l."lostReason" IS NOT NULL
          OR l."status" = 'lost'
          OR l."indicativeBandLow" IS NOT NULL
          -- A card a carrier has priced belongs in a report about rating, whatever
          -- its grade. Without this the fixed test above never sees it.
          OR l."travelersPremium" IS NOT NULL
          OR l."plymouthPremium" IS NOT NULL
       ORDER BY l."effectiveDate"`;

    return rows
      .filter((r: any) => inRange(iso(r.effectiveDate), effFrom, effTo))
      .map((r: any) => {
        /**
         * The same ladder as callLog.service: reached wins, then the unreachable rule,
         * then any attempt at all. `unreachable` is Frank's Sec. 10.5 stop rule — four
         * attempts across three or more distinct days — and it is checked here rather
         * than inferred from a count, because "four attempts in one afternoon" is not
         * the same thing and treating it as such would retire a live lead.
         */
        const tries = Number(r.call_tries ?? 0);
        const days = Number(r.call_days ?? 0);
        /**
         * The status follows the latest REACHING outcome — the same mapping the call panel
         * uses, imported rather than restated. Two derivations of one rule is how this
         * report and the card come to disagree about the same lead.
         */
        const callStatus: CallStatus = (r.last_reached
          ? STATUS_FOR_OUTCOME[r.last_reached as CallOutcome]
          : undefined)
          ?? ((tries >= 4 && days >= 3) ? 'unreachable'
            : tries ? 'attempting' : 'not_attempted');

        /**
         * Terminal states first. A lead that sold and was also once quoted is SOLD — the
         * later fact is the true one, and ordering these by recency rather than by
         * precedence would report the same lead differently depending on what it did
         * last.
         */
        /**
         * Lost is lostAt OR lostReason, because there are two ways to record one.
         *
         * The outcome panel calls recordLoss() and stamps lostAt. The lead card's own
         * status dropdown sets status 'lost' and a reason and does NOT stamp it — two real
         * leads are in exactly that state. quoteState() on the card tests both, so testing
         * only lostAt here made this report disagree with the card it describes, and the
         * suite that checks for that drift never sampled a lead with a reason and no date.
         */
        const quoteStage = r.boundPremium != null || r.status === 'bound' ? 'sold'
          : (r.lostAt != null || r.lostReason != null) ? 'lost'
            : r.quotedPremium != null ? 'quoted'
              /*
               * Rated means a carrier priced it. Nothing else.
               *
               * This tested indicativeBandLow AND indicativeBandHigh, which are stored
               * columns almost nothing fills: on 1 Oct the QC report called 0 of 655
               * C4-C7 Grade A cards rated while 417 of them carried a carrier premium.
               * The band is derived from the premium now, so testing the band here asked
               * whether somebody had typed one in by hand.
               *
               * Frank, 1 Oct 2026: "Rated means a carrier premium exists. Nothing else."
               * The export on line ~870 of this same file already read it that way, so
               * two reports over one table disagreed about how many leads were rated.
               */
              : (r.travelersPremium != null || r.plymouthPremium != null) ? 'rated'
                : 'not_rated';

        const bits = [
          `Call: ${callStatus.replace('_', ' ')}`,
          tries ? `${tries} attempt${tries === 1 ? '' : 's'} over ${days} day${days === 1 ? '' : 's'}` : null,
          r.call_last_outcome ? `last: ${String(r.call_last_outcome).replace(/_/g, ' ')}` : null,
          `Quote: ${quoteStage.replace('_', ' ')}`,
          r.quotedPremium != null ? `quoted $${r.quotedPremium}` : null,
          r.boundPremium != null ? `sold $${r.boundPremium}${r.boundCarrier ? ` with ${r.boundCarrier}` : ''}` : null,
          r.lostReason ? `lost: ${r.lostReason}` : null,
        ].filter(Boolean);

        const row = rowOf(
          r, bits.join(' · '),
          r.call_last_by ?? r.boundBy ?? null,
          iso(r.call_last_at) ?? iso(r.quotedAt) ?? null,
          /**
           * The producer-chosen loss reason, or nothing.
           *
           * This first carried `${callStatus}|${quoteStage}`, which put "not_attempted|
           * not_rated" in the Reason column of every untouched row — machine vocabulary,
           * on screen, next to the Call Status and Quote Stage columns that already say
           * the same thing properly. Reason means a reason somebody gave; where nobody
           * gave one it should be blank.
           */
          r.lostReason ?? null,
        );
        return {
          ...row,
          callStatus,
          callAttempts: tries,
          callDays: days,
          callLastOutcome: (r.call_last_outcome as string) ?? null,
          quoteStage,
          quotedPremium: r.quotedPremium == null ? null : Number(r.quotedPremium),
          boundPremium: r.boundPremium == null ? null : Number(r.boundPremium),
          lostReason: r.lostReason ?? null,
        };
      });
  }

  if (type === 'skiptrace_mismatch') {
    // Frank Aug-2026: leads where the skip-trace insured name disagrees with the on-file
    // name. Producers override per-lead from the card; this lists them for carrier-portal QC.
    rows = await sql`SELECT * FROM "Lead" WHERE "skipTraceOwnerName" IS NOT NULL AND "skipTraceOwnerName" <> '' ORDER BY "effectiveDate"`;
    return rows
      .filter((r: any) => {
        const c = compareOwnerNames({ first: r.owner1FirstName, last: r.owner1LastName }, String(r.skipTraceOwnerName));
        return c.result === 'mismatch';
      })
      .filter((r: any) => inRange(iso(r.effectiveDate), effFrom, effTo))
      .map((r: any) => rowOf(r, `On file "${nm(r) || '—'}" → skip trace "${r.skipTraceOwnerName}"`));
  }

  if (type === 'blast_skiptrace') {
    // Frank Sep-2026: which leads were traced by a cohort BLAST rather than by a
    // producer clicking the card, when, by whom, and what each one actually returned.
    //
    // blastSkipTracedAt is the whole definition — it is written only by the blast
    // (migration 016), so the card button can never appear here. deepSkipTracedAt
    // cannot answer this: both routes set it.
    /**
     * ── Waiting as well as done ───────────────────────────────────────────
     *
     * This selected only blastSkipTracedAt, so the report answered "what has the blast
     * traced". That was the whole feature until leads could be QUEUED for a blast from the
     * QC screen — and a queued lead has no trace stamp, so it appeared nowhere. Somebody
     * moving 2,681 leads into the blast would press the button, open this report, and see
     * exactly what was there before.
     *
     * A queue nobody can look at is indistinguishable from a button that did nothing.
     *
     * Waiting rows sort FIRST. They are the ones with a decision still attached — whether
     * to spend the credits — where a traced row is history.
     */
    rows = await sql`
      SELECT * FROM "Lead"
       WHERE "blastSkipTracedAt" IS NOT NULL OR "blastQueuedAt" IS NOT NULL
       ORDER BY ("blastSkipTracedAt" IS NOT NULL), "blastQueuedAt" DESC, "blastSkipTracedAt" DESC`;
    return rows
      .filter((r: any) => inRange(iso(r.effectiveDate), effFrom, effTo))
      .map((r: any) => {
        const hasPhone = !!(String(r.phone1 ?? '').trim() || String(r.phone2 ?? '').trim());
        const hasEmail = !!(String(r.email1 ?? '').trim() || String(r.email2 ?? '').trim());
        const coInsured = [r.owner2FirstName, r.owner2LastName].filter(Boolean).join(' ');
        // A stored payload with hit=true is the only honest record of a charge: the
        // blast bills 15 on a match and nothing on a miss.
        const matched = (r.skipTraceData as any)?.hit === true;
        const got = [hasPhone ? 'phone' : null, hasEmail ? 'email' : null, coInsured ? `co-insured ${coInsured}` : null]
          .filter(Boolean).join(' + ');
        const context = matched
          ? `Matched — ${got || 'no contact returned'}`
          : 'No match';
        /**
         * A queued lead has not been traced, so "No match" would be a lie — it says we
         * looked and found nothing. It is waiting to be looked at.
         */
        const waiting = r.blastSkipTracedAt == null && r.blastQueuedAt != null;
        const row = waiting
          ? rowOf(r, `Waiting in the Grade ${r.blastQueueGrade ?? '?'} queue — not traced yet`,
              r.blastQueuedBy ?? null, iso(r.blastQueuedAt))
          : rowOf(r, context, r.blastSkipTracedBy ?? null, iso(r.blastSkipTracedAt));
        return {
          ...row,
          // Short, stable label so rows from one run read as one run in the table.
          reason: waiting
            ? (r.blastQueueReason ?? 'Queued')
            : (r.blastRunId ? `Run ${String(r.blastRunId).slice(0, 8)}` : null),
          runId: r.blastRunId ?? null,
          hasPhone,
          hasEmail,
          // A waiting row has not been charged and has not matched. Forcing it false keeps
          // it out of the hit counts, which are a record of money spent.
          matched: waiting ? false : matched,
          /**
           * Which blast this lead belongs to, and whether it has run.
           *
           * queueGrade is read from blastQueueGrade, NOT from the lead's grade. It is the
           * queue the lead was put in; a re-grade afterwards must not move it between two
           * runs with different economics.
           */
          queueGrade: (r.blastQueueGrade ?? null) as 'A' | 'B' | null,
          queueState: waiting ? 'waiting' : (r.blastQueuedAt ? 'traced' : 'traced_unqueued'),
        };
      });
  }

  if (type === 'emails_insured' || type === 'emails_all') {
    /**
     * The two go-live email lists (Frank, 23 Sep 2026).
     *
     * "Two email export reports for C1-C3 (Oct 5-25): insured emails, and insured or
     * co-insured emails."
     *
     * -- Why two reports and not one with a column --------------------------
     * They are different populations, and the difference is the decision. E1 mails the
     * named insured; a co-insured address is reach the CRM holds and the campaign does not
     * currently use. Frank asked for both so he can see what the insured-only rule costs in
     * reach before the first send, and a single list with a "whose address" column makes
     * that a spreadsheet exercise rather than two numbers.
     *
     * -- The insured list is a SUBSET of the other, by construction ----------
     * `emails_all` returns every lead `emails_insured` returns, plus the leads reachable
     * only at the co-insured. Built by widening the same filter rather than by a separate
     * query, so the two can never describe different populations of the same week.
     *
     * -- Addresses come from the recipient rules, never from the columns -----
     * A trace attributes addresses per person inside its payload, so `email1 IS NOT NULL`
     * both misses addresses and credits the co-insured's to the insured. That mismatch is
     * what had two tabs of this CRM reporting 95 and 93 mailable for the same week.
     */
    const from = effFrom || null;
    const to = effTo || null;
    rows = await sql`
      SELECT "propertyId", "owner1FirstName", "owner1LastName",
             "addressStreet", "addressCity", "addressZip",
             "effectiveDate", "cohort", "grade", "manualGrade", "propertyType",
             "travelersEligible", "plymouthEligible",
             "travelersPremium", "plymouthPremium",
             "email1", "email2", "owner2Email", "skipTraceData", "emailsAll",
             "phone1", "phone2", "owner2Phone",
             "owner2FirstName", "owner2LastName",
             -- The campaign assignment, so the export carries the merge fields the sending
             -- tool needs rather than only the addresses. Without these the file has to be
             -- joined to something else before it can be imported, which is where the
             -- renewal date got rebuilt by hand and came out a day early.
             "id", "campaignSegment", "insuredSubjectVariant", "insuredCtaArm",
             "coInsuredSubjectVariant", "coInsuredCtaArm", "addressState", "ratedSource"
        FROM "Lead"
       WHERE "effectiveDate" IS NOT NULL
         AND (${from}::text IS NULL OR left("effectiveDate", 10) >= ${from})
         AND (${to}::text   IS NULL OR left("effectiveDate", 10) <= ${to})
       ORDER BY "cohort", "addressCity", "owner1LastName"`;
    // Same guard as the reachability report, for the same reason: a hand-written column
    // list feeding the recipient rules is the one thing that can silently drift from them.
    assertRecipientCols(rows[0], `${type} report`);

    const insuredOnly = type === 'emails_insured';
    /**
     * ── The export has to be fed what the push is fed ────────────────────────
     *
     * The comment below has long claimed this is "built by the SAME function the push
     * uses", and it is — but it was being called with none of the function's inputs: no
     * agency website, no shared variables, no CTA wordings. Same function, different
     * arguments, different answer.
     *
     * It showed the moment the CTAs became editable. The asks were changed on the CTA
     * screen and this export went on printing the old compiled wording, complete with the
     * arm 1 / arm 2 split that no longer exists — so the file Zoya works from disagreed
     * with what the campaign would actually send, which is the one thing an export of the
     * send list must never do.
     */
    const [site, globals, ctas, subjects] = await Promise.all([
      agencyWebsite(), globalMergeVars(), ctaWordings(), subjectTemplates(),
    ]);
    return rows
      .filter((r: any) => inRange(iso(r.effectiveDate), effFrom, effTo))
      /**
       * One grade per file, and never a mix.
       *
       * These lists go straight to a sending tool, so the grade is not a column somebody
       * filters later — it decides which COPY the row receives. A Grade A carries a band
       * price and two CTA arms; a Grade B has no band price at all and a single arm
       * (§3, "R4 · Single arm, wave two"). Putting both in one file means one of the two
       * populations gets an email written for the other, and the file would look fine.
       *
       * Defaults to A, so a saved link or bookmark from before this option existed keeps
       * returning exactly what it returned before.
       */
      .filter((r: any) => String(r.manualGrade || r.grade || '') === (params.grade ?? 'A'))
      .map((r: any) => {
        const insured = insuredEmails(r);
        const co = coInsuredEmails(r);
        const list = insuredOnly ? insured : [...insured, ...co];
        return { r, insured, co, list };
      })
      // Rows with nothing to send to are dropped: this is a send list, not a coverage
      // report. The Renewal Week report is where the gaps are counted.
      .filter((x: any) => x.list.length > 0)
      .map(({ r, insured, co }: any) => {
        const who = insured.length
          ? (co.length && !insuredOnly ? 'insured + co-insured' : 'insured')
          : 'co-insured only';
        const context = [
          who,
          `${insured.length} insured`,
          !insuredOnly && co.length ? `${co.length} co-insured` : null,
          r.travelersPremium != null || r.plymouthPremium != null ? 'rated' : 'not rated',
        ].filter(Boolean).join(' · ');

        return {
          ...rowOf(r, context, null, null, null),
          cohort: r.cohort ?? null,
          insuredEmailList: insured,
          coInsuredEmailList: insuredOnly ? [] : co,
          coInsuredName: insuredOnly ? null : coInsuredName(r),
          hasInsuredEmail: insured.length > 0,
          hasCoInsuredEmail: co.length > 0,
          insuredEmailCount: insured.length,
          /** Reachable only at the co-insured — the leads the insured-only list loses. */
          coInsuredOnly: insured.length === 0 && co.length > 0,
          /**
           * Everything the email itself merges, built by the SAME function the push uses.
           *
           * The export used to carry addresses and nothing else, so importing it meant
           * rebuilding the renewal date, the month and the subject line by hand at the other
           * end. That is exactly where the renewal date came out a day early on all 678
           * accounts. One builder, one set of names, spelled the way the sending tool spells
           * them.
           *
           * Built for the person this row is FOR: the insured where there is an insured
           * address, the co-insured where the row exists only because of theirs. A row
           * carrying the insured{{firstName}} against a co-insured address would greet the
           * wrong person by name.
           */
          campaignVars: mergeVarsFor(r, insured.length ? 'insured' : 'coInsured', site, globals, ctas, subjects),
        };
      });
  }

  if (type === 'reachability') {
    /**
     * Insured / co-insured / combined reachability, per cohort.
     *
     * The question behind it is a decision, not a statistic. Campaigns go to the named
     * insured only — the co-insured is deliberately excluded — and this is what that rule
     * costs: how many households we can reach at all, and how many we could reach ONLY by
     * mailing the co-insured. Without the last number nobody can judge whether the rule is
     * worth keeping.
     *
     * The insured count comes from the SAME function the push uses, so the report cannot
     * promise reach the push would not use. It is deliberately not a SQL predicate: the
     * insured's addresses are attributed per-person inside the trace payload, and the
     * existing "has email" SQL both misses email2/emailsAll and counts owner2Email — the
     * co-insured — as if it were the insured's.
     *
     * Every lead is a row, reachable or not. The denominator is the whole cohort; dropping
     * the unreachable ones would turn "30% reachable" into "100% of the reachable ones".
     */
    /**
     * Named columns, not SELECT *. This report reads the whole book rather than one
     * week, and `SELECT *` drags rawData — a large JSONB blob on every one of ~10,000
     * leads — over the wire for columns nothing here touches. Measured: 25s with the
     * star, well past any serverless limit. skipTraceData IS needed: it carries the
     * per-person attribution that decides which addresses are the insured's.
     *
     * The date range is pushed into SQL as well. inRange below still has the final say —
     * it is the shared rule every report uses — but there is no reason to ship rows over
     * the wire only to drop them in JS.
     */
    const from = effFrom || null;
    const to = effTo || null;
    rows = await sql`
      SELECT "propertyId", "owner1FirstName", "owner1LastName",
             "addressStreet", "addressCity", "addressZip",
             "effectiveDate", "cohort", "grade", "manualGrade", "propertyType",
             "travelersEligible", "plymouthEligible", "deepSkipTracedAt",
             "email1", "email2", "owner2Email", "skipTraceData", "emailsAll", "phone1", "phone2",
             -- The owner2 pair is REQUIRED, not cosmetic: without it the co-insured
             -- cannot be matched in the trace payload, their addresses are never taken
             -- out of the insured's, and this tab over-reports insured reach. It read
             -- 521 against Renewal Week's 518 for the same range. See RECIPIENT_COLS.
             "owner2FirstName", "owner2LastName", "owner2Phone"
        FROM "Lead"
       WHERE "effectiveDate" IS NOT NULL
         AND (${from}::text IS NULL OR left("effectiveDate", 10) >= ${from})
         AND (${to}::text   IS NULL OR left("effectiveDate", 10) <= ${to})
       ORDER BY "cohort", "addressCity", "owner1LastName"`;
    // Checked once, not per row: this is the only report with a hand-written column list
    // feeding the recipient rules, so it is the only one that can drift away from them.
    assertRecipientCols(rows[0], 'reachability report');
    return rows
      .filter((r: any) => inRange(iso(r.effectiveDate), effFrom, effTo))
      .map((r: any) => {
        const insured = insuredEmails(r);
        const coOnly = coInsuredEmails(r);

        const context = insured.length
          ? `${insured.length} insured address${insured.length === 1 ? '' : 'es'}`
            + (coOnly.length ? ' · co-insured also held' : '')
          : coOnly.length
            ? 'NO insured address — reachable only via the co-insured'
            : 'unreachable — no address for either party';

        return {
          ...rowOf(r, context, null, iso(r.deepSkipTracedAt)),
          // Labelled, not the bare Monday: a column of dates gives no clue whether one
          // means a single day's renewals or a week's.
          reason: cohortLabel(r.cohort),
          cohort: r.cohort ?? null,
          insuredEmailCount: insured.length,
          coInsuredOnly: coOnly.length > 0,
          hasEmail: insured.length > 0 || coOnly.length > 0,
          hasPhone: !!(String(r.phone1 ?? '').trim() || String(r.phone2 ?? '').trim()),
        };
      });
  }

  if (type === 'cohort') {
    // Every lead whose renewal falls in the window, graded or not.
    //
    // Deliberately unfiltered by status or grade: this answers "what is actually in
    // this week" before any decision has been taken about it. The other reports all
    // start from a judgement already made (a producer flagged it, a blast traced it);
    // this one is the denominator those are a subset of, which is why the ungraded
    // leads have to be in it rather than quietly dropped.
    //
    // Contactability is carried on every row because the cohort question is always
    // followed by "and how many can we actually email".
    /**
     * ── The window is applied in SQL, not after the rows arrive ──────────────
     *
     * This read every lead in the book — all 11,127 — with SELECT *, then threw away the
     * ones outside the range in JavaScript. skipTraceData alone averages 2.1 KB a row, so
     * the response grew with the book until it crossed the database's 64 MB ceiling and the
     * report simply stopped: "Failed to run report", with the real reason only in a server
     * log nobody reads.
     *
     * The window has to stay optional — an empty range still means the whole book, which is
     * what the denominator this report provides is for — so the bounds are applied only when
     * given. inRange still runs below and is still the authority on what a range means; this
     * narrows the transfer rather than redefining it, so the two cannot disagree about an
     * edge date.
     */
    rows = await sql`
      SELECT * FROM "Lead"
      WHERE "effectiveDate" IS NOT NULL
        -- effectiveDate is TEXT holding ISO dates ("2026-03-25"), so it is compared as
        -- text. ISO orders correctly that way; casting to date would be tidier and fails,
        -- because the column is not one.
        AND (${effFrom ?? null}::text IS NULL OR "effectiveDate" >= ${effFrom ?? null}::text)
        AND (${effTo ?? null}::text IS NULL OR "effectiveDate" <= ${effTo ?? null}::text)
      ORDER BY "effectiveDate", "addressCity", "owner1LastName"` as any[];
    return rows
      .filter((r: any) => inRange(iso(r.effectiveDate), effFrom, effTo))
      .map((r: any) => {
        /**
         * Counted PER PERSON, not per property.
         *
         * This used to read emailsAll/phonesAll — everything the trace returned for the
         * ADDRESS, which routinely includes relatives, prior owners and unrelated
         * co-residents. A lead whose only address belonged to a neighbour counted as
         * "reachable by email", so the figure answered "is anyone at this property
         * contactable" rather than "can we reach the person whose policy is renewing".
         * It also folded the co-insured's address in with the insured's, which hid the
         * fact that campaigns never mail the co-insured.
         *
         * Same functions the campaign push uses, so the number cannot promise reach the
         * push would not act on.
         */
        const insEmails = insuredEmails(r);
        const coEmails = coInsuredEmails(r);
        const insPhones = insuredPhones(r);
        const coPhones = coInsuredPhones(r);

        const hasInsuredEmail = insEmails.length > 0;
        const hasCoInsuredEmail = coEmails.length > 0;
        const hasInsuredPhone = insPhones.length > 0;
        const hasCoInsuredPhone = coPhones.length > 0;
        const traced = !!r.deepSkipTracedAt;

        const part = (n: number, label: string) => (n ? `${n} ${label}${n === 1 ? '' : 's'}` : null);
        const context = [
          traced ? 'traced' : 'not traced',
          part(insEmails.length, 'insured email') ?? 'no insured email',
          part(coEmails.length, 'co-insured email'),
          part(insPhones.length, 'insured phone') ?? 'no insured phone',
          part(coPhones.length, 'co-insured phone'),
        ].filter(Boolean).join(' · ');

        return {
          ...rowOf(r, context, null, iso(r.deepSkipTracedAt)),
          // The status is what splits new / quarantine / rated, and the UI tallies on it.
          reason: r.status ?? null,
          hasInsuredEmail,
          hasCoInsuredEmail,
          hasInsuredPhone,
          hasCoInsuredPhone,
          insuredEmailList: insEmails,
          coInsuredEmailList: coEmails,
          insuredPhoneList: insPhones,
          coInsuredPhoneList: coPhones,
          coInsuredName: coInsuredName(r),
          // contactability (Sec. 4.1). Derived here from the same functions above, so the
          // column, the chips and the campaign export cannot disagree about a lead.
          contactability: contactabilityOf(r),
          householdReach: householdReach(r),
          channel: channelOf(r),
          directMailOnly: isDirectMailOnly(r),
          // Kept so anything still reading the old flags keeps working, but they are now
          // the INSURED's — the only contact the campaign will actually use.
          hasEmail: hasInsuredEmail,
          hasPhone: hasInsuredPhone,
          matched: traced,
        };
      });
  }

  if (type === 'contact_coverage') {
    // Frank Aug-2026: rated accounts broken down by property type (Condo/SFH) and
    // contact status (phone-only / email-only / both / neither) + DOB. The UI tallies
    // the summary from these rows; the no-email subset drives the downgrade decision.
    // `value` reuses the status field: 'review' default = rated; pass a status via ?value.
    rows = await sql`SELECT * FROM "Lead" WHERE "status" = 'rated' ORDER BY "effectiveDate"`;
    return rows
      .filter((r: any) => inRange(iso(r.effectiveDate), effFrom, effTo))
      .map((r: any) => {
        const hasPhone = !!(String(r.phone1 ?? '').trim() || String(r.phone2 ?? '').trim());
        const hasEmail = !!(String(r.email1 ?? '').trim() || String(r.email2 ?? '').trim());
        const hasDob = !!(r.reapiDob || r.owner1Dob);
        const isCondo = String(r.propertyType ?? '').toUpperCase() === 'CONDO'
          || /condo/i.test(r.landUse ?? '');
        const contact = hasPhone && hasEmail ? 'Phone + Email'
          : hasPhone ? 'Phone only'
          : hasEmail ? 'Email only'
          : 'No phone or email';
        const row = rowOf(r, `${contact}${hasDob ? ' · DOB' : ' · no DOB'}`);
        return { ...row, hasPhone, hasEmail, hasDob, isCondo };
      });
  }

  /**
   * The co-insured against the tax roll — the same question the insured already answers.
   *
   * Frank, 2 Oct 2026: verify the co-insured name against WIIP as well as the insured.
   *
   * The verdict is already on the card (coInsuredVerifyStatus), derived from the deed line
   * WIIP returns for both people. This is what makes it answerable: before it, "show me
   * every card where the co-insured disagrees with the roll" meant asking a developer.
   *
   * Only the three that need a person are listed. 'match' needs nobody, 'none_on_roll'
   * and 'entity' are facts about the property rather than work — putting them in would
   * bury 124 real disagreements inside 500 rows of nothing to do.
   */
  if (type === 'co_insured_verify') {
    rows = await sql`
      SELECT * FROM "Lead"
       WHERE "coInsuredVerifyStatus" IN ('mismatch', 'found_on_wiip', 'partial')
       ORDER BY CASE "coInsuredVerifyStatus"
                  WHEN 'mismatch' THEN 1 WHEN 'found_on_wiip' THEN 2 ELSE 3 END,
                "coInsuredVerifyAt" DESC NULLS LAST` as any[];
    const LABEL: Record<string, string> = {
      // States the fact, not a conclusion — see coInsuredVerify for why a confident label
      // was wrong on three of the first four rows anybody looked at.
      mismatch: 'Card and roll differ',
      found_on_wiip: 'Found on WIIP — card has none',
      partial: 'Close, not exact',
    };
    return rows
      .filter((r: any) => inRange(iso(r.effectiveDate), effFrom, effTo))
      .map((r: any) => ({
        ...rowOf(r, r.coInsuredVerifyDetail ?? '', null, iso(r.coInsuredVerifyAt),
          LABEL[r.coInsuredVerifyStatus] ?? r.coInsuredVerifyStatus),
        coInsuredName: [r.owner2FirstName, r.owner2LastName].filter(Boolean).join(' ') || null,
        rollCoInsured: r.coInsuredVerifyName ?? null,
      }));
  }

  if (type === 'coinsured_contact_mix') {
    /**
     * Cards where the co-insured's address looks like the INSURED rather than the
     * co-insured (register: the field-guard fault).
     *
     * ── Why these exist ──────────────────────────────────────────────────────
     * Until the guard was fixed, each co-insured field was filled independently: the name
     * was kept because it was already there, and the email was taken from whichever person
     * the trace handed over. Lead 251520882 ended up reading "Zebunnisa Saeed ·
     * waqas24@yahoo.com" — the insured's own address, under his wife's name. An email
     * opening "Dear Zebunnisa" would have reached Waqas, and the lead counted as reachable
     * at the co-insured in every report.
     *
     * The code no longer does this. These are the cards it already did it to.
     *
     * ── Why this reports rather than repairs ─────────────────────────────────
     * Moving the address to the insured would be right on most of these and wrong on some:
     * a shared household address, or a co-insured who genuinely uses a name-like handle.
     * Automatic adjudication of a name question has been tried twice on this project and
     * was wrong both times — see coInsuredVerify. So the two names and the address are put
     * side by side and a person decides, which takes a second with them in front of you.
     *
     * Several of these hand back an insured email we did not know we held: Rebecca Handel
     * is on this list and is also one of the Grade A cards reported as unemailable.
     */
    const token = (v: unknown) => String(v ?? '').toLowerCase().replace(/[^a-z]/g, '');
    /** How many of a person's name tokens appear in the address's local part. */
    const looksLike = (localPart: string, first: unknown, last: unknown) => {
      const f = token(first); const l = token(last);
      let n = 0;
      if (f.length >= 3 && localPart.includes(f)) n++;
      if (l.length >= 3 && localPart.includes(l)) n++;
      return n;
    };

    rows = await sql`
      SELECT * FROM "Lead"
       WHERE "owner2Email" IS NOT NULL AND "owner2Email" <> ''
         AND COALESCE("manualGrade", "grade") IN ('A', 'B')
       ORDER BY "cohort", "owner1LastName"` as any[];

    return rows
      .filter((r: any) => inRange(iso(r.effectiveDate), effFrom, effTo))
      .filter((r: any) => {
        const localPart = String(r.owner2Email).split('@')[0].toLowerCase().replace(/[^a-z]/g, '');
        const asInsured = looksLike(localPart, r.owner1FirstName, r.owner1LastName);
        const asCoInsured = looksLike(localPart, r.owner2FirstName, r.owner2LastName);
        // Only where it looks MORE like the insured. An address matching both — a shared
        // surname — says nothing, and listing those would bury the real ones.
        return asInsured > asCoInsured && asInsured > 0;
      })
      .map((r: any) => ({
        ...rowOf(
          r,
          `Filed under ${[r.owner2FirstName, r.owner2LastName].filter(Boolean).join(' ') || 'the co-insured'}, `
          + `but "${r.owner2Email}" reads as ${[r.owner1FirstName, r.owner1LastName].filter(Boolean).join(' ')}. `
          + `Move it to the insured, or confirm it is theirs.`,
          null,
          null,
          'Co-insured slot holds the insured’s address',
        ),
        coInsuredName: [r.owner2FirstName, r.owner2LastName].filter(Boolean).join(' ') || null,
      }));
  }

  if (type === 'owner_verify') {
    // WIP owner-name verification failures (Frank Aug-2026 — mandatory verify): the
    // property wasn't found on the tax roll ('not_found'), or the insured name disagrees
    // with it ('mismatch'). Both need a human's review before the lead goes to outreach.
    rows = await sql`
      SELECT * FROM "Lead"
      WHERE "ownerVerifyStatus" IN ('not_found', 'mismatch')
      ORDER BY "ownerVerifyAt" DESC NULLS LAST`;
    return rows
      .filter((r: any) => inRange(iso(r.effectiveDate), effFrom, effTo))
      .map((r: any) => {
        const label = r.ownerVerifyStatus === 'not_found' ? 'Not on tax roll' : 'Name mismatch';
        const detail = r.ownerVerifyName
          ? `${label} — roll shows "${r.ownerVerifyName}"`
          : (r.ownerVerifyDetail || label);
        return rowOf(r, detail, null, iso(r.ownerVerifyAt));
      });
  }

  return [];
}

function rowOf(r: any, context: string, by: string | null = null, at: string | null = null, reason: string | null = null): QcRow {
  return {
    reason,
    propertyId: r.propertyId,
    owner: nm(r) || '—',
    address: r.addressStreet ?? null,
    city: r.addressCity ?? null,
    zip: r.addressZip ?? null,
    effectiveDate: iso(r.effectiveDate),
    grade: r.grade ?? null,
    manualGrade: r.manualGrade ?? null,
    propertyType: r.propertyType ?? null,
    travelersEligible: r.travelersEligible ?? null,
    plymouthEligible: r.plymouthEligible ?? null,
    context,
    by,
    at,
  };
}
