/**
 * Tests for the squashed-unit detector (src/services/addressUnit.service.ts).
 *
 *   node scripts/test-address-unit.mjs
 *
 * Compiles the real service and exercises THAT, so the tests cannot drift from what ships.
 *
 * Every case is a real address out of C1–C8. The ones that matter most are the negatives:
 * 85i Winthrop Rd, where the trailing letter is a mistyped 1 rather than unit I, and the
 * ordinary addresses that must produce no proposal at all — 261 of 7,009 have this shape,
 * so a rule that fires on the other 6,748 would be far worse than the problem.
 */
import { execSync } from 'child_process';
import { rmSync, mkdtempSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { pathToFileURL } from 'url';

const out = mkdtempSync(join(tmpdir(), 'bia-addrtest-'));
execSync(
  `npx tsc src/services/addressUnit.service.ts --outDir "${out}" --module es2020 --target es2020 --moduleResolution node`,
  { stdio: 'pipe' },
);
const { proposeUnit, unitShape, preferSpelledOut } =
  await import(pathToFileURL(join(out, 'addressUnit.service.js')).href);

let pass = 0;
const fails = [];
const ok = (cond, label, got = '') => {
  if (cond) pass++;
  else fails.push(`${label}${got ? ` — got ${got}` : ''}`);
};

const shapeIs = (street, expected) =>
  ok(unitShape(street) === expected, `shape of "${street}" is ${expected}`, String(unitShape(street)));

const firstCandidate = (street, expected) => {
  const p = proposeUnit(street);
  ok(p.candidates[0] === expected, `"${street}" -> "${expected}"`, `"${p.candidates[0]}"`);
};

const hasCandidate = (street, expected) => {
  const p = proposeUnit(street);
  ok(p.candidates.includes(expected), `"${street}" offers "${expected}"`, p.candidates.join(' | '));
};

const noProposal = (street) => {
  const p = proposeUnit(street);
  ok(p.candidates.length === 0, `"${street}" is left alone`, p.candidates.join(' | '));
};

// ── The shape that started this: the letter is a unit ──────────────────────
firstCandidate('121d Muhlen Platz', '121 Muhlen Platz Unit D');
firstCandidate('26b Guesta De Gomerez', '26 Guesta De Gomerez Unit B');
firstCandidate('51b Piazza Tasso', '51 Piazza Tasso Unit B');
firstCandidate('16g James Buchanan Dr', '16 James Buchanan Dr Unit G');
firstCandidate('97a Salix Plz', '97 Salix Plz Unit A');
shapeIs('121d Muhlen Platz', 'suffix_letter');

// ── A hyphen: usually an apartment when it is a number ─────────────────────
firstCandidate('502-7 Harding Rd', '502 Harding Rd Apt 7');
firstCandidate('25-12 Wyeth Dr', '25 Wyeth Dr Apt 12');
firstCandidate('4-A Alabama Ct', '4 Alabama Ct Unit A');
shapeIs('9-5 Boise Ct', 'hyphen_unit');
// Both readings are offered, because the hyphen is genuinely ambiguous.
hasCandidate('502-7 Harding Rd', '502 Harding Rd Unit 7');

// ── The trap: a trailing letter that is really a digit ─────────────────────
// 85i Winthrop Rd and 851 Winthrop Road are the same house on the same card.
hasCandidate('85i Winthrop Rd', '851 Winthrop Rd');
hasCandidate('85i Winthrop Rd', '85 Winthrop Rd Unit I');
ok(/mistyped 1/.test(proposeUnit('85i Winthrop Rd').note ?? ''),
  '85i carries a note explaining the digit reading');

// ── A trailing letter that may be a compass direction ──────────────────────
hasCandidate('348n Newport Way', '348 N Newport Way');
hasCandidate('348n Newport Way', '348 Newport Way Unit N');
ok(/direction/i.test(proposeUnit('219n Manchester Ln').note ?? ''),
  '219n carries a note about the direction reading');

// ── Already correct: propose nothing ───────────────────────────────────────
noProposal('4 Alabama Ct # A');
noProposal('26 Guesta De Gomerez Unit B');
noProposal('502 Harding Rd Apt 7');
noProposal('12 Oak Street Suite 300');

// ── Ordinary addresses must be untouched ───────────────────────────────────
noProposal('111 Ramble Way');
noProposal('13 Decoy Ln');
noProposal('158 Village Green Way');
noProposal('239 Century Way');
noProposal('1600 Pennsylvania Ave NW');
noProposal('425 Saint Andrews Pl');
noProposal('90 Cranbrook Ct');
noProposal('');
shapeIs('111 Ramble Way', null);

// ── The other field as evidence ────────────────────────────────────────────
ok(preferSpelledOut('26b Guesta De Gomerez', '26 Guesta De Gomerez Unit B')
  === '26 Guesta De Gomerez Unit B', 'prefers the field that spells the unit out');
ok(preferSpelledOut('4 Alabama Ct # A', '4-A Alabama Ct') === '4 Alabama Ct # A',
  'prefers the spelled-out field whichever side it is on');
ok(preferSpelledOut('111 Ramble Way', '111 Ramble Way') === null,
  'two ordinary addresses give no preference');
ok(preferSpelledOut('85i Winthrop Rd', '851 Winthrop Road') === null,
  'neither side spells a unit out, so there is nothing to prefer');

rmSync(out, { recursive: true, force: true });

console.log(`\n${pass} passed, ${fails.length} failed`);
if (fails.length) {
  for (const f of fails) console.log(`  FAIL ${f}`);
  process.exit(1);
}
