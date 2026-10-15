/**
 * Ask USPS what a squashed-unit address really is. DRY BY DEFAULT — --apply writes.
 *
 *   node scripts/verify-addresses-lob.mjs            # count and cost, asks nothing
 *   node scripts/verify-addresses-lob.mjs --apply    # verifies, stores the verdicts
 *
 * ── What it does and does not do ────────────────────────────────────────────
 * It writes to AddressCorrection only. It does NOT change anybody's address: applying a
 * verdict to the Lead row is a separate, deliberate step, because a correction to where a
 * person lives should not be a side effect of a lookup.
 *
 * ── Cost ────────────────────────────────────────────────────────────────────
 * $0.05 per address on the current plan. Every address is asked about at most once — the
 * original first, because "720A Mount Vernon Rd" may well be correct as it stands and USPS
 * allows alphanumeric house numbers. Only if the original is refused are the candidates
 * tried, cheapest question first.
 */
import { randomUUID } from 'crypto';
import { execSync } from 'child_process';
import { readFileSync, existsSync, writeFileSync, mkdirSync } from 'fs';
import { join, resolve } from 'path';
import { createRequire } from 'module';
import Module from 'module';
import { Pool } from '@neondatabase/serverless';

const APPLY = process.argv.includes('--apply');
/**
 * A hard ceiling on what this run may spend, in dollars.
 *
 * The cost is not knowable up front: an address that USPS accepts as written costs one
 * lookup, one that needs its second candidate costs three. The first estimate assumed one
 * each and was 2.4x under at the worst case. So the budget is stated rather than inferred,
 * and the run stops when it is reached rather than discovering the overrun on the invoice.
 */
const MAX_SPEND = Number((process.argv.find((a) => a.startsWith('--max-spend=')) ?? '').split('=')[1] || 35);
const PER_LOOKUP = 0.05;
const GRADE = (process.argv.find((a) => a.startsWith('--grade=')) ?? '').split('=')[1] || null;

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
  include: [resolve('src/services/addressUnit.service.ts'), resolve('src/lib/integrations/lob.ts')],
}));
execSync(`npx tsc -p "${join(out, 'tsconfig.json')}"`, { stdio: 'pipe' });
const req = createRequire(import.meta.url);
const origResolve = Module._resolveFilename;
Module._resolveFilename = function (r, ...rest) {
  if (r.startsWith('@/')) r = join(out, r.slice(2));
  return origResolve.call(this, r, ...rest);
};
const { proposeUnit, unitShape } = req(join(out, 'services/addressUnit.service.js'));
const { verifyAddress } = req(join(out, 'lib/integrations/lob.js'));

const pool = new Pool({ connectionString: process.env.DATABASE_URL });

const leads = (await pool.query(`
  SELECT "id","propertyId","cohort", COALESCE("manualGrade","grade") AS grade,
         "addressStreet","addressCity","addressState","addressZip",
         "mailStreet","mailCity","mailState","mailZip"
    FROM "Lead"
   WHERE "cohort" BETWEEN '2026-10-05' AND '2026-11-23'
   ORDER BY "propertyId"`)).rows;

/** Every (lead, field) pair that needs asking. Both columns, because both can be wrong. */
const jobs = [];
for (const l of leads) {
  if (GRADE && l.grade !== GRADE) continue;
  for (const field of ['mail', 'property']) {
    const street = field === 'mail' ? l.mailStreet : l.addressStreet;
    if (!unitShape(street)) continue;
    jobs.push({
      lead: l, field, street,
      city: field === 'mail' ? (l.mailCity ?? l.addressCity) : l.addressCity,
      state: (field === 'mail' ? l.mailState : l.addressState) ?? 'NJ',
      zip: field === 'mail' ? (l.mailZip ?? l.addressZip) : l.addressZip,
      proposal: proposeUnit(street),
    });
  }
}

/**
 * One question per distinct address, not per field.
 *
 * A lead's mailing and property columns very often hold the same string — "720a Mount
 * Vernon Rd" appears in both on most of these — and USPS's answer about that string does
 * not depend on which of our columns it came from. Asking twice doubled the bill for
 * nothing: 444 field-pairs collapse to the addresses actually distinct among them.
 */
const keyOf = (j) => [j.street, j.city, j.state, j.zip]
  .map((x) => String(x ?? '').trim().toLowerCase()).join('|');

const distinct = new Map();
for (const j of jobs) {
  const k = keyOf(j);
  if (!distinct.has(k)) distinct.set(k, { ...j, fields: [] });
  distinct.get(k).fields.push({ lead: j.lead, field: j.field });
}
const asks = [...distinct.values()];

const minCalls = asks.length;
const maxCalls = asks.reduce((t, j) => t + 1 + j.proposal.candidates.length, 0);
console.log(APPLY ? 'VERIFYING — this spends money' : 'DRY RUN — nothing asked, nothing written');
console.log(`field-pairs flagged: ${jobs.length}`);
console.log(`distinct addresses : ${asks.length}`);
console.log(`lookups            : ${minCalls} at best, ${maxCalls} at worst`);
console.log(`cost               : $${(minCalls * 0.05).toFixed(2)} – $${(maxCalls * 0.05).toFixed(2)} at $0.05 each\n`);

if (!APPLY) {
  console.log('Re-run with --apply to ask USPS.');
  await pool.end();
  process.exit(0);
}

