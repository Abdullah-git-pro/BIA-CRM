import { sql } from '@/lib/neon';
import { numbersOnCard, notTheirsByLead } from './callLog.service';

/**
 * How much of the calling has actually been done — per number, not per card.
 *
 * ── Why this exists ─────────────────────────────────────────────────────────
 * Frank, 1 Oct 2026: "On 9/29 only 8 cards had a call outcome logged, so we can't tell a
 * dead number from an unanswered one." He then asked Ruben directly whether every account
 * in C1 had been called, and said he was "a little blind here".
 *
 * Nobody could answer, because nothing counted it. The card shows its own attempts and the
 * queue hands out the next lead, but there was no view that put numbers held against
 * numbers worked. On C1 that gap was 326 numbers on file against 15 with an outcome, and
 * 55 of 62 cards never touched — a fact that had gone unremarked through two weeks of
 * calling and two rounds of questions about why contact rates were low.
 *
 * ── Per number, because that is the unit of work ────────────────────────────
 * A card with six numbers and one voicemail is not a worked card, but every per-card
 * measure counts it as one. That is how "we called them" and "we reached nobody" both
 * stayed true at the same time. Frank's Friday readout asks for connects, wrong numbers
 * and disconnects per card against 9/29, and none of those divide out of a card-level
 * count.
 *
 * ── Dialled is matched on digits ────────────────────────────────────────────
 * The attempt stores whatever the panel sent it and the card stores whatever the vendor
 * returned, so "(732) 555-0101" and "7325550101" are the same number written twice. Compared
 * as strings they are two, and the coverage figure silently flatters itself.
 */

export interface NumberCoverage {
  number: string;
  role: 'insured' | 'co_insured';
  label: string;
  dnc: boolean;
  rank: number | null;
  type: string | null;
  /** The outcome logged against this number, or null if it has never been dialled. */
  outcome: string | null;
  attemptedAt: string | null;
}

export interface CardCoverage {
  leadId: string;
  propertyId: string | null;
  owner: string;
  cohort: string | null;
  held: number;
  worked: number;
  /** Every number on the card, worked or not, in the order Ruben should dial them. */
  numbers: NumberCoverage[];
  lastAttemptAt: string | null;
  /** Distinct Eastern days dialled — half of Frank's three-attempt rule. */
  days: number;
  state: 'untouched' | 'partial' | 'complete' | 'no_numbers';
}

export interface CoverageSummary {
  cards: number;
  cardsUntouched: number;
  cardsPartial: number;
  cardsComplete: number;
  cardsNoNumbers: number;
  numbersHeld: number;
  numbersWorked: number;
  byOutcome: Record<string, number>;
}

/** Digits only, and a leading country code dropped, so the two spellings compare equal. */
const digits = (s: unknown) => String(s ?? '').replace(/\D/g, '').replace(/^1(?=\d{10}$)/, '');

/**
 * The Eastern calendar day, matching callLog's rule.
 *
 * A call placed at 11:42 PM in New Jersey stores as 04:42 UTC the next day, so counting UTC
 * days splits one evening's calling in two — and "three attempts on different days" is a
 * rule two calls in one evening could then satisfy.
 */
const easternDay = (d: Date | string) =>
  new Date(d).toLocaleDateString('en-CA', { timeZone: 'America/New_York' });

