/**
 * Tests for the owner-name matcher (src/services/ownerNameMatch.service.ts).
 *
 *   npm run test:names
 *
 * Compiles the real TypeScript service to a temp dir and exercises THAT — not a
 * re-implementation — so the tests can't drift from the shipped logic. (This caught
 * a real bug: splitPerson tested the normalized string for a comma, but norm()
 * strips punctuation, so every "LAST, FIRST" tax-roll name was parsed backwards.)
 *
 * Cases are drawn from the real book: 219 entities with no first name, 148 LLCs,
 * 69 middle initials, 42 trusts, 18 two-party names, 15 suffixes, 6 hyphenated.
 */
import { execSync } from 'child_process';
import { rmSync, mkdtempSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { pathToFileURL } from 'url';

const out = mkdtempSync(join(tmpdir(), 'bia-nametest-'));
execSync(
  `npx tsc src/services/ownerNameMatch.service.ts --outDir "${out}" --module es2020 --target es2020 --moduleResolution node`,
  { stdio: 'pipe' },
);
const { compareOwnerNames, parseRollOwners, mergeOwnerName } = await import(pathToFileURL(join(out, 'ownerNameMatch.service.js')).href);

let pass = 0; const failures = [];
const t = (label, ours, theirs, expect) => {
  const r = compareOwnerNames(ours, theirs);
  if (r.result === expect) { pass++; console.log(`  ok   ${label}`); }
  else { failures.push(`${label} → got "${r.result}", expected "${expect}"`); console.log(`  FAIL ${label} → ${r.result} (expected ${expect})`); }
};

console.log('\nVerified against the live Howell tax portal:');
t('Theresa Brummer vs "BRUMMER, THERESA"', { first: 'Theresa', last: 'Brummer' }, 'BRUMMER, THERESA', 'match');
t('a different lead against that record', { first: 'Matthew', last: 'Desanto' }, 'BRUMMER, THERESA', 'mismatch');

console.log('\nReal name shapes from the book:');
t('middle initial (Irene C Casamento)', { first: 'Irene C', last: 'Casamento' }, 'CASAMENTO, IRENE', 'match');
t('suffix (Raymond Mcmanus Jr)', { first: 'Raymond', last: 'Mcmanus Jr' }, 'MCMANUS, RAYMOND', 'match');
t('hyphenated surname', { first: 'Samantha', last: 'Aguilar-Sanchez' }, 'AGUILAR SANCHEZ, SAMANTHA', 'match');
t('LLC with no first name', { first: '', last: 'Kasmon Llc' }, 'KASMON LLC', 'match');
t('record lists two parties', { first: 'Michael', last: 'Tarantul' }, 'TARANTUL, MICHAEL & TATYANA TARANTUL', 'match');
t('our initial vs their full first name', { first: 'C', last: 'Markowitz' }, 'MARKOWITZ, CINDY', 'match');
t('revocable trust', { first: '', last: 'Janet Lobel Revocable Trust' }, 'LOBEL JANET REVOCABLE TRUST', 'match');
t('municipality', { first: '', last: 'Borough Of Freehold' }, 'BOROUGH OF FREEHOLD', 'match');
t('plain "First Last" record format', { first: 'Lee', last: 'Lessner' }, 'LEE LESSNER', 'match');
// Regression: found while sampling real Howell leads — reported as a mismatch.
t('compound surname spaced differently (De Vito / DEVITO)', { first: 'Michael', last: 'De Vito' }, 'DEVITO, MICHAEL & TAYLOR', 'match');
t('compound surname, other direction (VanDusen / VAN DUSEN)', { first: 'Ann', last: 'VanDusen' }, 'VAN DUSEN, ANN', 'match');

console.log('\nGrey zone — must be "partial", never a false tick:');
t('spouse listed on the tax roll instead', { first: 'Theresa', last: 'Brummer' }, 'BRUMMER, JOHN', 'partial');
// Real case from Middletown: same first name, surname one character off.
t('surname one char off, same first name (Labolt/ABOLT)', { first: 'Michelle', last: 'Labolt' }, 'ABOLT, MICHELLE LEIGH', 'partial');

console.log('\nMust never falsely match:');
t('same first name, different surname', { first: 'Theresa', last: 'Smith' }, 'BRUMMER, THERESA', 'mismatch');
// The near-miss rule must never upgrade to a tick, and must not fire on a genuinely
// different surname that happens to be short, or on a different first name.
t('near-miss surname is never a full match', { first: 'Michelle', last: 'Labolt' }, 'ABOLT, MICHELLE LEIGH', 'partial');
t('surname 2+ chars off stays a mismatch', { first: 'John', last: 'Smith' }, 'SMYTHE, JOHN', 'mismatch');
t('near-miss surname but different first name', { first: 'Robert', last: 'Labolt' }, 'ABOLT, MICHELLE LEIGH', 'mismatch');
t('unrelated entity', { first: '', last: 'Kasmon Llc' }, 'SPARTAN REAL ESTATE HOLDINGS INC', 'mismatch');
t('no record name', { first: 'Theresa', last: 'Brummer' }, '', 'unknown');
t('no insured name', { first: '', last: '' }, 'BRUMMER, THERESA', 'unknown');

// ── Found in the C2 Grade A shadow run, 13 Oct ──────────────────────────────
console.log('\nShadow-run regressions (C2 Grade A, 13 Oct):');
// "ETAL" was read as part of the first name ("Jennifer Etal"), so the roll's own insured
// never matched the traced person and the card reported unverified.
t('ET AL marker is not a name', { first: 'Jennifer', last: 'Simone' }, 'SIMONE, JENNIFER, ETAL', 'match');
t('ET UX marker is not a name', { first: 'Woodrow', last: 'Scheidt' }, 'SCHEIDT, WOODROW ET UX', 'match');
// We hold the short surname, the roll holds the compound. Same woman.
t('compound surname, we hold the short form', { first: 'Alexis', last: 'Keller' }, 'RIGGIN-KELLER, ALEXIS I', 'match');
// ...but a shared particle must not carry a match on its own.
t('particle alone is not a surname match', { first: 'Maria', last: 'De' }, 'DE LA CRUZ, MARIA', 'mismatch');
t('unrelated compound is still a mismatch', { first: 'John', last: 'Harris' }, 'RIGGIN-KELLER, ALEXIS I', 'mismatch');

// ── parseRollOwners — capturing BOTH insureds (Frank Jul-2026, verified vs live rolls)
console.log('\nTwo-insured extraction from the tax roll (parseRollOwners):');
const p = (label, raw, expect) => {
  const r = parseRollOwners(raw);
  const got = { p1: r.person1?.display ?? null, p2: r.person2?.display ?? null, entity: r.isEntity };
  const ok = got.p1 === expect.p1 && got.p2 === expect.p2 && got.entity === !!expect.entity;
  if (ok) { pass++; console.log(`  ok   ${label}`); }
  else { failures.push(`${label} → got ${JSON.stringify(got)}, expected ${JSON.stringify(expect)}`); console.log(`  FAIL ${label} → ${JSON.stringify(got)}`); }
};
p('spouse, shared surname (Scheidt)', 'SCHEIDT, WOODROW W & MARY ANN', { p1: 'Woodrow Scheidt', p2: 'Mary Scheidt' });
p('spouse, shared surname (Perez)', 'PEREZ, ELIOT & MARISOL', { p1: 'Eliot Perez', p2: 'Marisol Perez' });
p('spouse with middle initials (Mescal)', 'MESCAL,DAMION V. & JANICE V.', { p1: 'Damion Mescal', p2: 'Janice Mescal' });
p('stray comma before ampersand (Montanaro)', 'MONTANARO, MICHAEL,& GINA', { p1: 'Michael Montanaro', p2: 'Gina Montanaro' });
p('second party repeats the surname (Tarantul)', 'TARANTUL, MICHAEL & TATYANA TARANTUL', { p1: 'Michael Tarantul', p2: 'Tatyana Tarantul' });
p('second party with own LAST, FIRST', 'SMITH, JOHN & DOE, JANE', { p1: 'John Smith', p2: 'Jane Doe' });
p('single owner → no second person', 'DEVINCENS, CHRISTINE', { p1: 'Christine Devincens', p2: null });
p('plain First Last, single owner', 'LEE LESSNER', { p1: 'Lee Lessner', p2: null });
p('LLC is an entity, not people', '525 REALTY HOLDING, INC', { p1: null, p2: null, entity: true });
p('trust is an entity, not people', '123 SOUTH MAIN STREET TRUST', { p1: null, p2: null, entity: true });
p('municipality is an entity', 'TOWNSHIP OF HOWELL', { p1: null, p2: null, entity: true });
p('empty string', '', { p1: null, p2: null });

rmSync(out, { recursive: true, force: true });

// ── The ambiguous bare second party (C2 Grade A, 13 Oct) ────────────────────
// "& KAYLA NEWMAN" is a surname the roll spelled out; "& MARY ANN" is a second given
// name. Identical shape, opposite answers — so both readings are returned and the caller
// is told not to trust either alone. Silently inheriting produced "Kayla Mitchell" and
// discarded NEWMAN, a name the roll had actually given us.
console.log('\nAmbiguous bare second party (parseRollOwners):');
const alt = (label, raw, expect) => {
  const r = parseRollOwners(raw);
  const got = {
    p2: r.person2?.display ?? null,
    p2Alt: r.person2Alt?.display ?? null,
    uncertain: r.person2Uncertain,
  };
  const ok = got.p2 === expect.p2 && got.p2Alt === expect.p2Alt && got.uncertain === expect.uncertain;
  if (ok) { pass++; console.log(`  ok   ${label}`); }
  else { failures.push(`${label} → got ${JSON.stringify(got)}`); console.log(`  FAIL ${label} → ${JSON.stringify(got)}`); }
};
alt('second party may carry its own surname', 'MITCHELL, SCOTT & KAYLA NEWMAN',
  { p2: 'Kayla Mitchell', p2Alt: 'Kayla Newman', uncertain: true });
alt('initial plus surname', 'VENKATA, SARAT CVK & S BODDAPATI',
  { p2: 'S Boddapati', p2Alt: null, uncertain: false });
alt('two given names stays certain-ish but offers the alt', 'SCHEIDT, WOODROW W & MARY ANN',
  { p2: 'Mary Scheidt', p2Alt: 'Mary Ann', uncertain: true });
alt('single given name is unambiguous', 'PEREZ, ELIOT & MARISOL',
  { p2: 'Marisol Perez', p2Alt: null, uncertain: false });
alt('repeated surname is unambiguous', 'TARANTUL, MICHAEL & TATYANA TARANTUL',
  { p2: 'Tatyana Tarantul', p2Alt: null, uncertain: false });

console.log('\nUnnamed-owner marker:');
const un = (label, raw, expect) => {
  const r = parseRollOwners(raw);
  if (r.othersUnnamed === expect) { pass++; console.log(`  ok   ${label}`); }
  else { failures.push(`${label} → othersUnnamed ${r.othersUnnamed}`); console.log(`  FAIL ${label}`); }
};
un('ETAL flags unnamed co-owners', 'SIMONE, JENNIFER, ETAL', true);
un('plain record does not', 'PEREZ, ELIOT & MARISOL', false);

// ── The prefix rule, split (C2 Grade A, 13 Oct) ─────────────────────────────
// A prefix ending on a space is an extra given name — the same person. A prefix that cuts
// a name in half is not: Alexander Grinshpoon and Alexa Grinshpoon are two people, and the
// comparator graded them a match, which an automatic override would have acted on.
console.log('\nGiven-name prefixes:');
t('extra given name is the same person', { first: 'Michelle', last: 'Labolt' }, 'LABOLT, MICHELLE LEIGH', 'match');
t('mid-word prefix is NOT a full match', { first: 'Alexander', last: 'Grinshpoon' }, 'GRINSHPOON, ALEXA', 'partial');
t('Carl is not Carla', { first: 'Carl', last: 'Vincent' }, 'VINCENT, CARLA', 'partial');
t('initial still matches the full name', { first: 'C', last: 'Markowitz' }, 'MARKOWITZ, CINDY', 'match');

// ── mergeOwnerName — surname from the roll, given name from the card ────────
// Measured on C2: the roll's middle names made 5 of 5 reachable households unreachable,
// while its surname correction fixed the one card we had genuinely wrong.
console.log('\nMerging a card name with the roll (mergeOwnerName):');
const mg = (label, card, roll, expect) => {
  const r = mergeOwnerName(card, roll);
  const got = `${r.first} ${r.last}`.trim();
  if (got === expect) { pass++; console.log(`  ok   ${label}`); }
  else { failures.push(`${label} → got "${got}", expected "${expect}"`); console.log(`  FAIL ${label} → "${got}"`); }
};
mg('roll middle names are discarded', { first: 'Raul', last: 'Garcia' }, { first: 'Raul Edelman Quesada', last: 'Garcia' }, 'Raul Garcia');
mg('roll surname is taken', { first: 'Alexis', last: 'Keller' }, { first: 'Alexis', last: 'Riggin Keller' }, 'Alexis Riggin Keller');
mg('card initial is filled from the roll, first token only', { first: 'S', last: 'Boddapati' }, { first: 'Sarat Cvk', last: 'Boddapati' }, 'Sarat Boddapati');
mg('card given name wins over the roll', { first: 'Sahana', last: 'Boddapati' }, { first: 'S', last: 'Boddapati' }, 'Sahana Boddapati');
mg('empty card name falls back to the roll', { first: '', last: '' }, { first: 'Marisol', last: 'Perez' }, 'Marisol Perez');

// ── The insured named SECOND on the deed (review queue, 14 Oct) ─────────────
// The roll lists a shared surname once. Splitting on "&" without inheriting it made the
// bare second token a surname, so a man did not match his own deed and was queued for a
// human to decide whether he was his own relative.
console.log('\nInsured named second on the deed:');
t('shared surname, insured is second', { first: 'Dylan', last: 'Rothstein' }, 'ROTHSTEIN, ALYSSA & DYLAN', 'match');
t('same, with a stop in the surname', { first: 'Marie', last: 'St Fleur' }, 'ST. FLEUR, LEONARD & MARIE', 'match');
/*
 * Known limit, recorded rather than hidden. "ELLIS, GREGORY W, JESSICA C & CORINNE" names
 * three owners, and the third given name sits inside the FIRST party behind a comma — the
 * split is on "&", so Jessica is never a party of her own. It lands on 'partial', which is
 * honest: the surname matches and a person can confirm which of three she is. Raising it to
 * 'match' would need the first party split on commas too, which also has to not break
 * "SIMONE, JENNIFER, ETAL" and "GOUBERT, EDOUARD T P".
 */
t('three names on the deed — partial, not match', { first: 'Jessica', last: 'Ellis' }, 'ELLIS, GREGORY W,JESSICA C &CORINNE', 'partial');
// The two that SHOULD still need a person — the fix must not swallow these.
t('a different given name is still partial', { first: 'Reva', last: 'Feldman' }, 'FELDMAN, MARTIN', 'partial');
t('a different family is still a mismatch', { first: 'Rosanna', last: 'Hendrick' }, 'EHTESHAM, SHEHRYAR & KHAN, RAIHA', 'mismatch');

// ── Apostrophes in surnames (co-insured queue, 14 Oct) ──────────────────────
// An apostrophe became a space and coreTokens then dropped the lone "O" as a middle
// initial, so the roll's O'CONNELL was compared as plain CONNELL and Laura O'Connell read
// as a different surname from herself.
console.log('\nApostrophes in surnames:');
t("O'Connell against the roll's apostrophe", { first: 'Laura', last: "O'Connell" }, "O'CONNELL, DANIEL & LAURA", 'match');
t('the same with no apostrophe on our side', { first: 'Laura', last: 'OConnell' }, "O'CONNELL, DANIEL & LAURA", 'match');
t('a stop in the surname still matches', { first: 'William', last: 'St Laurent' }, 'ST. LAURENT, FLORENCE & WILLIAM', 'match');
t('and run together, as our source writes it', { first: 'William', last: 'Stlaurent' }, 'ST. LAURENT, FLORENCE & WILLIAM', 'match');


console.log(`\n${pass} passed, ${failures.length} failed`);
if (failures.length) { failures.forEach((f) => console.error('  ' + f)); process.exit(1); }