/**
 * Ask the tax roll again for every lead in one ZIP.
 *
 *   node --import ./scripts/lib/register-ts.mjs scripts/recheck-roll-zip.mjs 07726          # dry run
 *   node --import ./scripts/lib/register-ts.mjs scripts/recheck-roll-zip.mjs 07726 --apply
 *   ... --grade A --cohorts numbered --limit 20
 *
 * ── When this is the right tool ─────────────────────────────────────────────
 * A roll answer is cached on the card on purpose: asking a small municipal service the same
 * question twice is rude and slow. So a verdict only becomes wrong when the QUESTION was
 * wrong — a ZIP pointed at the wrong roll, or a town missing from WIPP_BY_ZIP. Then the
 * cache is the problem and the cards have to be asked again.
 *
 * It was written for 07726 on 22 Oct 2026. That ZIP was configured with 'WMON', which is the
 * Western Monmouth Utilities Authority and not Manalapan Township; 106 Grade A cards had
 * been graded against a water and sewer roll whose account holder is not always the person
 * on the deed. Verified on 24 Deepwater Cir Unit A: the utility roll returned the Unit B
 * owner and the card read "name does not match", while Manalapan's tax roll (1328) returns
 * MATERA, ANGELA F at Unit A — the person on the card.
 *
 * ── Cost and courtesy ───────────────────────────────────────────────────────
 * No credits: the rolls are free. But every request is a request to a municipality, and
 * taxRoll.service serialises them behind a 1.5s gap, so this is minutes of wall clock and
 * should be run deliberately rather than on a schedule. A lead that hits on its first query
 * costs one request; a miss costs one per town, per endpoint, per spelling.
 *
 * Re-asking is safe for the record: ownerVerifyName, Source, At and Detail are all replaced
 * together by the fresh answer, so the card never mixes one roll's name with another's
 * verdict. Every change is written to the activity log with both sides of it.
 */
import './lib/env.mjs';
/**
 * The app's client, not a bare neon() one.
 *
 * A first run of this script built its own client and set neonConfig.fetchFunction with a
 * 30s AbortSignal, on the assumption that this was what src/lib/neon.ts does to survive a
 * cold Neon endpoint. It is not: undici's connect timeout is a separate 10s ceiling that no
 * request signal reaches, so the override did nothing and the run died on card 8 of 106 with
 * UND_ERR_CONNECT_TIMEOUT. What actually keeps the app up is withRetry() in src/lib/neon.ts,
 * which replays connect-phase failures only — safe for an UPDATE, because a request that
 * never reached the server cannot have applied. Importing sql from there inherits that, and
 * means a script and a page fail the same way instead of two different ways.
 */
import { randomUUID } from 'node:crypto';
import { sql } from '@/lib/neon';
import { verifyOwnerName, WIPP_BY_ZIP } from '@/services/taxRoll.service';

/**
 * The activity row goes over HTTP, not through storage.service's addActivity.
 *
 * addActivity uses `pool`, Neon's WebSocket transport. Deployed that is fine — same region as
 * the database. From a developer machine the socket drops and arrives as a raw WebSocket
 * ErrorEvent, which carries none of the codes withRetry() in src/lib/neon.ts matches, so it is
 * neither retried nor caught and kills the process. This script died that way at card 60 of
 * 106 on 23 Oct 2026, mid-way through a run that was otherwise working.
 *
 * `sql` is the HTTP client and does carry the retry, so a card's verdict and its audit row now
 * travel the same way and fail the same way. addActivity itself is untouched: it is used all
 * over a live app, and this is a script's problem.
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
const ZIP = (argv.find((a) => /^\d{5}$/.test(a)) ?? '').trim();
const APPLY = argv.includes('--apply');
const GRADE = flag('grade', 'A');
const COHORTS = flag('cohorts', 'numbered');
const LIMIT = Number(flag('limit', '0')) || 0;
/**
 * --since lets an interrupted run be resumed without asking the municipality again for the
 * cards it already answered. A re-ask is free in credits but not in courtesy, and the verdict
 * it would produce is the one already on the card.
 */
const SINCE = flag('since', '');
const ACTOR = 'system:recheck-roll-zip';

if (!ZIP) {
  console.error('usage: recheck-roll-zip.mjs <zip> [--apply] [--grade A] [--cohorts numbered|all] [--limit n] [--since <iso>]');
  process.exit(1);
}
if (SINCE && Number.isNaN(Date.parse(SINCE))) {
  console.error(`--since ${SINCE} is not a date I can read.`);
  process.exit(1);
}
const munis = WIPP_BY_ZIP[ZIP];
if (!munis?.length) {
  console.error(`No roll is configured for ${ZIP}. Nothing to ask.`);
  process.exit(1);
}
console.log(`${ZIP} is checked against: ${munis.map((m) => `${m.town} (${m.wippId})`).join('  ->  ')}\n`);

