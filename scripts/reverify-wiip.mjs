/**
 * Re-verify leads against the municipal tax roll. DRY BY DEFAULT — pass --apply to write.
 *
 *   node scripts/reverify-wiip.mjs --cohort=2026-10-12 --grade=A          (dry)
 *   node scripts/reverify-wiip.mjs --cohort=2026-10-12 --grade=A --apply
 *
 * ── Two jobs, only one of which touches the roll ────────────────────────────
 *
 * REGRADE is free and offline. The roll's own answer is already stored on the lead as
 * ownerVerifyName, so the fixes to the matcher — ET AL markers, compound surnames, and the
 * ALEXA/ALEXANDER prefix split — can be re-applied to it without asking any municipality
 * anything. Every lead that has been checked before is re-graded this way.
 *
 * RELOOKUP calls the roll, and is therefore limited to leads whose answer could actually
 * change: not_found and unsupported, which is what a widened ZIP→town map fixes. Five of
 * C2's nine "not on roll" cards resolved the moment Howell was added to 07728, three of
 * them naming a co-insured the card did not have.
 *
 * ── Why never-checked leads need a flag ─────────────────────────────────────
 * 6,050 of the 7,009 leads in C1–C8 have never been checked at all. That is a first run at
 * volume, not a re-verification: hours of continuous requests to small municipal services,
 * and precisely the thing this module's own header defers to BIA as a business decision.
 * It is also contrary to the rule set on 13 Oct — cohort by cohort, never the whole book at
 * once. So it happens only behind --include-unchecked, one cohort at a time.
 */
