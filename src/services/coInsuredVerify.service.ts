import { sql } from '@/lib/neon';
import { parseRollOwners, compareOwnerNames } from './ownerNameMatch.service';

/**
 * Is the co-insured on the card the person the tax roll names?
 *
 * ── Why this needed no new lookup ───────────────────────────────────────────
 * WIIP never returned "the owner" — it returns the whole deed line, both names, and
 * ownerVerifyName has held it verbatim since the first blast: "SCOTTO, DIANE & MICHAEL".
 * So the second owner has been verifiable all along. What was missing was somewhere to put
 * the answer: the insured's sits on the card as ownerVerifyStatus and can be filtered and
 * counted, while the co-insured's existed only inside the override tool. "Show me every
 * card where the co-insured disagrees with the roll" was not a question anybody could ask,
 * and on 2 Oct the answer was 118 cards.
 *
 * ── Derived, never guessed ──────────────────────────────────────────────────
 * Every status below comes from a record we already hold. A card with no WIIP record gets
 * null rather than a status — not knowing is not the same as knowing there is nobody, and
 * a verification that answers for an unchecked card is worse than one that stays silent.
 */

export type CoInsuredVerifyStatus =
  /** The card and the roll name the same second owner. */
  | 'match'
  /** Close but not exact — a spelling, a middle name, a maiden name. */
  | 'partial'
  /** The roll names a DIFFERENT person than the card does. */
  | 'mismatch'
  /** The roll names a second owner and the card names nobody (Frank, item 8). */
  | 'found_on_wiip'
  /** The roll names only one person. */
  | 'none_on_roll'
  /** A trust or company — there is no second person to name. */
  | 'entity';

export interface CoInsuredVerdict {
  status: CoInsuredVerifyStatus;
  /** The second party as the roll writes them. Null when the roll names nobody. */
  rollName: string | null;
  detail: string;
}

/**
 * Pure: no database, no network. The same inputs always give the same verdict.
 *
 * ── Two corrections that cost this report its first draft ───────────────────
 * The first version compared the card's co-insured against parseRollOwners' second party
 * and nothing else, and it called three of its first four rows "different person" wrongly:
 *
 *   "CHANDRA, HARISH & S RADHAKRISHNAN"  read as "Radhakrishnan Chandra" because a bare
 *   second party inherits the first's surname. The card said Saranya Radhakrishnan — the
 *   roll AGREED with it, and we reported a conflict.
 *
 *   "PAIGE, JESSICA A & GRINSHPOON,ALEXA"  on a card whose insured is Grinshpoon and whose
 *   co-insured is Jessica Paige. The same two people in the other order, reported as a
 *   stranger on the deed.
 *
 * Both were already solved in wiipOwnerOverride yesterday — secondParty() for the surname,
 * cardHoldsOtherOwner for the swap — and this file reimplemented the question weakly
 * instead of reusing the answer. secondParty is now imported rather than copied, because a
 * second copy is how the two drift apart again.
 */