const numbered = COHORTS === 'numbered';
const rows = await sql`
  SELECT "id", "propertyId", "cohort", "addressStreet", "addressZip",
         "owner1FirstName", "owner1LastName",
         "ownerVerifyStatus", "ownerVerifyName", "ownerVerifySource", "ownerVerifyAt"
    FROM "Lead"
   WHERE "addressZip" = ${ZIP}
     AND COALESCE("manualGrade","grade") = ${GRADE}
     AND (${!numbered} OR "cohort" BETWEEN '2026-10-05' AND '2026-11-23')
     AND (${!SINCE} OR "ownerVerifyAt" IS NULL OR "ownerVerifyAt" < ${SINCE || '1970-01-01'})
   ORDER BY "cohort", "propertyId"`;

const work = LIMIT ? rows.slice(0, LIMIT) : rows;
console.log(`${work.length} card(s) to re-ask${LIMIT ? ` (limited from ${rows.length})` : ''}`);
if (SINCE) console.log(`skipping any already re-asked at or after ${SINCE}`);
console.log(`${APPLY ? 'WRITING changes' : 'Dry run — nothing will be written'}\n`);

const changes = [];
const transitions = new Map();
let done = 0;

for (const l of work) {
  const before = l.ownerVerifyStatus ?? '(never run)';
  let v;
  try {
    v = await verifyOwnerName(l);
  } catch (err) {
    console.log(`  !! ${l.propertyId} ${l.addressStreet} — ${err?.message ?? 'lookup threw'}`);
    continue;
  }
  done++;
  const k = `${before} -> ${v.status}`;
  transitions.set(k, (transitions.get(k) ?? 0) + 1);

  const nameChanged = (v.recordName ?? null) !== (l.ownerVerifyName ?? null);
  if (v.status !== before || nameChanged) {
    changes.push({ lead: l, before, v });
    console.log(`  ${l.propertyId}  ${l.addressStreet}`);
    console.log(`     ${before} -> ${v.status}`);
    console.log(`     was: "${l.ownerVerifyName ?? '—'}" via ${l.ownerVerifySource ?? '—'}`);
    console.log(`     now: "${v.recordName ?? '—'}" via ${v.source ?? '—'}`);
  }

  if (APPLY) {
    /**
     * Replaced as a set, never piecemeal.
     *
     * A card holding one roll's name beside another roll's verdict is worse than either
     * answer on its own, and nothing downstream could tell which roll it came from.
     * An outcome with no record (not_found, unsupported, unavailable, ambiguous) clears the
     * name rather than leaving the previous roll's owner sitting under a new verdict.
     */
    await sql`
      UPDATE "Lead"
         SET "ownerVerifyStatus" = ${v.status},
             "ownerVerifyName"   = ${v.recordName ?? null},
             "ownerVerifySource" = ${v.source ?? `tax_roll_${v.status}`},
             "ownerVerifyDetail" = ${v.detail ?? null},
             "ownerVerifyAt"     = ${(v.checkedAt ?? new Date()).toISOString()}
       WHERE "id" = ${l.id}`;
    if (v.status !== before || nameChanged) {
      await logActivity(
        l.id,
        'owner_verify',
        `Tax roll re-asked for ${ZIP}: ${before} → ${v.status}`
          + `${v.recordName ? ` — record shows "${v.recordName}"` : ''}`
          + `. Previously "${l.ownerVerifyName ?? '—'}" via ${l.ownerVerifySource ?? '—'}.`,
        {
          from: before, to: v.status,
          previousName: l.ownerVerifyName, previousSource: l.ownerVerifySource,
          recordName: v.recordName ?? null, source: v.source ?? null,
          reason: `${ZIP} roll order corrected`,
        },
        ACTOR,
      );
    }
  }

  if (done % 20 === 0) process.stdout.write(`     … ${done}/${work.length}\n`);
}

console.log(`\nasked ${done} of ${work.length}; ${changes.length} card(s) differ`);
console.log('\ntransitions');
[...transitions.entries()].sort((a, b) => b[1] - a[1]).forEach(([k, n]) => {
  const [from, to] = k.split(' -> ');
  console.log(`  ${from === to ? ' ' : '*'} ${k.padEnd(30)} ${n}`);
});
if (!APPLY) console.log('\nDry run — nothing written. Re-run with --apply.');
else console.log('\nWritten. Retroactive changes to worked accounts appear in tonight\'s retro report.');
