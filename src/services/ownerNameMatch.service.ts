/**
 * Owner-name matching — compares the insured name we hold against an authoritative
 * public record (municipal tax roll).
 *
 * The two sides are formatted differently and both are messy:
 *   ours   → owner1FirstName "Theresa", owner1LastName "Brummer"
 *   theirs → "BRUMMER, THERESA"   (LAST, FIRST — all caps)
 *
 * Built against the real book (1,028 owner names), which contains:
 *   219 entities with no first name ("Kasmon Llc")   148 LLC/Inc/Corp
 *    69 middle initials ("Irene C Casamento")         42 trusts
 *    18 two-person names ("Michael Tarantul & Tatyana Tarantul")
 *    15 suffixes ("Raymond Mcmanus Jr")                6 hyphenated
 *
 * Deliberately returns a GRADED result, not a boolean. A surname match with a
 * different first name is extremely common and legitimate — a tax roll often lists
 * a spouse, a co-owner, or the owners in a different order. Calling that a failure
 * would bury producers in false alarms; calling it a pass would defeat the purpose.
 * So it surfaces as 'partial' for a human to glance at.
 */

export type NameMatchResult = 'match' | 'partial' | 'mismatch' | 'unknown';

export interface NameComparison {
  result: NameMatchResult;
  /** Short, human-readable reason — shown in the UI tooltip / QC report. */
  detail: string;
  ours: string;
  theirs: string;
}

const SUFFIXES = new Set(['JR', 'SR', 'II', 'III', 'IV', 'V']);

/**
 * Latin tenancy markers the roll appends to an owner string: ET AL (and others), ET UX
 * (and wife), ET VIR (and husband).
 *
 * They are not name tokens. Read as one, "SIMONE, JENNIFER, ETAL" parsed to the first
 * name "Jennifer Etal" — a person no skip trace will ever find, and 15 credits to discover
 * it. They also carry real information in the other direction: the roll is stating there
 * ARE further owners it has not named, which is the opposite of "this property has a
 * single owner" and must not be recorded as one.
 *
 * Two regexes rather than one: a /g regex keeps `lastIndex` between calls, so reusing it
 * for .test() returns alternating answers on identical input.
 */
const OWNER_MARKER = /\bET\.?\s*(?:AL|UX|VIR)\.?\b/i;
const OWNER_MARKER_G = /\bET\.?\s*(?:AL|UX|VIR)\.?\b/gi;

/** The roll is telling us other owners exist that it has not named. */
export const hasUnnamedOwners = (raw: unknown): boolean => OWNER_MARKER.test(String(raw ?? ''));

