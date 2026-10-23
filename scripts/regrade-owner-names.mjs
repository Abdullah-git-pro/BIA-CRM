/**
 * Re-grade stored tax-roll name verdicts against the current comparator.
 *
 *   node --import ./scripts/lib/register-ts.mjs scripts/regrade-owner-names.mjs          # dry run
 *   node --import ./scripts/lib/register-ts.mjs scripts/regrade-owner-names.mjs --apply  # write
 *
 * ── Why this exists ─────────────────────────────────────────────────────────
 * The verdict on a card is our READING of what the township said, not the township's own
 * words — those are kept verbatim in ownerVerifyName. So when the comparator is corrected,
 * every stored verdict is out of date and nothing recomputes it: the roll is consulted once
 * and cached, which is right (it costs a municipal service a request) but means a fix to the
 * matching rules never reaches the cards already graded.
 *
 * It was written for the comma-less-roll fix of 22 Oct 2026. North Brunswick and several
 * other towns write "LAST FIRST" with no comma; the parser read that as "First Last", so the
 * surname became the given name and the owner came back as a different person. On C1-C8
 * Grade A that was 22 of 47 mismatches naming the person already on the card.
 *
 * ── What it deliberately does NOT touch ─────────────────────────────────────
 * ownerVerifyName, ownerVerifySource and ownerVerifyAt are left exactly as they are. The
 * roll has not been asked again — only our reading of its answer has changed — and moving
 * ownerVerifyAt would claim a check that did not happen, which is the same class of untruth
 * as recording an outage as "not on the roll".
 *
 * It spends nothing: no vendor call, no municipal request. One read and, with --apply, one
 * update plus one activity row per corrected card.
 */
import './lib/env.mjs';
import { neon, neonConfig } from '@neondatabase/serverless';
import { compareOwnerNames } from '@/services/ownerNameMatch.service';
import { addActivity } from '@/services/storage.service';

/** The app's 30s connect timeout; scripts do not inherit it and 10s is marginal from here. */
neonConfig.fetchFunction = (input, init) => fetch(input, {
  ...init,
  signal: init?.signal ?? AbortSignal.timeout(30_000),
});
const sql = neon(process.env.DATABASE_URL);

const APPLY = process.argv.includes('--apply');
const ACTOR = 'system:regrade-owner-names';

const rows = await sql`
  SELECT "id", "propertyId", "cohort", "addressZip",
         "owner1FirstName", "owner1LastName",
         "ownerVerifyName", "ownerVerifyStatus", "ownerVerifyDetail", "ownerVerifySource"
    FROM "Lead"
   WHERE "ownerVerifyName" IS NOT NULL
     AND "ownerVerifyName" <> ''
     AND "ownerVerifyStatus" IS NOT NULL
   ORDER BY "cohort", "propertyId"`;

const changes = [];
const transitions = new Map();

for (const r of rows) {
  const before = r.ownerVerifyStatus;
  const cmp = compareOwnerNames(
    { first: r.owner1FirstName, last: r.owner1LastName },
    r.ownerVerifyName,
  );
  const k = `${before} -> ${cmp.result}`;
  transitions.set(k, (transitions.get(k) ?? 0) + 1);
  if (cmp.result !== before) changes.push({ row: r, to: cmp.result, detail: cmp.detail });
}

console.log(`${rows.length} cards carry a stored roll verdict\n`);
console.log('transitions');
[...transitions.entries()]
  .sort((a, b) => b[1] - a[1])
  .forEach(([k, n]) => {
    const [from, to] = k.split(' -> ');
    console.log(`  ${from === to ? ' ' : '*'} ${k.padEnd(30)} ${n}`);
  });

/**
 * A verdict that was a MATCH and is no longer one is a regression, not a correction.
 *
 * The whole point of the change was to stop calling the right person a stranger; if it has
 * started calling the right person something else, the run stops rather than writing it.
 */
const regressions = changes.filter((c) => c.row.ownerVerifyStatus === 'match');
if (regressions.length) {
  console.log(`\n*** ${regressions.length} REGRESSION(S) — refusing to write ***`);
  regressions.forEach((c) => console.log(`  ${c.row.propertyId}  ${c.row.ownerVerifyName}  match -> ${c.to}`));
  process.exit(1);
}

console.log(`\n${changes.length} card(s) to correct`);
for (const c of changes) {
  const ours = `${c.row.owner1FirstName ?? ''} ${c.row.owner1LastName ?? ''}`.trim();
  console.log(`  ${c.row.propertyId}  ${c.row.addressZip}  ${c.row.ownerVerifyStatus} -> ${c.to}`);
  console.log(`     ours: ${ours.padEnd(34)} roll: ${c.row.ownerVerifyName}`);
}

if (!APPLY) {
  console.log('\nDry run — nothing written. Re-run with --apply to correct these cards.');
  process.exit(0);
}

let written = 0;
for (const c of changes) {
  await sql`
    UPDATE "Lead"
       SET "ownerVerifyStatus" = ${c.to},
           "ownerVerifyDetail" = ${c.detail}
     WHERE "id" = ${c.row.id}`;
  await addActivity(
    c.row.id,
    'owner_verify',
    `Owner name re-graded ${c.row.ownerVerifyStatus} → ${c.to} against the same `
      + `${String(c.row.ownerVerifySource ?? 'tax roll').replace(/_tax_roll$/, '').replace(/_/g, ' ')} record `
      + `("${c.row.ownerVerifyName}"). The roll was not asked again; the matching rules were corrected.`,
    {
      from: c.row.ownerVerifyStatus,
      to: c.to,
      recordName: c.row.ownerVerifyName,
      source: c.row.ownerVerifySource,
      reason: 'comma-less roll name convention',
    },
    ACTOR,
  );
  written++;
}

console.log(`\nCorrected ${written} card(s).`);
console.log('ownerVerifyName, ownerVerifySource and ownerVerifyAt are unchanged — the roll was not re-asked.');
console.log('These are retroactive changes to worked accounts, so they will appear in tonight\'s retro report.');
