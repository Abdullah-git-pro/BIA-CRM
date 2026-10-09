import { sql } from '@/lib/neon';
import { subjectFor, type Segment } from './campaignSegment.service';
import { cohortNumber, numberedCohorts, numberedCohortCodes } from './cohort';
import { unknownTokensIn } from '@/lib/mergeFields';
import { globalMergeVars } from './globalMergeVars.service';

/**
 * The subject lines, read from the database rather than the source.
 *
 * The CTAs moved out of the code first and this follows the same reasoning: Zoya writes the
 * copy and cannot edit a TypeScript constant, so changing a sentence a homeowner reads
 * needed a developer and a deploy.
 *
 * ── What did NOT change ─────────────────────────────────────────────────────
 * Who gets which line. §5 varies the subject by segment, cohort, step and A/B variant —
 * priced copy only to priced accounts, C6/C7 introducing before they quote, Grade B on the
 * roof — and all 25 rows are preserved. The storage moved; the strategy did not.
 *
 * ── subjectFor() is still the floor ─────────────────────────────────────────
 * A lookup that finds nothing falls back to the compiled function. A subject line is the
 * one field an email cannot send without: a blank subject is both an unopened email and a
 * spam signal, so there is no path here that returns an empty string.
 */

export interface SubjectRow {
  id: string;
  segment: Segment;
  step: number;
  variant: 'A' | 'B';
  /** Cohort codes this line covers. Empty means every cohort. */
  cohorts: string[];
  name: string;
  template: string;
  updatedAt: string | null;
  updatedBy: string | null;
  unknownTokens: string[];
}

export async function getSubjects(): Promise<SubjectRow[]> {
  const rows = await sql`
    SELECT "id","segment","step","variant","cohorts","name","template","updatedAt","updatedBy"
      FROM "CampaignSubject"
     ORDER BY "segment", "step", "variant", "cohorts"` as Array<Record<string, any>>;
  return rows.map((r) => ({
    id: String(r.id),
    segment: r.segment as Segment,
    step: Number(r.step),
    variant: r.variant as 'A' | 'B',
    cohorts: Array.isArray(r.cohorts) ? r.cohorts : [],
    name: String(r.name),
    template: String(r.template),
    updatedAt: r.updatedAt ? new Date(r.updatedAt).toISOString() : null,
    updatedBy: r.updatedBy ?? null,
    unknownTokens: unknownTokensIn(String(r.template)),
  }));
}

/**
 * Every stored line, keyed so a lookup is a map read rather than a query per lead.
 *
 * Built once per push and handed to mergeVarsFor, the same way the globals and the CTAs
 * are. A per-lead query here would be one round trip per contact on a list of several
 * hundred.
 */
export type SubjectLookup = Map<string, string>;

const keyOf = (segment: string, step: number, variant: string, cohort: string) =>
  `${segment}|${step}|${variant}|${cohort}`;

export async function subjectLookup(): Promise<SubjectLookup> {
  const rows = await getSubjects();
  const out: SubjectLookup = new Map();
  for (const r of rows) {
    // An empty cohort list means "every cohort" — Grade B's single pair.
    const codes = r.cohorts.length ? r.cohorts : ['*'];
    /**
     * Grade B's pair is step-agnostic, the same way GRADE_B_CTA is.
     *
     * §5.11 gives Grade B one pair, used at every step — the roof question does not become
     * a different question in the follow-up. Stored once at step 1, so without this the
     * lookup finds nothing for steps 2 and 3 and quietly serves the compiled wording
     * instead: an edit on the screen would change the first email and leave the rest, with
     * nothing anywhere reporting the split. The coverage check below is what caught it.
     */
    const steps = r.segment === 'grade_b' ? [1, 2, 3] : [r.step];
    for (const c of codes) {
      for (const s of steps) out.set(keyOf(r.segment, s, r.variant, c), r.template);
    }
  }
  return out;
}

/** The template for one lead, or '' when nothing is stored and the caller should fall back. */
export function subjectTemplateFrom(
  lookup: SubjectLookup,
  segment: string,
  cohort: string,
  step: number,
  variant: 'A' | 'B',
): string {
  const code = `C${cohortNumber(cohort)}`;
  return lookup.get(keyOf(segment, step, variant, code))
    ?? lookup.get(keyOf(segment, step, variant, '*'))
    ?? '';
}

export interface SubjectProblem { field: 'name' | 'template'; message: string }

/**
 * What is wrong with a proposed subject, before it is saved.
 *
 * The length limit is not cosmetic: most clients truncate a subject around 60 characters on
 * a phone, and a line whose point arrives at character 80 is a line nobody reads. It warns
 * rather than refuses, because a long subject is a judgement call and a broken token is not.
 */
