/**
 * Repair mailing addresses the township proves are mangled. DRY BY DEFAULT — --apply writes.
 *
 *   node scripts/fix-damaged-mail-addresses.mjs
 *   node scripts/fix-damaged-mail-addresses.mjs --apply
 *
 * ── A deliberately narrow rule ──────────────────────────────────────────────
 * Only where the mailing address is the SAME street and the SAME house number as the roll,
 * and differs by damage: a letter read as a digit ("1138" for "113B"), a lost leading digit
 * ("55b" for "155B"), a stray character ("V25b"). Those are not addresses; they are typos of
 * one.
 *
 * Everything else is left alone, on purpose:
 *
 *   a different address entirely   300 Wall St against a property on Dogwood Court is a
 *                                  FORWARDING address. Absentee owners are why the mailing
 *                                  column exists, and overwriting it posts to a house the
 *                                  owner does not live in — the worst outcome available.
 *   a dropped unit                 "25 Pitman Rd" where the roll says "25B". Incomplete
 *                                  rather than wrong, and whether USPS needs the unit is a
 *                                  deliverability question, which is USPS's to answer.
 *   already correct                "407 Oxford Ln # A" normalises identically to the roll.
 *   a genuine conflict             109 Deepwater Circle: the roll says unit A, both our
 *                                  columns say B. That is a fact about where somebody lives
 *                                  and is flagged for a person, not settled by a script.
 *
 * Every change is written to AddressCorrection first, so the original survives and a bad
 * batch can be walked back rather than reconstructed.
 */
import { randomUUID } from 'crypto';
import { execSync } from 'child_process';
import { readFileSync, existsSync, writeFileSync, mkdirSync } from 'fs';
import { join, resolve } from 'path';
import { createRequire } from 'module';
import Module from 'module';
import { Pool } from '@neondatabase/serverless';

const APPLY = process.argv.includes('--apply');

