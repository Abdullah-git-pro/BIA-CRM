import { sql } from '@/lib/neon';
import { cohortCode, cohortLabel } from './cohort';

/**
 * Everything in the pipeline that is waiting on a person (Abdullah, 14 Oct 2026).
 *
 * ── Why one screen and not a filter on each existing one ────────────────────
 * The verdicts that need a human are spread across three columns and a table — the roll's
 * answer about the insured, its answer about the co-insured, and the identity check on the
 * numbers. Asking "what is waiting on me" meant knowing all four places to look, so in
 * practice nobody asked. The Pipeline screen counts them; this is where the work itself is.
 *
 * ── Why the kinds are kept apart ────────────────────────────────────────────
 * They are not one pile. "A relative is on the deed" and "the property appears to have been
 * sold" are both `mismatch`-shaped and need completely different handling, and a reviewer
 * told only "needs review" has to rediscover which one it is on every row. So each item
 * carries the question it is actually asking, in words, and the evidence to answer it
 * without opening the card.
 *
 * ── What is deliberately NOT here ───────────────────────────────────────────
 * `not_found` where the address has never been retried. Of C2's nine, seven were resolved by
 * fixing the address and the town — a person looking at "90 Cranbrook Ct" would have seen an
 * ordinary address and had nothing to do. Those belong in remediation, not in front of a
 * human, so this only lists them once the roll has actually been consulted.
 */

export type ReviewKind =
  | 'owner_same_household'
  | 'owner_different'
  | 'unit_ambiguous'
  | 'not_on_roll'
  | 'coinsured_disagrees'
  | 'no_reachable_number'
  /** The roll and the card name different units of the same building. */
  | 'unit_disagrees';

export type ReviewItem = {
  leadId: string;
  propertyId: string | null;
  cohort: string | null;
  code: string | null;
  label: string;
  kind: ReviewKind;
  /** The decision being asked for, in words a person can act on. */
  question: string;
  owner: string | null;
  coInsured: string | null;
  address: string | null;
  /** The tax roll's own line, verbatim — the evidence, not our reading of it. */
  rollName: string | null;
  coRollName: string | null;
  detail: string | null;
};

export const KIND_LABEL: Record<ReviewKind, string> = {
  owner_same_household: 'A relative may be on the deed',
  owner_different: 'The owner looks like a different person',
  unit_ambiguous: 'Which unit is ours',
  unit_disagrees: 'The township records a different unit',
  not_on_roll: 'Not on any roll we can reach',
  coinsured_disagrees: 'The co-insured disagrees with the roll',
  no_reachable_number: 'No number on the card is this household’s',
};

/**
 * Ordered by how answerable it is, not by volume.
 *
 * A reviewer should meet the questions that can be settled in seconds first — a spelling,
 * a spouse — and reach the ones needing a phone call or a new town id last. Putting the
 * biggest bucket at the top instead would lead with "not on any roll", which is the one a
 * person can do least about.
 */
const KIND_ORDER: ReviewKind[] = [
  'unit_disagrees',
  'owner_same_household',
  'coinsured_disagrees',
  'unit_ambiguous',
  'owner_different',
  'no_reachable_number',
  'not_on_roll',
];

const C1 = '2026-10-05';
const C8 = '2026-11-23';

/**
 * The unit an address names, or null when it names none.
 *
 * Reads all three ways this book writes one — "25B Pitman Rd", "25 Pitman Rd Unit B",
 * "4-B Alabama Ct" — because the township and the card rarely choose the same form, and a
 * comparison that only understood one of them would report every condo as a disagreement.
 *
 * Returns null rather than guessing on an ordinary address: "111 Ramble Way" has no unit,
 * and inventing one would raise a question about every house in the book.
 */