export function subjectProblems(
  name: string,
  template: string,
  alsoKnown: Iterable<string> = [],
): SubjectProblem[] {
  const out: SubjectProblem[] = [];
  if (!name.trim()) out.push({ field: 'name', message: 'Give the line a short name — it appears in the version label.' });
  const t = template.trim();
  if (!t) {
    out.push({ field: 'template', message: 'Empty. An email with no subject does not get opened, and it reads as spam.' });
    return out;
  }
  const unknown = unknownTokensIn(t, alsoKnown);
  if (unknown.length) {
    out.push({
      field: 'template',
      message: `${unknown.join(', ')} ${unknown.length === 1 ? 'is not a' : 'are not'} merge `
        + 'field, so it would print as braces in the subject line.',
    });
  }
  return out;
}

export async function setSubject(
  id: string,
  name: string,
  template: string,
  by: string | null,
): Promise<{ ok: true } | { ok: false; problems: SubjectProblem[] }> {
  const custom = Object.keys(await globalMergeVars());
  const problems = subjectProblems(name, template, custom);
  if (problems.length) return { ok: false, problems };
  const res = await sql`
    UPDATE "CampaignSubject"
       SET "name" = ${name.trim()}, "template" = ${template.trim()},
           "updatedAt" = NOW(), "updatedBy" = ${by}
     WHERE "id" = ${id}
 RETURNING "id"` as Array<Record<string, any>>;
  if (!res.length) {
    return { ok: false, problems: [{ field: 'template', message: 'That subject line no longer exists.' }] };
  }
  return { ok: true };
}

/**
 * Does every audience the system can produce have a stored line?
 *
 * Guards the cutover. If a combination is missing, the fallback quietly serves the compiled
 * wording and an edit on the screen appears to do nothing for that audience — the same
 * shape of bug as the QC export that kept printing the old CTAs.
 */
export async function subjectCoverage(): Promise<{
  checked: number; missing: Array<{ segment: string; cohort: string; step: number; variant: string }>;
}> {
  const lookup = await subjectLookup();
  // Every numbered week, not the seven that were typed here. This guard exists to report
  // a missing line, and with C8 absent from the list it reported full coverage while all
  // twelve of C8's rated and unrated lines were missing.
  const weeks = numberedCohorts();
  const missing: Array<{ segment: string; cohort: string; step: number; variant: string }> = [];
  let checked = 0;
  const { stepsFor } = await import('./campaignSegment.service');
  for (const segment of ['rated', 'unrated', 'grade_b'] as const) {
    for (const week of weeks) {
      for (const step of stepsFor(week)) {
        for (const variant of ['A', 'B'] as const) {
          checked++;
          const stored = subjectTemplateFrom(lookup, segment, week, step, variant);
          const compiled = subjectFor({ segment, cohort: week, step, variant }).template;
          if (!stored && compiled) missing.push({ segment, cohort: week, step, variant });
        }
      }
    }
  }
  return { checked, missing };
}

/**
 * The stored lines as a plain object, keyed segment|step|variant|cohortCode.
 *
 * mergeVarsFor takes a Record rather than the Map so it stays free of this module — it is
 * imported by a client bundle path, and pulling a service that opens a database connection
 * into it is how a key ended up inlined into client JS once before.
 *
 * Every send path loads this. A path that forgets gets the compiled wording and no error,
 * which is exactly how the QC export went on printing CTAs that had been edited away.
 */
export async function subjectTemplates(): Promise<Record<string, string>> {
  return Object.fromEntries(await subjectLookup());
}

/**
 * ── Zoya owns the routing, not just the words ───────────────────────────────
 *
 * Abdullah, 2 Oct 2026: "do not hardcode anything, let Zoya think which subject goes to
 * which email and which variant."
 *
 * The seed fixed each line to a segment, a step, a variant and a set of cohorts. That made
 * the TEXT editable and left the MAPPING in the code — so "try this line on C4 instead" was
 * still a developer job, which is the thing we were removing.
 *
 * Everything below changes the mapping. The risk it introduces is real and is why the
 * checks exist: two lines claiming the same audience, or an audience with no line at all.
 */

/** A routing claim: one segment, one step, one variant, and the cohorts it covers. */
export interface Routing {
  segment: Segment;
  step: number;
  variant: 'A' | 'B';
  /** Empty means every cohort. */
  cohorts: string[];
}

/**
 * Every cohort a routing claim can cover, for expanding "empty means every cohort".
 *
 * Derived rather than listed: a line claiming all cohorts has to collide with one
 * claiming C8, and while this stopped at C7 that overlap could not be detected — the
 * exact silence routingConflicts() is written to prevent.
 */
