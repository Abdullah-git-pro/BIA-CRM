/**
 * House numbers with a unit squashed into them, and what they might actually mean.
 *
 * "121d Muhlen Platz" is almost certainly 121, unit D. The printer refused it outright —
 * "does not meet your minimum deliverability strictness" — and it is not one record: 261
 * addresses across C1–C8 carry this shape, 109 of them Grade A, which is a fifth of every
 * letter we would post.
 *
 * ── Why this returns candidates and not an answer ───────────────────────────
 * Because the obvious rule is wrong often enough to matter. On 189418486 the property reads
 * "85i Winthrop Rd" while the mailing address for the same house reads "851 Winthrop Road":
 * the trailing letter is a mis-keyed 1, not unit I. Rewriting that to "85 Unit I" would turn
 * a correct house number into a wrong one and post a letter to a house that does not exist.
 *
 * Other shapes are genuinely ambiguous in both directions:
 *
 *   348n Newport Way     unit N, or "348 N Newport Way" — a compass direction
 *   9-5 Boise Ct         unit 5 at number 9, or a hyphenated house number
 *   4-A Alabama Ct       unit A — and this card's OTHER field already says "4 Alabama Ct # A"
 *
 * So this proposes; it never decides. Each candidate is a form USPS can be asked about, and
 * the deliverable one is the answer. Guessing without asking is how a batch of corrections
 * becomes a batch of new errors, with the difference that nobody is looking for these.
 */

/** Already spelled out properly — nothing to propose. */
const HAS_UNIT_WORD = /\b(UNIT|APT|APARTMENT|STE|SUITE|BLDG|BUILDING|FL|FLOOR|RM|ROOM)\b|#/i;

/** 121d Muhlen Platz · 26B Guesta De Gomerez · 85i Winthrop Rd */
const SUFFIX_LETTER = /^(\d+)([A-Za-z])\s+(.+)$/;
/** 502-7 Harding Rd · 25-12 Wyeth Dr · 4-A Alabama Ct */
const HYPHEN_UNIT = /^(\d+)-([A-Za-z0-9]{1,4})\s+(.+)$/;

/**
 * Letters that are commonly a mistyped or mis-scanned digit.
 *
 * Only these produce a "the letter is really a digit" candidate, because only these are
 * plausible as one. A trailing D or B is a unit; a trailing I or O beside a house number is
 * as likely to be 1 or 0 — which is exactly what 85i turned out to be.
 */
const DIGIT_LOOKALIKE: Record<string, string> = { i: '1', l: '1', o: '0', O: '0', I: '1', L: '1' };

/** A trailing letter that may be a compass direction rather than a unit. */
const DIRECTIONS = new Set(['n', 's', 'e', 'w']);

export type UnitShape = 'suffix_letter' | 'hyphen_unit' | null;

export type UnitProposal = {
  original: string;
  shape: UnitShape;
  /**
   * Forms worth asking USPS about, best guess first. Empty when there is nothing to
   * propose — which is the common case and must stay cheap.
   */
  candidates: string[];
  /** Why there is more than one, for the screen that shows them to a person. */
  note: string | null;
};

export function unitShape(street: string): UnitShape {
  const v = String(street ?? '').trim();
  if (!v || HAS_UNIT_WORD.test(v)) return null;
  if (SUFFIX_LETTER.test(v)) return 'suffix_letter';
  if (HYPHEN_UNIT.test(v)) return 'hyphen_unit';
  return null;
}

export function proposeUnit(street: string): UnitProposal {
  const original = String(street ?? '').trim();
  const shape = unitShape(original);
  if (!shape) return { original, shape: null, candidates: [], note: null };

  const candidates: string[] = [];
  let note: string | null = null;

  if (shape === 'suffix_letter') {
    const m = original.match(SUFFIX_LETTER)!;
    const [, number, letter, rest] = m;

    candidates.push(`${number} ${rest} Unit ${letter.toUpperCase()}`);

    if (DIRECTIONS.has(letter.toLowerCase())) {
      // "348 N Newport Way" — a direction belongs before the street, not after it.
      candidates.push(`${number} ${letter.toUpperCase()} ${rest}`);
      note = `"${letter.toUpperCase()}" may be a compass direction rather than a unit.`;
    }

    const digit = DIGIT_LOOKALIKE[letter];
    if (digit) {
      candidates.push(`${number}${digit} ${rest}`);
      note = `"${letter}" may be a mistyped ${digit} — on 85i Winthrop Rd it was.`;
    }
  }

  if (shape === 'hyphen_unit') {
    const m = original.match(HYPHEN_UNIT)!;
    const [, number, unit, rest] = m;
    // A number after the hyphen is usually an apartment; a letter is usually a unit.
    const word = /^\d+$/.test(unit) ? 'Apt' : 'Unit';
    candidates.push(`${number} ${rest} ${word} ${unit.toUpperCase()}`);
    candidates.push(`${number} ${rest} ${word === 'Apt' ? 'Unit' : 'Apt'} ${unit.toUpperCase()}`);
    note = 'The hyphen may separate a unit, or may be part of the house number itself.';
  }

  return { original, shape, candidates, note };
}

/**
 * The other address field on the same card, used as evidence rather than as a guess.
 *
 * The two columns come from different sources and disagree in both directions: one card has
 * the mailing address as "26 Guesta De Gomerez Unit B" and the property as "26b Guesta De
 * Gomerez", and another has them the other way round. Where one side already spells the
 * unit out, that is the answer — no candidate list and nothing to ask anybody.
 */
export function preferSpelledOut(a: string | null | undefined, b: string | null | undefined): string | null {
  const A = String(a ?? '').trim();
  const B = String(b ?? '').trim();
  if (!A || !B) return null;
  const aOk = !!A && HAS_UNIT_WORD.test(A) && !unitShape(A);
  const bOk = !!B && HAS_UNIT_WORD.test(B) && !unitShape(B);
  if (aOk && !bOk) return A;
  if (bOk && !aOk) return B;
  return null;
}
