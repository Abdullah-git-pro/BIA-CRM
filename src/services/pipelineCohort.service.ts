import { sql } from '@/lib/neon';
import { cohortLabel, cohortCode } from './cohort';

/**
 * One cohort's leads, with what the tax roll said about each.
 *
 * The pipeline screen answers "how far has this week got"; this answers the question that
 * immediately follows — WHICH ones. A row saying "6 to review" is only actionable if you can
 * click it and find the six, so the vocabulary here is deliberately the same as the chips on
 * the summary: confirmed / to review / not on roll / not checked.
 *
 * ── Why 'to review' is one bucket on screen and four underneath ─────────────
 * partial, mismatch, ambiguous and unknown are different problems — a relative on title, a
 * different owner, a unit we could not pin down, a record we could not read — but they share
 * an action: a person decides. They are grouped for the counter and kept apart in `detail`,
 * which carries the comparator's own sentence, so the reviewer sees why without opening the
 * card. Sorting puts them first for the same reason.
 */

export type RollBucket = 'confirmed' | 'review' | 'not_on_roll' | 'not_checked';

export type PipelineLead = {
  leadId: string;
  propertyId: string | null;
  owner: string | null;
  coInsured: string | null;
  address: string | null;
  /** What the roll holds for this property, verbatim. Null when it was never asked. */
  rollName: string | null;
  rollStatus: string | null;
  /** The comparator's reason — why this is not simply a match. */
  detail: string | null;
  bucket: RollBucket;
  coStatus: string | null;
  coRollName: string | null;
  traced: boolean;
  /** Traced while the roll had never been consulted: the old order, on an unchecked name. */
  tracedBeforeRoll: boolean;
};

const REVIEW = ['partial', 'mismatch', 'ambiguous', 'unknown'];

function bucketOf(status: string | null, checkedAt: unknown): RollBucket {
  if (!checkedAt) return 'not_checked';
  if (status === 'match') return 'confirmed';
  if (status === 'not_found') return 'not_on_roll';
  return 'review';
}

export async function getPipelineCohortLeads(params: {
  cohort: string;
  grade?: string;
}): Promise<{ cohort: string; code: string | null; label: string; grade: string; leads: PipelineLead[] }> {
  const grade = params.grade || 'A';

  const rows = await sql`
    SELECT "id","propertyId",
           "owner1FirstName","owner1LastName","owner2FirstName","owner2LastName",
           "addressStreet","addressCity","addressZip",
           "ownerVerifyName","ownerVerifyStatus","ownerVerifyDetail","ownerVerifyAt",
           "coInsuredVerifyName","coInsuredVerifyStatus",
           "skipTracedAt","blastSkipTracedAt","deepSkipTracedAt"
      FROM "Lead"
     WHERE "cohort" = ${params.cohort}
       AND COALESCE("manualGrade","grade") = ${grade}
     ORDER BY "owner1LastName" NULLS LAST, "owner1FirstName" NULLS LAST` as Array<Record<string, unknown>>;

  const name = (f: unknown, l: unknown) => [f, l].filter(Boolean).join(' ').trim() || null;

  const leads: PipelineLead[] = rows.map((r) => {
    const traced = !!(r.skipTracedAt || r.blastSkipTracedAt || r.deepSkipTracedAt);
    return {
      leadId: String(r.id),
      propertyId: r.propertyId ? String(r.propertyId) : null,
      owner: name(r.owner1FirstName, r.owner1LastName),
      coInsured: name(r.owner2FirstName, r.owner2LastName),
      address: [r.addressStreet, r.addressCity, r.addressZip].filter(Boolean).join(', ') || null,
      rollName: (r.ownerVerifyName as string) ?? null,
      rollStatus: (r.ownerVerifyStatus as string) ?? null,
      detail: (r.ownerVerifyDetail as string) ?? null,
      bucket: bucketOf((r.ownerVerifyStatus as string) ?? null, r.ownerVerifyAt),
      coStatus: (r.coInsuredVerifyStatus as string) ?? null,
      coRollName: (r.coInsuredVerifyName as string) ?? null,
      traced,
      tracedBeforeRoll: traced && !r.ownerVerifyAt,
    };
  });

  /**
   * Anything needing a person first, then what the roll could not find, then the rest.
   *
   * A list of 179 leads sorted by surname buries the fourteen that need attention. The whole
   * reason for clicking into a week is to get at those, so they are at the top and the
   * confirmed ones — which need nothing — are at the bottom.
   */
  const order: Record<RollBucket, number> = { review: 0, not_on_roll: 1, not_checked: 2, confirmed: 3 };
  leads.sort((a, b) => order[a.bucket] - order[b.bucket]
    || String(a.owner ?? '').localeCompare(String(b.owner ?? '')));

  return {
    cohort: params.cohort,
    code: cohortCode(params.cohort),
    label: cohortLabel(params.cohort),
    grade,
    leads,
  };
}

export const REVIEW_STATUSES = REVIEW;