export function verifyCoInsured(lead: {
  owner1FirstName?: string | null;
  owner1LastName?: string | null;
  owner2FirstName?: string | null;
  owner2LastName?: string | null;
  ownerVerifyName?: string | null;
}): CoInsuredVerdict | null {
  const roll = String(lead.ownerVerifyName ?? '').trim();
  // No WIIP record: stay silent rather than assert anything.
  if (!roll) return null;

  const parsed = parseRollOwners(roll);
  if (parsed.isEntity) {
    return {
      status: 'entity',
      rollName: null,
      detail: 'The roll shows a trust or company, so there is no second person to name.',
    };
  }
  if (!parsed.person2?.display) {
    return {
      status: 'none_on_roll',
      rollName: null,
      detail: 'The roll names one owner only.',
    };
  }

  const theirs = parsed.person2.display;
  const first = String(lead.owner2FirstName ?? '').trim();
  const last = String(lead.owner2LastName ?? '').trim();

  if (!first && !last) {
    return {
      status: 'found_on_wiip',
      rollName: theirs,
      detail: `The roll names a second owner — ${theirs} — and the card names nobody.`,
    };
  }

  /**
   * Compared against the WHOLE deed line, not just the second party.
   *
   * parseRollOwners returns at most two people, so a deed naming three — "LAZBIN, NAUM &
   * ALEKSANDR & LAZBINA," — was only ever checked against Aleksandr, and Olga Lazbina came
   * back a mismatch while sitting third on her own deed. compareOwnerNames walks every
   * party, so handing it the raw string asks the question we actually mean: is the card's
   * second person named anywhere on this record?
   *
   * `theirs` is still what gets reported, because the reviewer needs to see the person we
   * expected rather than the whole line.
   */
  const cmp = compareOwnerNames({ first, last }, roll);
  /**
   * 'unknown' folded into 'partial' rather than given its own status.
   *
   * compareOwnerNames returns unknown when there is not enough on one side to compare —
   * an initial against a full name, say. That is a thing to glance at, which is what
   * partial already means; a sixth status whose only instruction is "look at it" would
   * split one queue into two for no gain.
   */
  const status: CoInsuredVerifyStatus =
    cmp.result === 'match' ? 'match'
      : cmp.result === 'mismatch' ? 'mismatch'
        : 'partial';

  /**
   * ── The verdict says they differ, never that they are different people ────
   *
   * It said "Different people." for a while, and it was wrong on three of the first four
   * rows a human looked at:
   *
   *   "CHANDRA, HARISH & S RADHAKRISHNAN"   the card's Saranya Radhakrishnan is the S.
   *   "PAIGE, JESSICA A & GRINSHPOON,ALEXA" the same two people, listed the other way up.
   *   "GRAHAM, PATRICK & KRISTI"            Kristi Schiavone, almost certainly by maiden name.
   *
   * Two attempts to adjudicate those automatically — a swap check and a surname refinement
   * — each failed on the cases they were written for and moved eight more rows into the
   * wrong bucket. A bare "S" is dropped as noise; "Alexa" and "Alexander" are not equal.
   * The roll is written by municipal clerks and is not consistent enough to resolve this
   * from the string.
   *
   * So the report states the fact and leaves the judgement. The two names sit in adjacent
   * columns and a person decides in a second — which is the thing the screen is for, and
   * cheaper than a confident label that is wrong one time in three.
   */
  return {
    status,
    rollName: theirs,
    detail: status === 'mismatch'
      ? `The card says ${first} ${last}; the roll says ${theirs}.`
      : status === 'match'
        ? `The card and the roll agree on ${theirs}.`
        : `${cmp.detail} — card "${first} ${last}", roll "${theirs}".`,
  };
}

/**
 * Write the verdict onto every card that has a WIIP record.
 *
 * Idempotent and safe to re-run: it recomputes from ownerVerifyName, which is the only
 * input, so running it after a WIIP blast is how the new records get their verdict.
 */
export async function backfillCoInsuredVerify(opts: { cohorts?: string[] } = {}): Promise<{
  checked: number; written: number; byStatus: Record<string, number>;
}> {
  const cohorts = opts.cohorts ?? [];
  const rows = await sql`
    SELECT "id", "owner2FirstName", "owner2LastName", "ownerVerifyName"
      FROM "Lead"
     WHERE "ownerVerifyName" IS NOT NULL AND "ownerVerifyName" <> ''
       AND (${cohorts.length === 0} OR "cohort"::text = ANY(${cohorts}::text[]))` as Array<Record<string, any>>;

  const byStatus: Record<string, number> = {};
  let written = 0;
  for (const r of rows) {
    const v = verifyCoInsured(r);
    if (!v) continue;
    byStatus[v.status] = (byStatus[v.status] ?? 0) + 1;
    await sql`
      UPDATE "Lead"
         SET "coInsuredVerifyStatus" = ${v.status},
             "coInsuredVerifyName"   = ${v.rollName},
             "coInsuredVerifyDetail" = ${v.detail},
             "coInsuredVerifyAt"     = NOW()
       WHERE "id" = ${String(r.id)}`;
    written++;
  }
  return { checked: rows.length, written, byStatus };
}