async function writeVerdict(lead, field, ask, winner, verified, deliverability, error) {
  await pool.query(
    `INSERT INTO "AddressCorrection"
       ("id","leadId","propertyId","field","original","shape","candidates",
        "verified","deliverability","winner","checkedAt","error")
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)
     ON CONFLICT ("leadId","field") DO UPDATE SET
       "original" = EXCLUDED."original", "shape" = EXCLUDED."shape",
       "candidates" = EXCLUDED."candidates", "verified" = EXCLUDED."verified",
       "deliverability" = EXCLUDED."deliverability", "winner" = EXCLUDED."winner",
       "checkedAt" = EXCLUDED."checkedAt", "error" = EXCLUDED."error"`,
    [randomUUID(), lead.id, lead.propertyId, field, ask.street,
      ask.proposal.shape, ask.proposal.candidates, verified, deliverability, winner,
      new Date().toISOString(), error],
  );
}

let asked = 0;
let blocked = false;
const tally = { original_ok: 0, candidate_ok: 0, none_ok: 0, errored: 0 };
const results = [];

for (const [i, j] of asks.entries()) {
  /**
   * The original is asked about FIRST, and the candidates only if it fails.
   *
   * USPS permits alphanumeric house numbers, so "720A Mount Vernon Rd" may be exactly
   * right and every rewrite of it wrong. Asking the rule's answer first would have us
   * "correcting" addresses that were never broken.
   */
  const forms = [j.street, ...j.proposal.candidates];
  let winner = null; let verified = null; let deliverability = null; let error = null;

  if (blocked) break;
  if (asked * PER_LOOKUP >= MAX_SPEND) {
    console.log(`
!! spend ceiling of ${MAX_SPEND.toFixed(2)} reached after ${i} addresses — stopping.`);
    console.log('   Re-run with --max-spend= to continue; everything checked so far is saved.');
    break;
  }

  for (const form of forms) {
    try {
      asked++;
      const v = await verifyAddress({ street: form, city: j.city, state: j.state, zip: j.zip });
      deliverability = v.deliverability;
      if (v.deliverable) {
        winner = form === j.street ? 'original' : form;
        verified = v.corrected
          ? [v.corrected.street, v.corrected.street2].filter(Boolean).join(' ')
          : form;
        break;
      }
    } catch (e) {
      error = String(e?.message ?? e).slice(0, 300);
      /**
       * A blocked account is not a fact about this address.
       *
       * While Lob is reviewing a new account it pauses every live request — "live requests
       * are paused, test mode is unaffected" — and address verification is live-only. The
       * first run of this hit that on all 285 and wrote "errored" against every one, which
       * reads like 285 bad addresses rather than one unavailable service. Same discipline
       * as the tax roll: an outage must never be recorded as a verdict about a property.
       */
      if (/under review|403/.test(error)) {
        console.log(`
!! Lob is refusing live requests — the account is still under review.`);
        console.log('   Nothing was verified and nothing was charged. Try again once it clears.');
        blocked = true;
      }
      break;
    }
    await new Promise((r) => setTimeout(r, 120));
  }

  if (error) tally.errored++;
  else if (winner === 'original') tally.original_ok++;
  else if (winner) tally.candidate_ok++;
  else tally.none_ok++;

  if (blocked) break;
  for (const target of j.fields) {
    results.push({
      propertyId: target.lead.propertyId, grade: target.lead.grade, field: target.field,
      original: j.street, winner: winner ?? '', verified: verified ?? '',
      deliverability: deliverability ?? '', error: error ?? '',
    });
    await writeVerdict(target.lead, target.field, j, winner, verified, deliverability, error);
  }

  if (i % 20 === 0 || winner === 'original' || !winner) {
    console.log(`${String(i + 1).padStart(4)}/${asks.length} ${(winner ?? 'NONE').padEnd(34)} ${j.street}`);
  }
}

/**
 * A blocked run leaves nothing behind.
 *
 * The first attempt wrote 444 rows reading "errored" — which looks exactly like 444 bad
 * addresses and is in fact one unavailable service. Same rule the tax roll learned: an
 * outage is not a verdict, and recording it as one is how "unavailable" becomes "not on the
 * roll" across every lead it touched.
 */
if (blocked) {
  const cleared = await pool.query(
    `DELETE FROM "AddressCorrection" WHERE "error" ILIKE '%under review%' OR "error" ILIKE '%LOB_403%'`,
  );
  console.log(`\nCleared ${cleared.rowCount} rows this run and the last one wrote — none was a verdict about an address.`);
}

console.log(`\n── result ─────────────────────────`);
console.log(`lookups spent          : ${asked}  ($${(asked * 0.05).toFixed(2)})`);
console.log(`original was correct   : ${tally.original_ok}`);
console.log(`a candidate was correct: ${tally.candidate_ok}`);
console.log(`none deliverable       : ${tally.none_ok}`);
if (tally.errored) console.log(`errored                : ${tally.errored}`);

const path = 'address-corrections.csv';
const cols = Object.keys(results[0] ?? { propertyId: '' });
const esc = (v) => `"${String(v ?? '').replace(/"/g, '""')}"`;
writeFileSync(path, [cols.join(','), ...results.map((r) => cols.map((c) => esc(r[c])).join(','))].join('\n'));
console.log(`\nPer-address detail → ${path}`);
console.log('Stored in AddressCorrection. Nobody\'s address has been changed yet.');
await pool.end();