import { execSync } from 'child_process';
import { mkdtempSync, readFileSync, existsSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { createRequire } from 'module';
import { neon } from '@neondatabase/serverless';

const arg = (n, d) => (process.argv.find((a) => a.startsWith(`--${n}=`)) ?? `--${n}=${d}`).slice(n.length + 3);
const COHORT = arg('cohort', 'all');
const GRADE = arg('grade', 'all');
const MODE = arg('mode', 'both');               // regrade | relookup | both
const APPLY = process.argv.includes('--apply');
const INCLUDE_UNCHECKED = process.argv.includes('--include-unchecked');
const LIMIT = Number(arg('limit', '0')) || null;

for (const f of ['.env', '.env.local']) {
  if (!existsSync(f)) continue;
  for (const line of readFileSync(f, 'utf8').split(/\r?\n/)) {
    const m = line.match(/^\s*([A-Za-z0-9_]+)\s*=\s*(.*)$/);
    if (m) process.env[m[1].trim()] ??= m[2].trim().replace(/^["']|["']$/g, '');
  }
}
const raw = neon(process.env.DATABASE_URL);
const sql = async (s, ...v) => {
  let last;
  for (let i = 0; i < 6; i++) {
    try { return await raw(s, ...v); } catch (e) {
      last = e;
      if (!/connect/i.test(String(e?.message ?? ''))) throw e;
      await new Promise((r) => setTimeout(r, 1500));
    }
  }
  throw last;
};

const out = mkdtempSync(join(tmpdir(), 'bia-reverify-'));
execSync(
  `npx tsc src/services/taxRoll.service.ts src/services/ownerNameMatch.service.ts`
  + ` --outDir "${out}" --module commonjs --target es2022 --moduleResolution node --skipLibCheck`,
  { stdio: 'pipe' },
);
const req = createRequire(import.meta.url);
const { verifyOwnerName, WIPP_BY_ZIP } = req(join(out, 'taxRoll.service.js'));
const { compareOwnerNames } = req(join(out, 'ownerNameMatch.service.js'));

const C1 = '2026-10-05';
const C8 = '2026-11-23';
const cohortLo = COHORT === 'all' ? C1 : COHORT;
const cohortHi = COHORT === 'all' ? C8 : COHORT;
const gradeFilter = GRADE === 'all' ? null : GRADE;

console.log(`${APPLY ? 'APPLYING' : 'DRY RUN — nothing will be written'}`);
console.log(`cohort ${cohortLo}${cohortLo !== cohortHi ? ` … ${cohortHi}` : ''}, grade ${GRADE}, mode ${MODE}\n`);

const all = await sql`
  SELECT "id","propertyId","cohort","addressStreet","addressZip",
         COALESCE("manualGrade","grade") AS grade,
         "owner1FirstName","owner1LastName",
         "ownerVerifyName","ownerVerifyStatus","ownerVerifyDetail","ownerVerifyAt","ownerVerifySource"
    FROM "Lead"
   WHERE "cohort" >= ${cohortLo} AND "cohort" <= ${cohortHi}
     AND (${gradeFilter}::text IS NULL OR COALESCE("manualGrade","grade") = ${gradeFilter})
   ORDER BY "cohort" DESC, "propertyId"`;

const leads = LIMIT ? all.slice(0, LIMIT) : all;
console.log(`${leads.length} leads in scope\n`);

// ── 1. Regrade: re-apply the fixed matcher to the roll answer we already hold ──
let regraded = 0;
const changes = new Map();
if (MODE === 'regrade' || MODE === 'both') {
  for (const l of leads) {
    if (!l.ownerVerifyName) continue;
    const cmp = compareOwnerNames(
      { first: l.owner1FirstName, last: l.owner1LastName },
      String(l.ownerVerifyName),
    );
    if (cmp.result === l.ownerVerifyStatus) continue;
    regraded++;
    const key = `${l.ownerVerifyStatus} → ${cmp.result}`;
    changes.set(key, (changes.get(key) ?? 0) + 1);
    if (regraded <= 25) {
      console.log(`  ${String(l.propertyId).padEnd(13)} ${key.padEnd(22)} `
        + `${[l.owner1FirstName, l.owner1LastName].filter(Boolean).join(' ').padEnd(26)} roll="${l.ownerVerifyName}"`);
    }
    if (APPLY) {
      await sql`UPDATE "Lead"
                   SET "ownerVerifyStatus" = ${cmp.result},
                       "ownerVerifyDetail" = ${cmp.detail}
                 WHERE "id" = ${l.id}`;
    }
  }
  console.log(`\nregrade: ${regraded} status changes (no roll calls made)`);
  for (const [k, v] of [...changes.entries()].sort((a, b) => b[1] - a[1])) console.log(`   ${String(v).padStart(5)}  ${k}`);
}

// ── 2. Relookup: only where a widened town map can change the answer ──────────
if (MODE === 'relookup' || MODE === 'both') {
  const needs = leads.filter((l) => {
    const s = l.ownerVerifyStatus;
    if (s === 'not_found' || s === 'unsupported' || s === 'unavailable') return true;
    // Never checked is a FIRST run, not a re-verification — see the header.
    if (!l.ownerVerifyAt) return INCLUDE_UNCHECKED;
    return false;
  });
  const skipped = leads.filter((l) => !l.ownerVerifyAt).length;
  console.log(`\nrelookup: ${needs.length} leads to ask the roll about`
    + (!INCLUDE_UNCHECKED && skipped ? `  (${skipped} never-checked skipped — pass --include-unchecked)` : ''));
  if (needs.length) {
    const est = Math.round((needs.length * 2.5 * 1.5) / 60);
    console.log(`estimated ${est} minute${est === 1 ? '' : 's'} at the roll's throttle\n`);
  }

  let resolved = 0, still = 0, failed = 0;
  for (const [i, l] of needs.entries()) {
    if (!WIPP_BY_ZIP[String(l.addressZip ?? '').trim()]?.length) { failed++; continue; }
    let r;
    try {
      r = await verifyOwnerName({
        addressStreet: l.addressStreet, addressZip: l.addressZip,
        owner1FirstName: l.owner1FirstName, owner1LastName: l.owner1LastName,
      });
    } catch (err) { failed++; continue; }

    const hasRecord = 'recordName' in r;
    if (hasRecord) resolved++; else if (r.status === 'not_found') still++;

    if (hasRecord || r.status !== l.ownerVerifyStatus) {
      console.log(`${String(i + 1).padStart(4)}/${needs.length} ${String(l.ownerVerifyStatus ?? 'unchecked').padEnd(11)} → ${String(r.status).padEnd(10)} `
        + `"${l.addressStreet}" (${l.addressZip})${hasRecord ? `  roll="${String(r.recordName).replace(/\s+/g, ' ').trim()}"` : ''}`);
    }
    if (APPLY) {
      if (hasRecord) {
        await sql`UPDATE "Lead"
                     SET "ownerVerifyStatus" = ${r.status}, "ownerVerifyName" = ${r.recordName},
                         "ownerVerifySource" = ${r.source}, "ownerVerifyAt" = ${new Date().toISOString()},
                         "ownerVerifyDetail" = ${r.detail}
                   WHERE "id" = ${l.id}`;
      } else {
        await sql`UPDATE "Lead"
                     SET "ownerVerifyStatus" = ${r.status},
                         "ownerVerifySource" = ${`tax_roll_${r.status}`},
                         "ownerVerifyAt" = ${new Date().toISOString()},
                         "ownerVerifyDetail" = ${r.detail}
                   WHERE "id" = ${l.id}`;
      }
    }
  }
  console.log(`\nrelookup: ${resolved} now on the roll, ${still} still not found, ${failed} could not be asked`);
}

console.log(APPLY ? '\napplied.' : '\nDRY RUN — nothing was written. Re-run with --apply.');