export async function callCoverage(opts: {
  cohorts?: string[];
  grade?: string;
} = {}): Promise<{ summary: CoverageSummary; cards: CardCoverage[] }> {
  const cohorts = opts.cohorts ?? [];
  const grade = opts.grade ?? '';
  const leads = await sql`
    SELECT * FROM "Lead"
     WHERE (${cohorts.length === 0} OR "cohort"::text = ANY(${cohorts}::text[]))
       AND (${grade === ''} OR "grade" = ${grade})` as Array<Record<string, any>>;

  const ids = leads.map((l) => String(l.id));
  const attempts = ids.length
    ? await sql`
        SELECT "leadId", "numberDialled", "outcome", "attemptedAt"
          FROM "CallAttempt"
         WHERE "leadId" = ANY(${ids}::text[])
         ORDER BY "attemptedAt" ASC` as Array<Record<string, any>>
    : [];

  /**
   * Last outcome wins for a number dialled more than once.
   *
   * A number that was no_answer on Monday and reached on Wednesday is a reached number; the
   * reverse ordering would record the household as never contacted. Attempts arrive oldest
   * first above, so the later write replaces the earlier one.
   */
  const byLead = new Map<string, Map<string, { outcome: string | null; at: string }>>();
  const days = new Map<string, Set<string>>();
  for (const a of attempts) {
    const lead = String(a.leadId);
    if (!byLead.has(lead)) byLead.set(lead, new Map());
    byLead.get(lead)!.set(digits(a.numberDialled), {
      outcome: a.outcome ?? null,
      at: a.attemptedAt ? new Date(a.attemptedAt).toISOString() : '',
    });
    if (a.attemptedAt) {
      if (!days.has(lead)) days.set(lead, new Set());
      days.get(lead)!.add(easternDay(a.attemptedAt));
    }
  }

  const cards: CardCoverage[] = [];
  const summary: CoverageSummary = {
    cards: 0,
    cardsUntouched: 0,
    cardsPartial: 0,
    cardsComplete: 0,
    cardsNoNumbers: 0,
    numbersHeld: 0,
    numbersWorked: 0,
    byOutcome: {},
  };

  // Same definition of "a number on this card" as the lead card and the Phone screen.
  const notTheirsMap = await notTheirsByLead();

  for (const lead of leads) {
    const leadId = String(lead.id);
    const notTheirs = notTheirsMap.get(leadId) ?? new Set();
    const onCard = numbersOnCard(lead).filter((n) => !notTheirs.has(n.number));
    const tried = byLead.get(leadId) ?? new Map();

    const numbers: NumberCoverage[] = onCard.map((n) => {
      const hit = tried.get(digits(n.number));
      return {
        number: n.number,
        role: n.role,
        label: n.label,
        dnc: n.dnc,
        rank: n.rank,
        type: n.type,
        outcome: hit?.outcome ?? null,
        attemptedAt: hit?.at || null,
      };
    });

    const worked = numbers.filter((n) => n.outcome).length;
    const state: CardCoverage['state'] = !numbers.length
      ? 'no_numbers'
      : worked === 0 ? 'untouched'
        : worked === numbers.length ? 'complete' : 'partial';

    /**
     * A number dialled that is no longer on the card still counts as work done.
     *
     * Skip tracing replaces numbers, and a trace run after a call can drop the number that
     * was dialled. Counting only what is on the card today would quietly erase Ruben's
     * attempts every time a card is re-traced — and re-tracing is exactly what this week's
     * plan does to all of C1.
     */
    const offCard = [...tried.keys()].filter((d) => !numbers.some((n) => digits(n.number) === d)).length;

    summary.cards++;
    summary.numbersHeld += numbers.length;
    summary.numbersWorked += worked + offCard;
    if (state === 'no_numbers') summary.cardsNoNumbers++;
    else if (state === 'untouched') summary.cardsUntouched++;
    else if (state === 'complete') summary.cardsComplete++;
    else summary.cardsPartial++;
    for (const n of numbers) {
      if (n.outcome) summary.byOutcome[n.outcome] = (summary.byOutcome[n.outcome] ?? 0) + 1;
    }

    const attemptedAts = numbers.map((n) => n.attemptedAt).filter(Boolean) as string[];
    cards.push({
      leadId,
      propertyId: lead.propertyId ? String(lead.propertyId) : null,
      owner: [lead.owner1FirstName, lead.owner1LastName].filter(Boolean).join(' ').trim(),
      cohort: lead.cohort ? String(lead.cohort) : null,
      held: numbers.length,
      worked,
      numbers,
      lastAttemptAt: attemptedAts.length ? attemptedAts.sort().slice(-1)[0] : null,
      days: days.get(leadId)?.size ?? 0,
      state,
    });
  }

  /**
   * Least-worked first. The list is a worklist before it is a report, and a report that
   * opens on the cards already finished buries the ones that are not.
   */
  const order = { untouched: 0, partial: 1, complete: 2, no_numbers: 3 } as const;
  cards.sort((a, b) => order[a.state] - order[b.state] || b.held - a.held);

  return { summary, cards };
}
