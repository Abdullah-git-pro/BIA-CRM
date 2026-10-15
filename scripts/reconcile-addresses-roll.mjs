/**
 * When our two address columns disagree, ask the township which one it recognises.
 * DRY BY DEFAULT — --apply writes.
 *
 *   node scripts/reconcile-addresses-roll.mjs
 *   node scripts/reconcile-addresses-roll.mjs --apply
 *
 * ── The question this answers, and the one it does not ──────────────────────
 * 81 leads hold a mailing address that differs from the property address, and in the family
 * with a unit squashed into the house number the difference is often a corruption rather
 * than a real forwarding address: "85i Winthrop Rd" against "851 Winthrop Road". The roll
 * says "85I WINTHROP RD", so the mailing column is the damaged one.
 *
 * It does NOT say whether a letter will arrive. The township identifies a parcel; USPS
 * decides delivery, and they disagree about exactly these addresses. Deliverability comes
 * from the address verification and nowhere else — this only tells us which of OUR two
 * spellings matches the public record.
 *
 * ── Courtesy ────────────────────────────────────────────────────────────────
 * These are small municipal services. One lookup per lead, 1.5s apart, 81 leads — the same
 * shape and pace as the owner-name check that already runs against them.
 */
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
  include: [resolve('src/services/taxRoll.service.ts'), resolve('src/services/addressUnit.service.ts')],
}));
execSync(`npx tsc -p "${join(out, 'tsconfig.json')}"`, { stdio: 'pipe' });
const req = createRequire(import.meta.url);
const origResolve = Module._resolveFilename;
Module._resolveFilename = function (r, ...rest) {
  if (r.startsWith('@/')) r = join(out, r.slice(2));
  return origResolve.call(this, r, ...rest);
};
const { lookupTaxRoll, normalizeStreet } = req(join(out, 'taxRoll.service.js'));
const { unitShape } = req(join(out, 'addressUnit.service.js'));

const pool = new Pool({ connectionString: process.env.DATABASE_URL });

const leads = (await pool.query(`
  SELECT "id","propertyId", COALESCE("manualGrade","grade") AS grade,
         "addressStreet","addressZip","mailStreet","mailZip"
    FROM "Lead"
   WHERE "cohort" BETWEEN '2026-10-05' AND '2026-11-23'
     AND LOWER(TRIM(COALESCE("mailStreet",''))) <> LOWER(TRIM(COALESCE("addressStreet",'')))
     AND (COALESCE("mailStreet",'') ~ '^[0-9]+[A-Za-z] ' OR COALESCE("addressStreet",'') ~ '^[0-9]+[A-Za-z] '
       OR COALESCE("mailStreet",'') ~ '^[0-9]+-'       OR COALESCE("addressStreet",'') ~ '^[0-9]+-')
   ORDER BY "propertyId"`)).rows;

console.log(APPLY ? 'APPLYING' : 'DRY RUN — nothing written');
console.log(`leads whose two address columns disagree: ${leads.length}\n`);

const norm = (s) => String(s ?? '').trim().toUpperCase().replace(/[.,]/g, '').replace(/\s+/g, ' ');
const tally = { property: 0, mailing: 0, neither: 0, not_found: 0, unsupported: 0, error: 0 };
const results = [];

for (const [i, l] of leads.entries()) {
  let loc = null; let outcome = 'not_found';
  for (const [street, zip] of [[l.addressStreet, l.addressZip], [l.mailStreet, l.mailZip ?? l.addressZip]]) {
    if (!String(street ?? '').trim()) continue;
    try {
      const r = await lookupTaxRoll(street, zip);
      outcome = r.outcome;
      if (r.outcome === 'found' && r.records?.length) { loc = r.records[0].propertyLoc; break; }
    } catch (e) {
      outcome = 'error';
      results.push({ propertyId: l.propertyId, error: String(e.message).slice(0, 160) });
    }
    await new Promise((r) => setTimeout(r, 1500));
  }

  let says = 'neither';
  if (loc) {
    const L = norm(loc);
    const p = norm(l.addressStreet);
    const m = norm(l.mailStreet);
    // Exact after normalisation. Prefix matching was a crutch for the suffix problem above
    // and would now quietly accept "25 PITMAN ROAD" as "25 PITMAN ROAD UNIT B".
    const hit = (a) => !!a && L === a;
    if (hit(p) && !hit(m)) says = 'property';
    else if (hit(m) && !hit(p)) says = 'mailing';
    else if (hit(p) && hit(m)) says = 'both';
  } else {
    says = outcome === 'unsupported' ? 'unsupported' : outcome === 'error' ? 'error' : 'not_found';
  }
  tally[says] = (tally[says] ?? 0) + 1;

  results.push({
    propertyId: l.propertyId, grade: l.grade,
    property: l.addressStreet, mailing: l.mailStreet,
    rollSays: loc ?? '', matches: says,
  });

  if (APPLY && loc) {
    await pool.query(
      `UPDATE "Lead" SET "rollPropertyLoc" = $1, "rollPropertyLocAt" = NOW() WHERE "id" = $2`,
      [loc, l.id],
    );
  }

  if (i % 10 === 0 || says === 'mailing' || says === 'neither') {
    console.log(`${String(i + 1).padStart(3)}/${leads.length} ${says.padEnd(12)} roll:"${loc ?? '—'}"  prop:"${l.addressStreet}"  mail:"${l.mailStreet}"`);
  }
  await new Promise((r) => setTimeout(r, 1500));
}

console.log(`\n── which column the township recognises ──`);
for (const [k, v] of Object.entries(tally)) console.log(`  ${k.padEnd(12)}: ${v}`);

const path = 'address-roll-reconcile.csv';
const cols = ['propertyId', 'grade', 'property', 'mailing', 'rollSays', 'matches'];
const esc = (v) => `"${String(v ?? '').replace(/"/g, '""')}"`;
writeFileSync(path, [cols.join(','),
  ...results.filter((r) => r.propertyId && !r.error).map((r) => cols.map((c) => esc(r[c])).join(','))].join('\n'));
console.log(`\nPer-lead detail → ${path}`);
console.log(APPLY
  ? "Stored on Lead.rollPropertyLoc. No address column has been overwritten."
  : 'DRY RUN — nothing written.');
await pool.end();