function unitOf(street: string | null | undefined): string | null {
  const s = String(street ?? '').trim().toUpperCase();
  if (!s) return null;
  const spelled = s.match(/\b(?:UNIT|APT|APARTMENT|STE|SUITE)\s*#?\s*([A-Z0-9]{1,4})\b/);
  if (spelled) return spelled[1];
  const hash = s.match(/#\s*([A-Z0-9]{1,4})\b/);
  if (hash) return hash[1];
  const suffix = s.match(/^\d+([A-Z])\s/);
  if (suffix) return suffix[1];
  const hyphen = s.match(/^\d+-([A-Z0-9]{1,4})\s/);
  if (hyphen) return hyphen[1];
  return null;
}

export async function getReviewQueue(params: { grade?: string } = {}): Promise<{
  items: ReviewItem[];
  counts: Record<ReviewKind, number>;
  /** Every week that has at least one item, newest first — the filter builds from this. */
  cohorts: Array<{ cohort: string; code: string | null; label: string; count: number }>;
  /**
   * Cards no reviewer can settle: the township does not publish a roll on a system we can
   * read. Counted and named so the work is visible, kept OUT of items so the queue stays a
   * list of decisions somebody can actually take.
   */
  blocked: { total: number; byZip: Array<{ zip: string; city: string | null; count: number }> };
  grade: string;
}> {
  // Grade A only for now (Abdullah, 14 Oct) — Grade B comes after the flow is settled.
  const grade = params.grade || 'A';

  const rows = await sql`
    SELECT l."id", l."propertyId", l."cohort",
           l."owner1FirstName", l."owner1LastName", l."owner2FirstName", l."owner2LastName",
           l."addressStreet", l."addressCity", l."addressZip", l."rollPropertyLoc",
           l."ownerVerifyName", l."ownerVerifyStatus", l."ownerVerifyDetail",
           l."coInsuredVerifyName", l."coInsuredVerifyStatus", l."coInsuredVerifyDetail",
           /*
            * Numbers the identity check attributed to somebody else, and how many the card
            * holds at all. A card where those two are equal has nothing left to ring, which
            * is a different problem from a name question and is asked as one.
            */
           (SELECT COUNT(*)::int FROM "ContactVerification" v
             WHERE v."leadId" = l."id" AND v."channel" = 'phone' AND v."nameMatch" IS FALSE) AS "notTheirs",
           (SELECT COUNT(*)::int FROM "ContactVerification" v
             WHERE v."leadId" = l."id" AND v."channel" = 'phone') AS "graded"
      FROM "Lead" l
     WHERE l."cohort" >= ${C1} AND l."cohort" <= ${C8}
       AND COALESCE(l."manualGrade", l."grade") = ${grade}
     ORDER BY l."cohort" DESC, l."owner1LastName"` as Array<Record<string, unknown>>;

  const name = (f: unknown, l: unknown) => [f, l].filter(Boolean).join(' ').trim() || null;
  const items: ReviewItem[] = [];
  const blockedByZip = new Map<string, { zip: string; city: string | null; count: number }>();

  for (const r of rows) {
    const base = {
      leadId: String(r.id),
      propertyId: r.propertyId ? String(r.propertyId) : null,
      cohort: r.cohort ? String(r.cohort) : null,
      code: cohortCode(r.cohort as string),
      label: cohortLabel(r.cohort as string),
      owner: name(r.owner1FirstName, r.owner1LastName),
      coInsured: name(r.owner2FirstName, r.owner2LastName),
      address: [r.addressStreet, r.addressCity, r.addressZip].filter(Boolean).join(', ') || null,
      rollName: (r.ownerVerifyName as string) ?? null,
      coRollName: (r.coInsuredVerifyName as string) ?? null,
    };

    const status = r.ownerVerifyStatus as string | null;
    const coStatus = r.coInsuredVerifyStatus as string | null;
    const notTheirs = Number(r.notTheirs ?? 0);
    const graded = Number(r.graded ?? 0);

    /**
     * One lead can raise more than one question and each is its own item.
     *
     * Collapsing to "this lead needs review" would hide that a card can have both a name
     * question and no reachable number — two decisions, taken by different people, on
     * different evidence.
     */
    if (status === 'partial') {
      items.push({ ...base, kind: 'owner_same_household', detail: (r.ownerVerifyDetail as string) ?? null,
        question: `Is ${base.owner} the policyholder, or is the person on the deed a relative?` });
    }
    if (status === 'mismatch') {
      items.push({ ...base, kind: 'owner_different', detail: (r.ownerVerifyDetail as string) ?? null,
        question: 'Has this property changed hands, or is the card on the wrong address?' });
    }
    if (status === 'ambiguous') {
      items.push({ ...base, kind: 'unit_ambiguous', detail: (r.ownerVerifyDetail as string) ?? null,
        question: 'Which of these units is ours?' });
    }
    /**
     * The roll and the card disagree about WHICH UNIT.
     *
     * Not a spelling difference and not something a normaliser settles: on 109 Deepwater
     * Circle the township records unit A and both of our address columns say B. One of them
     * describes a different home, and a letter quoting a premium to the wrong flat in the
     * right building is the same disclosure as sending it to the wrong street.
     *
     * Raised apart from the name questions because the evidence is different — a reviewer
     * needs the deed, not the policy — and because no automatic rule should resolve it. The
     * address repair script skips this case deliberately for the same reason.
     */
    const rollUnit = unitOf(r.rollPropertyLoc as string | null);
    const cardUnit = unitOf(r.addressStreet as string | null);
    if (rollUnit && cardUnit && rollUnit !== cardUnit) {
      items.push({
        ...base,
        kind: 'unit_disagrees',
        detail: `Tax roll: ${r.rollPropertyLoc} · card: ${r.addressStreet}`,
        question: 'The township records a different unit from the card — which one is ours?',
      });
    }

    if (status === 'not_found') {
      items.push({ ...base, kind: 'not_on_roll', detail: (r.ownerVerifyDetail as string) ?? null,
        question: 'The address was retried and the towns we hold do not list it — which town is it in?' });
    }
    /**
     * Not a review item.
     *
     * Old Bridge, Matawan and Aberdeen each run their tax portal on a different system, so
     * there is no roll for this module to read and no id anybody can go and fetch — checked
     * against each township's own site on 14 Oct. A reviewer opening one of these cards can
     * do nothing with it, and a queue that keeps handing them out teaches people to scroll
     * past it. Counted below instead.
     */
    if (status === 'unsupported') {
      const zip = String(r.addressZip ?? '').trim() || '(no ZIP)';
      const b = blockedByZip.get(zip) ?? { zip, city: (r.addressCity as string) ?? null, count: 0 };
      b.count++;
      blockedByZip.set(zip, b);
    }
    if (coStatus === 'partial' || coStatus === 'mismatch') {
      items.push({ ...base, kind: 'coinsured_disagrees', detail: (r.coInsuredVerifyDetail as string) ?? null,
        question: base.coInsured
          ? `The card says ${base.coInsured}; the roll says ${base.coRollName ?? 'somebody else'}. Which is the second person?`
          : 'The roll names a second owner the card does not have — should it be added?' });
    }
    // Only meaningful once the numbers have actually been checked.
    if (graded > 0 && notTheirs > 0 && notTheirs === graded) {
      items.push({ ...base, kind: 'no_reachable_number', detail: `All ${graded} checked numbers are registered to somebody else.`,
        question: 'Nothing on this card reaches the household — send it to the post?' });
    }
  }

  items.sort((a, b) => KIND_ORDER.indexOf(a.kind) - KIND_ORDER.indexOf(b.kind)
    || String(b.cohort ?? '').localeCompare(String(a.cohort ?? ''))
    || String(a.owner ?? '').localeCompare(String(b.owner ?? '')));

  const counts = Object.fromEntries(KIND_ORDER.map((k) => [k, 0])) as Record<ReviewKind, number>;
  for (const i of items) counts[i.kind]++;

  /**
   * Weeks are derived from the items, not from the cohort list.
   *
   * A filter offering a week with nothing in it is a dead end somebody clicks once and then
   * stops trusting. These are the weeks that actually have work.
   */
  const byCohort = new Map<string, { cohort: string; code: string | null; label: string; count: number }>();
  for (const i of items) {
    if (!i.cohort) continue;
    const e = byCohort.get(i.cohort)
      ?? { cohort: i.cohort, code: i.code, label: i.label, count: 0 };
    e.count++;
    byCohort.set(i.cohort, e);
  }
  const cohorts = [...byCohort.values()].sort((a, b) => (a.cohort < b.cohort ? 1 : -1));

  const blocked = {
    total: [...blockedByZip.values()].reduce((t, b) => t + b.count, 0),
    byZip: [...blockedByZip.values()].sort((a, b) => b.count - a.count),
  };

  return { items, counts, cohorts, blocked, grade };
}
