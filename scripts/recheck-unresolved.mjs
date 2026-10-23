/**
 * Re-ask the roll for every card whose stored verdict never resolved.
 *
 *   node --import ./scripts/lib/register-ts.mjs scripts/recheck-unresolved.mjs            # dry run
 *   node --import ./scripts/lib/register-ts.mjs scripts/recheck-unresolved.mjs --apply
 *   ... --grade A --cohorts numbered --status not_found,ambiguous --limit 20
 *
 * ── How this differs from recheck-roll-zip ──────────────────────────────────
 * That script re-asks one ZIP because the ZIP was pointed at the wrong roll. This one
 * re-asks by VERDICT, across every ZIP, because the question we put to the roll was
 * malformed: an address we could not spell the way the township spells it.
 *
 * Written for the street-suffix fix of 22 Oct 2026 — PLZ, KY, TPKE and nine other
 * abbreviations were missing from STREET_SUFFIX, the suffix map was expanding "St" wherever
 * it appeared, the broad fallback query was silently not being generated, and 64 addresses
 * carry a phantom unit designator from the vendor ("7 Florence Dr Fl Orence"). All four are
 * reasons a roll said "no" to a question that was never the right question.
 *
 * ── Cost and courtesy ───────────────────────────────────────────────────────
 * Free in credits, not free to the municipalities: taxRoll.service serialises every request
 * behind a 1.5s gap and a miss costs one request per town, per endpoint, per spelling. A
 * dry run costs exactly as much as a real one, so prefer --limit while iterating.
 *
 * Only cards that never resolved are touched. A stored `match` or `mismatch` is a real
 * answer to a well-formed question and is left alone.
 */
import { randomUUID } from 'node:crypto';
import './lib/env.mjs';
import { sql } from '@/lib/neon';
import { verifyOwnerName, normalizeStreet, searchQueries } from '@/services/taxRoll.service';

/**
 * The activity row is written over HTTP here, not through storage.service's addActivity.
 *
 * addActivity uses `pool`, which is Neon's WebSocket transport. Deployed that is fine — the
 * function runs in the same region as the database. From a developer machine the socket
 * drops, and it surfaces as a raw WebSocket ErrorEvent carrying none of the codes
 * withRetry() in src/lib/neon.ts looks for (UND_ERR_CONNECT_TIMEOUT, ECONNREFUSED, …), so it
 * is not retried and not even caught — it reaches the process as an uncaught exception. A
 * first apply run died that way on card 9 of 26, having written 8 verdicts and 7 activity
 * rows: the card in between kept its new verdict and lost its audit trail, which is the one
 * outcome this script exists to prevent.
 *
 * `sql` is the HTTP client and does carry the retry, so both writes for a card now travel
 * the same way. addActivity itself is left alone — it is used across the app and the app is
 * live; this is a script's problem, not its.
 */
async function logActivity(leadId, type, content, metadata, createdBy) {
  await sql`
    INSERT INTO "Activity" ("id", "leadId", "type", "content", "metadata", "createdBy", "createdAt")
    VALUES (${randomUUID()}, ${leadId}, ${type}, ${content},
            ${metadata ? JSON.stringify(metadata) : null}, ${createdBy ?? null},
            ${new Date().toISOString()})`;
}

const argv = process.argv.slice(2);
const flag = (name, fallback) => {
  const i = argv.indexOf(`--${name}`);
  return i === -1 ? fallback : argv[i + 1];
};
const APPLY = argv.includes('--apply');
const GRADE = flag('grade', 'A');
const COHORTS = flag('cohorts', 'numbered');
const STATUSES = String(flag('status', 'not_found,ambiguous')).split(',').map((s) => s.trim()).filter(Boolean);
const LIMIT = Number(flag('limit', '0')) || 0;
/**
 * --ids writes the result of a dry run without asking every town a second time.
 *
 * The dry run and the apply run ask identical questions, so re-running the whole set to
 * write it doubles what the municipalities are asked for no new information. Narrowing the
 * apply to the cards the dry run reported as changed is the courteous way round. The lookup
 * still happens — nothing is written from the earlier output — so a verdict that has since
 * moved is written as it is now, not as it was then.
 */
const IDS = String(flag('ids', '')).split(/[,\s]+/).map((s) => s.trim()).filter(Boolean);
const ACTOR = 'system:recheck-unresolved';