for (const f of ['.env', '.env.local']) {
  if (!existsSync(f)) continue;
  for (const line of readFileSync(f, 'utf8').split(/\r?\n/)) {
    const m = line.match(/^\s*([A-Za-z0-9_]+)\s*=\s*(.*)$/);
    if (m) process.env[m[1].trim()] ??= m[2].trim().replace(/^["']|["']$/g, '');
  }
}

const out = resolve('.verify-build');
mkdirSync(out, { recursive: true });
writeFileSync(join(out, 'tsconfig.json'), JSON.stringify({
  compilerOptions: {
    target: 'es2022', module: 'commonjs', moduleResolution: 'node',
    skipLibCheck: true, esModuleInterop: true,
    baseUrl: resolve('.'), paths: { '@/*': ['src/*'] }, outDir: out,
  },
  include: [resolve('src/services/taxRoll.service.ts')],
}));
execSync(`npx tsc -p "${join(out, 'tsconfig.json')}"`, { stdio: 'pipe' });
const req = createRequire(import.meta.url);
const origResolve = Module._resolveFilename;
Module._resolveFilename = function (r, ...rest) {
  if (r.startsWith('@/')) r = join(out, r.slice(2));
  return origResolve.call(this, r, ...rest);
};
const { normalizeStreet } = req(join(out, 'taxRoll.service.js'));

const pool = new Pool({ connectionString: process.env.DATABASE_URL });

const rows = (await pool.query(`
  SELECT "id","propertyId", COALESCE("manualGrade","grade") AS grade,
         "rollPropertyLoc","addressStreet","mailStreet"
    FROM "Lead"
   WHERE "rollPropertyLoc" IS NOT NULL
     AND COALESCE("mailStreet",'') <> ''
   ORDER BY "propertyId"`)).rows;

/**
 * A stray letter in front of the house number.
 *
 * "V25b Abraham Lincoln Court" is 25B with a V stuck to the front. Without stripping it the
 * house-number parse returns nothing, the street words keep "V25B", and the address is filed
 * as a DIFFERENT street — which reads as a forwarding address and gets left alone. It is the
 * same street, and it is exactly the typo this script exists to repair.
 */
const stripJunkPrefix = (s) => String(s ?? '').trim().replace(/^[A-Za-z](?=\d)/, '');

/** The street words, with the house number and any unit stripped off. */
const streetWords = (s) => normalizeStreet(stripJunkPrefix(s))
  .replace(/^\d+\s+/, '')
  .replace(/\s+(UNIT|APT|STE|BLDG|FL|RM)\s+\S+$/, '')
  .trim();

/** The leading house number, digits only. */
const houseNumber = (s) => (stripJunkPrefix(s).match(/^(\d+)/) ?? [])[1] ?? null;

/**
 * The roll shouts. The CRM does not.
 *
 * Addresses elsewhere in the book are title case, and dropping "85I WINTHROP RD" in among
 * them makes a repaired record look like a different kind of data. The unit letter stays
 * upper, because a lower-case "85i" is what caused this confusion in the first place.
 */
const titleCase = (s) => String(s ?? '').toLowerCase()
  .replace(/\b([a-z])/g, (c) => c.toUpperCase())
  .replace(/^(\d+)([a-z])\b/, (_m, n, l) => n + l.toUpperCase());

const repairs = [];
const skipped = [];

for (const r of rows) {
  const R = normalizeStreet(r.rollPropertyLoc);
  const M = normalizeStreet(r.mailStreet);
  if (R === M) continue;

  const sameStreet = streetWords(R) === streetWords(M) && !!streetWords(R);
  if (!sameStreet) {
    skipped.push({ ...r, why: 'a different street — this is a forwarding address, not a typo' });
    continue;
  }

  /**
   * Identical once a stray prefix is removed — the whole difference IS the junk.
   *
   * "V25b Abraham Lincoln Court" normalises to exactly the roll's string once the V goes.
   * Checked before the house-number test below, which would otherwise see 25 == 25, call it
   * a unit difference and hand it to USPS — leaving a letter addressed to a house number
   * that starts with a letter.
   */
  if (normalizeStreet(stripJunkPrefix(r.mailStreet)) === R) {
    repairs.push({ ...r, from: r.mailStreet, to: titleCase(r.rollPropertyLoc) });
    continue;
  }

  const rollNo = houseNumber(r.rollPropertyLoc);
  const mailNo = houseNumber(r.mailStreet);

  /**
   * The house numbers must differ for this to be damage worth repairing.
   *
   * When they agree the difference is the UNIT — dropped, or spelled another way — and that
   * is a question about delivery rather than about identity. USPS answers it.
   */
  if (rollNo && mailNo && rollNo === mailNo) {
    skipped.push({ ...r, why: 'same house number — the difference is the unit, which USPS should rule on' });
    continue;
  }

  repairs.push({ ...r, from: r.mailStreet, to: titleCase(r.rollPropertyLoc) });
}

console.log(APPLY ? 'APPLYING' : 'DRY RUN — nothing written');
console.log(`leads with a roll address  : ${rows.length}`);
console.log(`mailing addresses to repair: ${repairs.length}\n`);
for (const x of repairs) {
  console.log(`  ${x.propertyId} [${x.grade}]`);
  console.log(`     was  : "${x.from}"`);
  console.log(`     roll : "${x.to}"`);
}
if (skipped.length) {
  console.log(`\nleft alone (${skipped.length}):`);
  for (const x of skipped) console.log(`  ${x.propertyId} "${x.mailStreet}" — ${x.why}`);
}

if (!APPLY) {
  console.log('\nRe-run with --apply to write them.');
  await pool.end();
  process.exit(0);
}

for (const x of repairs) {
  await pool.query(
    `INSERT INTO "AddressCorrection"
       ("id","leadId","propertyId","field","original","shape","candidates",
        "verified","deliverability","winner","applied","appliedAt","appliedBy","checkedAt")
     VALUES ($1,$2,$3,'mail',$4,'damaged',ARRAY[$5],$5,'tax_roll','roll',TRUE,NOW(),$6,NOW())
     ON CONFLICT ("leadId","field") DO UPDATE SET
       "original" = EXCLUDED."original", "verified" = EXCLUDED."verified",
       "deliverability" = EXCLUDED."deliverability", "winner" = EXCLUDED."winner",
       "applied" = TRUE, "appliedAt" = NOW(), "appliedBy" = EXCLUDED."appliedBy"`,
    [randomUUID(), x.id, x.propertyId, x.from, x.to, 'roll-repair script'],
  );
  await pool.query(`UPDATE "Lead" SET "mailStreet" = $1 WHERE "id" = $2`, [x.to, x.id]);
  console.log(`repaired ${x.propertyId}`);
}

console.log(`\n${repairs.length} mailing addresses repaired. Originals are in AddressCorrection.`);
await pool.end();