/** Remove the markers and the comma they leave stranded behind them. */
function stripOwnerMarkers(raw: unknown): string {
  return String(raw ?? '')
    .replace(OWNER_MARKER_G, ' ')
    .replace(/\s*,\s*(?=,|$)/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}
const ENTITY_WORDS = /\b(LLC|L\.L\.C|INC|CORP|CORPORATION|COMPANY|CO|HOLDINGS|PROPERTIES|PROPERTY|LP|LLP|LTD|TRUST|ESTATE|TOWNSHIP|BOROUGH|CITY|ASSOCIATES|PARTNERS|REALTY|REVOCABLE|IRREVOCABLE|LIVING|FAMILY)\b/;
// Words that carry no identifying signal when comparing entity names.
const ENTITY_NOISE = new Set(['THE', 'LLC', 'INC', 'CORP', 'CORPORATION', 'COMPANY', 'CO', 'LP', 'LLP', 'LTD',
  'TRUST', 'REVOCABLE', 'IRREVOCABLE', 'LIVING', 'FAMILY', 'ESTATE', 'OF', 'AND', 'A']);

/** Upper-case, strip accents/punctuation, collapse whitespace. */
function norm(s: unknown): string {
  return String(s ?? '')
    .normalize('NFD').replace(/[̀-ͯ]/g, '')
    .toUpperCase()
    /**
     * Apostrophes are DELETED; stops and commas become spaces.
     *
     * Turning an apostrophe into a space split "O'CONNELL" into "O CONNELL", and coreTokens
     * then dropped the "O" as a middle initial — so the roll's O'CONNELL was stored and
     * compared as plain "CONNELL", and Laura O'Connell read as a different surname from
     * herself. Deleting it gives "OCONNELL" on both sides, which is the same woman however
     * either source types her name. The curly apostrophe is covered for the same reason as
     * in the address normaliser: it arrives from anything that has been through a word
     * processor.
     */
    .replace(/['’ʼ`]/g, '')
    .replace(/[.,]/g, ' ')
    .replace(/-/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

const isEntity = (s: string) => ENTITY_WORDS.test(s);

/**
 * Suffixes removed, initials KEPT — the shape of a bare second party depends on them.
 *
 * coreTokens drops single letters, which is right when comparing names and wrong when
 * deciding what a party is: "S BODDAPATI" collapsed to one token, so the SURNAME was read
 * as the first name and the card got "Boddapati Venkata".
 */
function allTokens(s: string): string[] {
  return norm(s).split(' ').filter(Boolean).filter((t) => !SUFFIXES.has(t));
}

/** Drop suffixes and single-letter middle initials — never the only real name token. */
function coreTokens(s: string): string[] {
  const toks = norm(s).split(' ').filter(Boolean).filter((t) => !SUFFIXES.has(t));
  const meaningful = toks.filter((t) => t.length > 1);
  return meaningful.length ? meaningful : toks;
}

/**
 * Split a record-side name into { first, last }. Handles "LAST, FIRST" (the tax-roll
 * convention) and plain "First Last". Returns null for entity names, which are
 * compared whole rather than by first/last.
 */
function splitPerson(raw: string): { first: string; last: string } | null {
  // NB: test the RAW string for the comma — norm() strips punctuation, so checking
  // the normalized value would never detect the "LAST, FIRST" tax-roll convention
  // and every record name would be parsed backwards.
  const rawStr = String(raw ?? '');
  if (!norm(rawStr)) return null;
  if (rawStr.includes(',')) {
    const [lastPart, firstPart = ''] = rawStr.split(',');
    return { last: coreTokens(lastPart).join(' '), first: coreTokens(firstPart).join(' ') };
  }
  const toks = coreTokens(rawStr);
  if (toks.length < 2) return { last: toks[0] ?? '', first: '' };
  return { last: toks[toks.length - 1], first: toks[0] };
}

/** Two-person records ("MICHAEL TARANTUL & TATYANA TARANTUL") → each side separately. */
function splitParties(raw: string): string[] {
  return String(raw ?? '')
    .split(/\s*(?:&| AND )\s*/i)
    .map((p) => p.trim())
    .filter(Boolean);
}

/** Order-independent token overlap, used for entity names. */
function entityOverlap(a: string, b: string): number {
  const sig = (s: string) => new Set(coreTokens(s).filter((t) => !ENTITY_NOISE.has(t)));
  const A = sig(a); const B = sig(b);
  if (!A.size || !B.size) return 0;
  let hit = 0;
  A.forEach((t) => { if (B.has(t)) hit++; });
  return hit / Math.min(A.size, B.size);
}

/** Same first name, allowing one to be an initial ("C" vs "CHARLES"). */
function firstNamesAgree(a: string, b: string): boolean {
  if (!a || !b) return false;
  if (a === b) return true;
  const [x, y] = a.length <= b.length ? [a, b] : [b, a];
  if (x.length === 1) return y.startsWith(x);      // initial vs full
  /**
   * A whole extra given name is still the same person: we hold "Michelle", the roll holds
   * "MICHELLE LEIGH". The prefix ends on a word boundary, so nothing was cut in half.
   */
  return y.startsWith(`${x} `);
}

/**
 * One given name is a prefix of the other — ALLA/ALLAN, DAN/DANIEL.
 *
 * This used to count as a full match, and it is not safe enough to: the same test returns
 * true for ALEXA/ALEXANDER, CARL/CARLA, ROB/ROBERTA and JEAN/JEANNE, which are different
 * people. A real card had the insured Alexander Grinshpoon and the roll's second owner
 * Alexa Grinshpoon; graded a match, an automatic override would have replaced the
 * policyholder with a relative and then skip traced her instead of him.
 *
 * So it now softens a mismatch to 'partial' — a human glance — rather than asserting the
 * two are one person. ALLA/ALLAN costs one review; ALEXA/ALEXANDER costs a wrong card.
 */
function firstNamesPrefix(a: string, b: string): boolean {
  if (!a || !b || a === b) return false;
  const [x, y] = a.length <= b.length ? [a, b] : [b, a];
  // Mid-word only. A prefix ending on a space is an extra given name, which
  // firstNamesAgree already accepts as the same person.
  return x.length >= 3 && y.startsWith(x) && !y.startsWith(`${x} `);
}

/**
 * Surnames agree. Compound surnames are spaced inconsistently between our records and
 * the tax roll — "De Vito" vs "DEVITO", "Van Dusen" vs "VANDUSEN", "Mc Grath" vs
 * "MCGRATH" — so compare with the spaces removed as well. (Real miss found while
 * sampling Howell: Michael De Vito was reported as a mismatch against DEVITO, MICHAEL.)
 */
function surnamesAgree(a: string, b: string): boolean {
  if (!a || !b) return false;
  if (a === b) return true;
  const squash = (s: string) => s.replace(/\s+/g, '');
  if (squash(a) === squash(b)) return true;
  /**
   * One side carries a compound the other does not: we hold "Keller", the roll holds
   * "RIGGIN-KELLER, ALEXIS I". Same woman — a married or hyphenated name recorded in full
   * on title and short on the policy. It read as a different family, so the card was
   * reported unverified and the skip trace was never credited with finding her.
   *
   * Deliberately narrow: the short side must be ONE token appearing whole in the long
   * side, and at least three characters, so the particles in "DE LA CRUZ" or "VAN DER
   * BERG" cannot carry a match on their own.
   */
  const [shortS, longS] = a.length <= b.length ? [a, b] : [b, a];
  const shortToks = shortS.split(' ').filter(Boolean);
  const longToks = longS.split(' ').filter(Boolean);
  if (shortToks.length === 1 && longToks.length > 1 && shortToks[0].length >= 3) {
    return longToks.includes(shortToks[0]);
  }
  return false;
}

/** Edit distance, capped — we only ever care whether it is 0, 1, or "more than 1". */
function withinOneEdit(a: string, b: string): boolean {
  if (Math.abs(a.length - b.length) > 1) return false;
  let i = 0; let j = 0; let edits = 0;
  while (i < a.length && j < b.length) {
    if (a[i] === b[j]) { i++; j++; continue; }
    if (++edits > 1) return false;
    if (a.length > b.length) i++;
    else if (b.length > a.length) j++;
    else { i++; j++; }
  }
  return edits + (a.length - i) + (b.length - j) <= 1;
}

/**
 * Surname is one character off — a transcription variance rather than a different
 * family (real case: our "Labolt" vs the roll's "ABOLT", same first name MICHELLE).
 * Only ever used to soften a 'mismatch' to 'partial'; it never produces a match, so
 * genuinely different families (SMITH/SMYTH) still get a human's eyes rather than a tick.
 */
function surnamesNearMiss(a: string, b: string): boolean {
  if (!a || !b) return false;
  const squash = (s: string) => s.replace(/\s+/g, '');
  return withinOneEdit(squash(a), squash(b));
}

export interface RollPerson { first: string; last: string; display: string }
export interface RollOwners {
  person1: RollPerson | null;
  person2: RollPerson | null;
  isEntity: boolean;
  /**
   * The other defensible reading of a bare second party, when there is one.
   *
   * "MITCHELL, SCOTT & KAYLA NEWMAN" is Kayla NEWMAN; "SCHEIDT, WOODROW W & MARY ANN" is
   * Mary SCHEIDT. Identical shape, opposite answers, and the record does not say which it
   * is. Inheriting silently produced "Kayla Mitchell" and threw NEWMAN away — a name the
   * roll had actually given us.
   *
   * So both readings are returned and neither is asserted. The skip trace settles it for
   * free: whichever of the two it knows at that address is the real one.
   */
  person2Alt: RollPerson | null;
  /** True when person2 is a reading rather than a fact — never trace on it unchecked. */
  person2Uncertain: boolean;
  /** The roll says further owners exist that it has not named (ET AL / ET UX / ET VIR). */
  othersUnnamed: boolean;
}

const titleCase = (s: string) =>
  s.toLowerCase().replace(/\b[a-z]/g, (c) => c.toUpperCase()).trim();

function toRollPerson(p: { first: string; last: string } | null): RollPerson | null {
  if (!p) return null;
  const first = titleCase(p.first);
  const last = titleCase(p.last);
  const display = [first, last].filter(Boolean).join(' ').trim();
  return display ? { first, last, display } : null;
}

/**
 * Split a tax-roll owner string into its (up to two) named people — for capturing
 * BOTH insureds (typically husband + wife) so we can reach both (Frank Jul-2026).
 *
 * The roll writes two owners in one field joined by "&", and — when they share a
 * surname, which per title they almost always do — it lists the surname once:
 *   "SCHEIDT, WOODROW W & MARY ANN"  → Woodrow Scheidt + Mary Scheidt
 *   "PEREZ, ELIOT & MARISOL"          → Eliot Perez  + Marisol Perez
 *   "MESCAL,DAMION V. & JANICE V."    → Damion Mescal + Janice Mescal
 *   "MONTANARO, MICHAEL,& GINA"       → Michael Montanaro + Gina Montanaro (stray comma)
 * When the second party carries its own surname it is used as-is:
 *   "TARANTUL, MICHAEL & TATYANA TARANTUL" → Michael + Tatyana Tarantul
 *   "SMITH, JOHN & DOE, JANE"              → John Smith + Jane Doe
 *
 * Entities (LLC / trust / municipality) are never split into people — person1/2 null,
 * isEntity true. A single owner returns person1 only. The second person inherits the
 * shared surname unless it appears explicitly with its own comma, matching how spouses
 * on title are recorded; a rare unmarried different-surname co-owner listed as bare
 * "Jane Doe" would inherit the primary surname — an accepted edge, not the common case.
 */
export function parseRollOwners(raw: string): RollOwners {
  const othersUnnamed = hasUnnamedOwners(raw);
  const empty = { person1: null, person2: null, person2Alt: null, person2Uncertain: false, othersUnnamed };
  // Markers go before anything else reads the string: "SIMONE, JENNIFER, ETAL" must parse
  // as SIMONE, JENNIFER, with the fact that there are others kept separately.
  const display = stripOwnerMarkers(raw);
  if (!display) return { ...empty, isEntity: false };
  if (isEntity(display)) return { ...empty, isEntity: true };

  const parties = splitParties(display);
  const person1 = toRollPerson(splitPerson(parties[0] ?? ''));
  if (!person1) return { ...empty, isEntity: false };

  let person2: RollPerson | null = null;
  let person2Alt: RollPerson | null = null;
  let person2Uncertain = false;
  if (parties.length >= 2) {
    const rawP2 = parties[1];
    if (rawP2.includes(',')) {
      // Second party carries its own "LAST, FIRST" — use it verbatim.
      person2 = toRollPerson(splitPerson(rawP2));
    } else {
      // Bare given name(s): the shared surname is listed once on party 1, so inherit it.
      const toks = allTokens(rawP2);
      const inherited = person1.last.toUpperCase();
      const lastTok = toks[toks.length - 1] ?? '';
      if (toks.length === 1) {
        person2 = toRollPerson({ first: toks[0], last: inherited });
      } else if (toks.length > 1) {
        if (lastTok === inherited) {
          // "& TATYANA TARANTUL" — the roll simply repeated the surname.
          person2 = toRollPerson({ first: toks[0], last: lastTok });
        } else if (toks[0].length === 1 && lastTok.length > 1) {
          // "& S BODDAPATI" — an initial can only be a given name, so what follows it is
          // the surname. A different one from party 1, which is the point.
          person2 = toRollPerson({ first: toks[0], last: lastTok });
        } else if (lastTok.length === 1) {
          // "& JANICE V." — a trailing initial is a middle name; the surname is inherited.
          person2 = toRollPerson({ first: toks[0], last: inherited });
        } else {
          /**
           * "& KAYLA NEWMAN" is a surname the roll spelled out; "& MARY ANN" is a second
           * given name. Identical shape, opposite answers, and the record does not say.
           * The inherited reading stays primary so nothing regresses; the alternative
           * travels beside it and the caller is told not to trust either alone.
           */
          person2 = toRollPerson({ first: toks[0], last: inherited });
          person2Alt = toRollPerson({ first: toks[0], last: lastTok });
          person2Uncertain = true;
        }
      }
    }
  }
  return { person1, person2, person2Alt, person2Uncertain, othersUnnamed, isEntity: false };
}

/**
 * Merge a card name with the roll's version of the SAME person: surname from the roll,
 * given name from the card.
 *
 * ── Measured, not assumed (C2 Grade A, 13 Oct) ──────────────────────────────
 * Nine cards were re-traced with the roll's full version of the insured name, against
 * traces the card's version had already confirmed:
 *
 *   middle names ADDED by the roll     5 sent, 5 NOT FOUND
 *     Raul Garcia → Raul Edelman Quesada Garcia, Kelli Perry → Kelli Lynn Perry, …
 *   middle initial REMOVED             2 sent, 2 confirmed
 *   compound SURNAME corrected         1 sent, 1 confirmed  (Keller → Riggin-Keller)
 *
 * The roll writes what is on the deed; the skip-trace vendor knows people by the name they
 * use. Taking the roll's given name made five reachable households unreachable and found
 * nobody new. Taking its surname fixed the one card the CRM had genuinely wrong.
 *
 * So each source supplies the half it is actually good at. This is deliberately NOT a
 * decision about whether the two names are the same person — call it only after a match
 * has been established, never to force one.
 */
export function mergeOwnerName(
  card: { first?: string | null; last?: string | null },
  roll: { first?: string | null; last?: string | null },
): { first: string; last: string; changed: boolean } {
  const cardFirst = String(card.first ?? '').trim();
  const cardLast = String(card.last ?? '').trim();
  const rollFirst = String(roll.first ?? '').trim();
  const rollLast = String(roll.last ?? '').trim();

  // The roll's surname wins — that is the correction worth having.
  const last = rollLast || cardLast;

  /**
   * The card's given name wins, with one exception: when the card holds only an initial
   * and the roll spells the name out ("S BODDAPATI" on the roll, "Sahana" on the card is
   * the usual direction, but it occurs the other way too). Only the FIRST token is taken,
   * so a roll that also carries middle names cannot smuggle them back in.
   */
  const cardIsInitial = cardFirst.replace(/\W/g, '').length <= 1;
  const first = (!cardFirst || cardIsInitial) && rollFirst
    ? rollFirst.split(/\s+/)[0]
    : cardFirst;

  const key = (s: string) => s.toUpperCase().replace(/[^A-Z]/g, '');
  const changed = key(first) !== key(cardFirst) || key(last) !== key(cardLast);
  return { first, last, changed };
}

/**
 * Compare the insured name we hold against the authoritative record name.
 * `theirs` is the raw record string, e.g. "BRUMMER, THERESA".
 */
export function compareOwnerNames(
  ours: { first?: string | null; last?: string | null },
  theirs: string,
): NameComparison {
  const ourFirstRaw = String(ours.first ?? '').replace(/\bnull\b/gi, '').trim();
  const ourLastRaw = String(ours.last ?? '').trim();
  const oursDisplay = [ourFirstRaw, ourLastRaw].filter(Boolean).join(' ').trim();
  // ET AL / ET UX / ET VIR are tenancy markers, not part of anyone's name — left in, they
  // turned "SIMONE, JENNIFER, ETAL" into the first name "Jennifer Etal" and never matched.
  const theirsDisplay = stripOwnerMarkers(theirs);

  if (!oursDisplay || !theirsDisplay) {
    return { result: 'unknown', detail: 'Not enough name data to compare', ours: oursDisplay, theirs: theirsDisplay };
  }

  // ── Entity (LLC / trust / municipality) — compare whole names, not first/last.
  if (isEntity(oursDisplay) || isEntity(theirsDisplay)) {
    const score = entityOverlap(oursDisplay, theirsDisplay);
    if (score >= 0.8) return { result: 'match', detail: 'Entity name matches the tax record', ours: oursDisplay, theirs: theirsDisplay };
    if (score >= 0.4) return { result: 'partial', detail: 'Entity name partly matches — confirm on the call', ours: oursDisplay, theirs: theirsDisplay };
    return { result: 'mismatch', detail: 'Entity name does not match the tax record', ours: oursDisplay, theirs: theirsDisplay };
  }

  // ── Person. A record may list two parties; a match against either is a match.
  const ourSide = { first: coreTokens(ourFirstRaw).join(' '), last: coreTokens(ourLastRaw).join(' ') };

  /**
   * The parties are read the way parseRollOwners reads them, not re-split here.
   *
   * The roll lists a shared surname once: "ROTHSTEIN, ALYSSA & DYLAN". Splitting on "&" and
   * handing each half to splitPerson makes the second party the bare token "DYLAN", which is
   * then taken as a SURNAME with no given name — so Dylan Rothstein did not match his own
   * deed and came back 'partial', "surname matches but the record shows ALYSSA".
   *
   * parseRollOwners has inherited that surname since July. The two have simply never been
   * asked the same question, and this file held both. On C1–C8 Grade A it put Dylan
   * Rothstein, Marie St Fleur, Michael Tokman and Dalbir Singh into a review queue to decide
   * whether they are their own relative.
   *
   * The raw split is kept alongside it: parseRollOwners returns at most two people, and a
   * record like "ELLIS, GREGORY W, JESSICA C & CORINNE" names three. A match against any
   * reading is a match, so adding candidates can only find a person we were missing.
   */
  const rollOwners = parseRollOwners(theirsDisplay);
  const parties = [
    ...[rollOwners.person1, rollOwners.person2]
      .filter((p): p is RollPerson => !!p)
      .map((p) => `${p.last}, ${p.first}`),
    ...splitParties(theirsDisplay),
  ];

  let best: NameComparison = { result: 'mismatch', detail: 'Name does not match the tax record', ours: oursDisplay, theirs: theirsDisplay };

  for (const party of parties) {
    const p = splitPerson(party);
    if (!p) continue;
    const lastOk = surnamesAgree(ourSide.last, p.last);
    const firstOk = firstNamesAgree(ourSide.first, p.first);

    if (lastOk && firstOk) {
      return { result: 'match', detail: 'Name matches the tax record', ours: oursDisplay, theirs: theirsDisplay };
    }
    if (lastOk && best.result !== 'partial') {
      best = {
        result: 'partial',
        // Named apart from the spouse/co-owner case: "Alla" against "Allan" is probably the
        // same person written short, while "Alexa" against "Alexander" is probably not, and
        // the reviewer can tell the two situations apart at a glance only if we say which.
        detail: firstNamesPrefix(ourSide.first, p.first)
          ? `Given name is a near match — we have "${ourSide.first}", the record shows "${p.first}". Confirm it is the same person.`
          : p.first
            ? `Surname matches, but the record shows "${p.first}" — could be a spouse or co-owner`
            : 'Surname matches the tax record',
        ours: oursDisplay, theirs: theirsDisplay,
      };
    }
    // Same first name but the surname is a single character off — treat as a spelling
    // variance needing a look, not as a different person.
    if (!lastOk && firstOk && surnamesNearMiss(ourSide.last, p.last) && best.result !== 'partial') {
      best = {
        result: 'partial',
        detail: `Spelling differs — we have "${ourSide.last}", the record shows "${p.last}". Confirm on the call.`,
        ours: oursDisplay, theirs: theirsDisplay,
      };
    }
  }
  return best;
}