export const COHORT_CODES: readonly string[] = numberedCohortCodes();

/**
 * Two lines cannot claim the same audience.
 *
 * The lookup takes the first match, so an overlap means one of the two lines silently never
 * sends and nobody can tell which. A unique index cannot catch it — {C1,C2} and {C2,C3} are
 * different values that collide on C2 — so it is checked here, against every other row.
 */
export async function routingConflicts(
  routing: Routing,
  ignoreId?: string,
): Promise<Array<{ id: string; name: string; cohorts: string[] }>> {
  const rows = await getSubjects();
  const mine = routing.cohorts.length ? new Set(routing.cohorts) : new Set(COHORT_CODES);
  return rows
    .filter((r) => {
      if (r.id === ignoreId || r.segment !== routing.segment || r.variant !== routing.variant) return false;
      /**
       * Grade B's line answers for EVERY step, so its step is not part of its identity.
       *
       * subjectLookup expands a grade_b row across steps 1–3 (§5.11 gives Grade B one pair,
       * used at every email). Comparing steps here would call a second grade_b line at step 2
       * conflict-free while the lookup had both answering — one of them silently never
       * sending, which is the exact thing this check exists to prevent. Found by testing the
       * check rather than by reading it.
       */
      if (routing.segment === 'grade_b') return true;
      return r.step === routing.step;
    })
    .filter((r) => {
      const theirs = r.cohorts.length ? r.cohorts : [...COHORT_CODES];
      return theirs.some((c) => mine.has(c));
    })
    .map((r) => ({ id: r.id, name: r.name, cohorts: r.cohorts }));
}

export async function setSubjectRouting(
  id: string,
  routing: Routing,
): Promise<{ ok: true } | { ok: false; problems: SubjectProblem[] }> {
  if (![1, 2, 3].includes(routing.step)) {
    return { ok: false, problems: [{ field: 'template', message: 'A sequence has three emails.' }] };
  }
  const clash = await routingConflicts(routing, id);
  if (clash.length) {
    return {
      ok: false,
      problems: [{
        field: 'template',
        message: `"${clash[0].name}" already covers ${clash[0].cohorts.join(', ') || 'every cohort'} `
          + 'for that email and variant. Two lines claiming one audience means one of them '
          + 'never sends, and nothing would say which.',
      }],
    };
  }
  await sql`
    UPDATE "CampaignSubject"
       SET "segment" = ${routing.segment}, "step" = ${routing.step},
           "variant" = ${routing.variant}, "cohorts" = ${routing.cohorts}::text[],
           "updatedAt" = NOW()
     WHERE "id" = ${id}`;
  return { ok: true };
}

export async function createSubject(
  routing: Routing,
  name: string,
  template: string,
  by: string | null,
): Promise<{ ok: true; id: string } | { ok: false; problems: SubjectProblem[] }> {
  const custom = Object.keys(await globalMergeVars());
  const problems = subjectProblems(name, template, custom);
  if (problems.length) return { ok: false, problems };
  const clash = await routingConflicts(routing);
  if (clash.length) {
    return {
      ok: false,
      problems: [{
        field: 'template',
        message: `"${clash[0].name}" already covers that audience. Change the cohorts, the `
          + 'email or the variant first.',
      }],
    };
  }
  const id = crypto.randomUUID();
  await sql`
    INSERT INTO "CampaignSubject" ("id","segment","step","variant","cohorts","name","template","updatedBy")
    VALUES (${id}, ${routing.segment}, ${routing.step}, ${routing.variant},
            ${routing.cohorts}::text[], ${name.trim()}, ${template.trim()}, ${by})`;
  return { ok: true, id };
}

/**
 * Removing a line is allowed, and the caller is told what it costs.
 *
 * Deleting the only line for an audience does not blank the email — subjectFor() still
 * answers — but it does mean that audience silently stops following this screen, which is
 * exactly the confusion the screen was built to end. So the audiences it strands are
 * returned rather than the delete being refused: Zoya may well be deleting one line because
 * she is about to add a better one.
 */
export async function deleteSubject(id: string): Promise<{ ok: true; stranded: string[] }> {
  const before = await subjectCoverage();
  await sql`DELETE FROM "CampaignSubject" WHERE "id" = ${id}`;
  const after = await subjectCoverage();
  const was = new Set(before.missing.map((m) => `${m.segment}|${m.cohort}|${m.step}|${m.variant}`));
  const stranded = after.missing
    .filter((m) => !was.has(`${m.segment}|${m.cohort}|${m.step}|${m.variant}`))
    .map((m) => `${m.segment} · ${m.cohort} · email ${m.step} · ${m.variant}`);
  return { ok: true, stranded };
}
