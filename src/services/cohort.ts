/**
 * The cohort a lead belongs to: its renewal week, labelled by the MONDAY.
 *
 * '2026-11-09' means 09 Nov – 15 Nov 2026. Derived from the renewal effective date and
 * nothing else, so it is stable, recomputable and partitions every lead exactly once.
 *
 * ── The definition of record is the database ─────────────────────────────────
 * "Lead"."cohort" is maintained by the lead_cohort_trg trigger (migration 021), because
 * effectiveDate is written from several places — two of them generic builders that
 * assemble columns from a payload — and any app-side derivation would eventually drift.
 * What is here MIRRORS that trigger for labelling, filtering and stamping a send; it is
 * not where the value comes from. If one changes, change both.
 *
 * ── Why Monday-to-Sunday and not Frank's window ──────────────────────────────
 * Frank names a pull inclusively: "11/09/2026 to 11/16/2026". Taken literally that is
 * eight days, and consecutive pulls share a Monday — on the live data that window holds
 * 1,519 leads, of which 149 are dated 11/16 and also belong to the following week. A tag
 * has to partition, so the stored cohort is the non-overlapping week. Reports keep
 * taking an explicit from/to range and are unchanged by this.
 */

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

/**
 * The Monday of the week containing `effectiveDate`, or null if the date is missing or
 * not a clean ISO date.
 *
 * All arithmetic is UTC. A local-time Date would shift the day either side of midnight
 * depending on where the server runs, which for a Monday-anchored week means a Sunday
 * renewal silently landing in the wrong cohort.
 */
export function cohortOf(effectiveDate: string | Date | null | undefined): string | null {
  if (!effectiveDate) return null;

  const iso = effectiveDate instanceof Date
    ? effectiveDate.toISOString().slice(0, 10)
    : String(effectiveDate).slice(0, 10);
  if (!ISO_DATE.test(iso)) return null;

  const d = new Date(`${iso}T00:00:00Z`);
  if (Number.isNaN(d.getTime())) return null;

  // getUTCDay: 0 = Sunday. Sunday belongs to the week that began six days earlier, not
  // to the one starting the next day.
  const dow = d.getUTCDay();
  d.setUTCDate(d.getUTCDate() - (dow === 0 ? 6 : dow - 1));
  return d.toISOString().slice(0, 10);
}

/** Inclusive last day of a cohort week — the Sunday. */
export function cohortEnd(cohort: string): string | null {
  if (!ISO_DATE.test(cohort)) return null;
  const d = new Date(`${cohort}T00:00:00Z`);
  if (Number.isNaN(d.getTime())) return null;
  d.setUTCDate(d.getUTCDate() + 6);
  return d.toISOString().slice(0, 10);
}

/**
 * How a cohort reads to a person: "Nov 9 – 15, 2026".
 *
 * Deliberately not the bare Monday. A producer looking at a column of dates cannot tell
 * whether '2026-11-09' means a single day's renewals or a week's, and that ambiguity is
 * exactly what the cohort exists to remove.
 */
export function cohortLabel(cohort: string | null | undefined): string {
  if (!cohort || !ISO_DATE.test(cohort)) return '—';
  const end = cohortEnd(cohort);
  if (!end) return cohort;

  const s = new Date(`${cohort}T00:00:00Z`);
  const e = new Date(`${end}T00:00:00Z`);
  const month = (d: Date) => d.toLocaleDateString('en-US', { month: 'short', timeZone: 'UTC' });
  const day = (d: Date) => d.getUTCDate();

  // Same month reads "Nov 9 – 15"; a week straddling one reads "Nov 30 – Dec 6".
  return month(s) === month(e)
    ? `${month(s)} ${day(s)} – ${day(e)}, ${e.getUTCFullYear()}`
    : `${month(s)} ${day(s)} – ${month(e)} ${day(e)}, ${e.getUTCFullYear()}`;
}

/**
 * The Monday of C1. Everything numbered here counts weeks from it.
 *
 * Frank writes and speaks in C1…C7, and those seven weeks were a hand-written map in two
 * separate files. A map stops at its last entry: the week of 23 Nov holds 702 leads and 165
 * Grade A, and rendered as "—" on the ledger because nobody had added an eighth line.
 */
export const COHORT_ONE_MONDAY = '2026-10-05';

/**
 * Which numbered cohort a renewal week is, or 0 if it is before C1.
 *
 * ── Why this is arithmetic and not a list ───────────────────────────────────
 * A cohort is the Monday of a renewal week, so the numbering is division: C1 is 05 Oct
 * 2026 and each later Monday is one higher. Keeping it as a list meant the code and the
 * data could disagree, and they did — silently, on a week with 165 Grade A leads in it.
 *
 * ── Why weeks before C1 return 0 rather than a negative ─────────────────────
 * 4,117 leads sit in 19 weeks between March and September 2026. "C-3" would be a label
 * nobody uses for a week nobody is mailing; 0 means "not one of the numbered waves", which
 * is what those weeks actually are.
 */
export function cohortNumber(cohort: string | null | undefined): number {
  if (!cohort || !ISO_DATE.test(String(cohort).slice(0, 10))) return 0;
  const start = Date.UTC(2026, 9, 5); // 2026-10-05, month is 0-based
  const d = new Date(`${String(cohort).slice(0, 10)}T00:00:00Z`).getTime();
  if (!Number.isFinite(d)) return 0;
  const weeks = Math.round((d - start) / (7 * 86_400_000));
  return weeks >= 0 ? weeks + 1 : 0;
}

/**
 * 'C1', 'C8', … or null for a week before C1.
 *
 * Null rather than a placeholder so every caller keeps choosing its own fallback — the
 * ledger draws a dash, the merge variables fall back to the raw date, and neither has to
 * strip a string the other invented.
 */
export function cohortCode(cohort: string | null | undefined): string | null {
  const n = cohortNumber(cohort);
  return n > 0 ? `C${n}` : null;
}

/**
 * How many numbered waves exist. The one place that number is written down.
 *
 * ── Why this is here and not in each screen ─────────────────────────────────
 * Five places had their own copy of the numbered weeks, all of them stopping at C7, and
 * each one failed differently when the data reached C8: the cohort ledger drew a dash
 * against 165 Grade A leads, the phone and call-coverage filters could not select the
 * week at all, the routing conflict check could not see a line claiming it, and the
 * subject coverage guard — whose entire job is to report a missing line — reported full
 * coverage while twelve lines were missing.
 *
 * That is the same bug five times, so what changes when a wave is added is now one
 * number rather than five lists. Raise it when the data gains a week; everything that
 * counts weeks follows.
 */
export const COHORT_COUNT = 8;

/**
 * Every numbered cohort as its Monday, C1 first: ['2026-10-05', …].
 *
 * Arithmetic from COHORT_ONE_MONDAY, in UTC, for the reason given on cohortOf: a
 * local-time Date shifts the day either side of midnight, and a Monday-anchored week
 * cannot survive that.
 */
export function numberedCohorts(): string[] {
  return Array.from({ length: COHORT_COUNT }, (_, i) => {
    const d = new Date(`${COHORT_ONE_MONDAY}T00:00:00Z`);
    d.setUTCDate(d.getUTCDate() + i * 7);
    return d.toISOString().slice(0, 10);
  });
}

/** Every numbered cohort as its code, C1 first: ['C1', …]. */
export function numberedCohortCodes(): string[] {
  return numberedCohorts().map((c) => cohortCode(c)!);
}
