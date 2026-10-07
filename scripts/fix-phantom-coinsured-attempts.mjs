/**
 * Corrects call attempts filed against a co-insured who does not exist.
 *
 * On 11 Grade A policies from C1 onward the owner2 columns hold a verbatim copy of the
 * insured's own name — insured "Angela Matera", co-insured "Angela Matera". Until the
 * 7 Oct fix, coInsuredPhonePool() read owner2Phone straight off the column without the
 * identity check every other co-insured rule applies, so that number was offered on the
 * card as a second person's. Ruben rang it, and the attempt was stored with
 * numberRole = 'co_insured'.
 *
 * The attempt row is a true record of what was dialled. What is wrong is the label
 * beside the number, and it is wrong in the source data rather than in the reading —
 * so it is corrected here rather than patched over in every report that reads it.
 *
 * Scope is deliberately narrow: ONLY attempts whose lead has no distinct second person
 * at all. An attempt on a number that has since been retired as a bad number is left
 * alone — that number was genuinely the co-insured's when it was rung.
 *
 * Usage:  node scripts/fix-phantom-coinsured-attempts.mjs [--apply]
 *         (prints what it would change and exits unless --apply is given)
 */
import { neon } from '@neondatabase/serverless';
import { readFileSync } from 'fs';

const APPLY = process.argv.includes('--apply');
const url = readFileSync('.env', 'utf-8').match(/DATABASE_URL=([^\n]+)/)[1].trim().replace(/^["']|["']$/g, '');
const sql = neon(url);

const rows = await sql`
  SELECT a."id", a."attemptedAt", a."numberDialled", a."numberLabel", a."outcome",
         l."owner1FirstName", l."owner1LastName", l."owner2FirstName", l."owner2LastName",
         l."cohort"
    FROM "CallAttempt" a
    JOIN "Lead" l ON l."propertyId" = a."propertyId"
   WHERE a."numberRole" = 'co_insured'
     AND (
       l."owner2FirstName" IS NULL OR l."owner2FirstName" = '' OR
       l."owner2LastName"  IS NULL OR l."owner2LastName"  = '' OR
       (LOWER(TRIM(l."owner2FirstName")) = LOWER(TRIM(l."owner1FirstName"))
        AND LOWER(TRIM(l."owner2LastName"))  = LOWER(TRIM(l."owner1LastName")))
     )
   ORDER BY a."attemptedAt"`;

console.log(`${APPLY ? 'CORRECTING' : 'WOULD CORRECT'} ${rows.length} attempt(s):\n`);
for (const r of rows) {
  console.log(`  ${String(r.attemptedAt).slice(0, 15)}  ${(r.owner1FirstName + ' ' + r.owner1LastName).padEnd(22)}`
    + `  ${r.numberDialled}  ${String(r.outcome).padEnd(16)}`);
  console.log(`      owner2 on the policy: "${r.owner2FirstName ?? ''} ${r.owner2LastName ?? ''}".trim() -> not a second person`);
  // numberLabel is PROVENANCE — which column the number came from — and 'owner2Phone'
  // is a true statement about where it was read. Only the role was a judgement, and only
  // the judgement was wrong.
  console.log(`      numberRole 'co_insured' -> 'insured'  (numberLabel ${JSON.stringify(r.numberLabel)} left as it is)`);
}

if (!rows.length) { console.log('  nothing to do.'); process.exit(0); }

if (!APPLY) { console.log('\nDry run. Re-run with --apply to write.'); process.exit(0); }

const ids = rows.map((r) => r.id);
const done = await sql`
  UPDATE "CallAttempt"
     SET "numberRole" = 'insured'
   WHERE "id" = ANY(${ids})
     AND "numberRole" = 'co_insured'
  RETURNING "id"`;
console.log(`\nUpdated ${done.length} row(s).`);

// Read back rather than trusting the write: a successful statement is not evidence the
// rows now read the way the reports will read them.
const left = await sql`
  SELECT COUNT(*)::int AS n FROM "CallAttempt" WHERE "id" = ANY(${ids}) AND "numberRole" = 'co_insured'`;
console.log(`Still tagged co_insured among those rows: ${left[0].n} (expected 0).`);