const numbered = COHORTS === 'numbered';
const rows = await sql`
  SELECT "id", "propertyId", "cohort", "addressStreet", "addressZip",
         "owner1FirstName", "owner1LastName",
         "ownerVerifyStatus", "ownerVerifyName", "ownerVerifySource"
    FROM "Lead"
   WHERE COALESCE("manualGrade","grade") = ${GRADE}
     AND (${!numbered} OR "cohort" BETWEEN '2026-10-05' AND '2026-11-23')
     AND "ownerVerifyStatus" = ANY(${STATUSES})
     AND (${IDS.length === 0} OR "propertyId" = ANY(${IDS}))
     AND "addressStreet" IS NOT NULL AND "addressStreet" <> ''
   ORDER BY "addressZip", "propertyId"`;

if (IDS.length && rows.length !== IDS.length) {
  // A card named on the command line that no longer matches the filters has been changed by
  // something else since the dry run. Writing the rest regardless would hide that.
  const found = new Set(rows.map((r) => String(r.propertyId)));
  console.log(`*** ${IDS.length} id(s) given, ${rows.length} still unresolved and in scope`);
  IDS.filter((id) => !found.has(id)).forEach((id) => console.log(`      missing: ${id}`));
  console.log('');
}

const work = LIMIT ? rows.slice(0, LIMIT) : rows;
console.log(`${work.length} unresolved card(s)${LIMIT ? ` (limited from ${rows.length})` : ''}`
  + `  [grade ${GRADE}, ${COHORTS} cohorts, status ${STATUSES.join('/')}${IDS.length ? ', id-filtered' : ''}]`);
console.log(`${APPLY ? 'WRITING changes' : 'Dry run — nothing will be written'}\n`);

const transitions = new Map();
const resolved = [];
let done = 0;

for (const l of work) {
  const before = l.ownerVerifyStatus;
  let v;
  try {
    v = await verifyOwnerName(l);
  } catch (err) {
    console.log(`  !! ${l.propertyId} ${l.addressStreet} — ${err?.message ?? 'lookup threw'}`);
    continue;
  }
  done++;
  transitions.set(`${before} -> ${v.status}`, (transitions.get(`${before} -> ${v.status}`) ?? 0) + 1);

  if (v.status !== before) {
    resolved.push({ lead: l, before, v });
    console.log(`  ${l.propertyId}  ${(l.addressStreet ?? '').padEnd(32)} ${l.addressZip}`);
    console.log(`     ${before} -> ${v.status}`);
    console.log(`     asked as: ${JSON.stringify(searchQueries(l.addressStreet ?? ''))}`);
    console.log(`     ours "${normalizeStreet(l.addressStreet)}"  roll "${v.recordName ?? '—'}" via ${v.source ?? '—'}`);
  }

  if (APPLY) {
    // Replaced as a set — see the note in recheck-roll-zip.mjs.
    await sql`
      UPDATE "Lead"
         SET "ownerVerifyStatus" = ${v.status},
             "ownerVerifyName"   = ${v.recordName ?? null},
             "ownerVerifySource" = ${v.source ?? `tax_roll_${v.status}`},
             "ownerVerifyDetail" = ${v.detail ?? null},
             "ownerVerifyAt"     = ${(v.checkedAt ?? new Date()).toISOString()}
       WHERE "id" = ${l.id}`;
    if (v.status !== before) {
      await logActivity(
        l.id,
        'owner_verify',
        `Tax roll re-asked after the street-suffix fix: ${before} → ${v.status}`
          + `${v.recordName ? ` — record shows "${v.recordName}"` : ''}.`,
        {
          from: before, to: v.status,
          previousName: l.ownerVerifyName, previousSource: l.ownerVerifySource,
          recordName: v.recordName ?? null, source: v.source ?? null,
          askedAs: searchQueries(l.addressStreet ?? ''),
          reason: 'street suffix / phantom designator fix',
        },
        ACTOR,
      );
    }
  }

  if (done % 20 === 0) process.stdout.write(`     … ${done}/${work.length}\n`);
}

console.log(`\nasked ${done} of ${work.length}; ${resolved.length} card(s) changed verdict`);
console.log('\ntransitions');
[...transitions.entries()].sort((a, b) => b[1] - a[1]).forEach(([k, n]) => {
  const [from, to] = k.split(' -> ');
  console.log(`  ${from === to ? ' ' : '*'} ${k.padEnd(30)} ${n}`);
});
const nowMatch = resolved.filter((r) => r.v.status === 'match').length;
const nowPartial = resolved.filter((r) => r.v.status === 'partial').length;
const nowMismatch = resolved.filter((r) => r.v.status === 'mismatch').length;
console.log(`\nnewly confirmed (match): ${nowMatch}`);
console.log(`newly partial:          ${nowPartial}`);
console.log(`newly mismatch:         ${nowMismatch}   <- found the property, it is someone else`);
if (!APPLY) console.log('\nDry run — nothing written. Re-run with --apply.');
