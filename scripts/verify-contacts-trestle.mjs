/**
 * Grade EVERY number on a cohort's cards through Trestle. DRY BY DEFAULT — --apply writes.
 *
 *   node scripts/verify-contacts-trestle.mjs --cohort=2026-10-12 --grade=A
 *   node scripts/verify-contacts-trestle.mjs --cohort=2026-10-12 --grade=A --apply
 *
 * ── Every number the card shows, not just the three slots ───────────────────
 * The first run graded phone1/phone2/owner2Phone only — 172 numbers across C2. But the card
 * displays numbersOnCard(), which also carries the numbers the skip trace attributed to the
 * matched person, and that is 473 on the same 61 leads. Grading a third of the list left a
 * caller unable to tell a checked number from an unchecked one, which is the whole point of
 * doing this. So the source of truth here is the same function the card renders from — if it
 * is on the card, it gets a verdict.
 *
 * ── Already-graded numbers are skipped ──────────────────────────────────────
 * Re-running costs money and tells us nothing new, so a number that already has a verdict is
 * left alone. Pass --recheck to grade them again anyway.
 *
 * ── Quota stops the run ─────────────────────────────────────────────────────
 * When the trial allowance ran out mid-batch every remaining lookup returned 429. A run that
 * carried on would have written those as verdicts, when they really mean "we were not
 * allowed to ask". On TRESTLE_QUOTA this stops.
 */
import { randomUUID } from 'crypto';
import { execSync } from 'child_process';
import { readFileSync, existsSync, writeFileSync, mkdirSync } from 'fs';
import { join, resolve } from 'path';
import { createRequire } from 'module';
import Module from 'module';
import { Pool } from '@neondatabase/serverless';

const arg = (n, d) => (process.argv.find((a) => a.startsWith(`--${n}=`)) ?? `--${n}=${d}`).slice(n.length + 3);
const COHORT = arg('cohort', '2026-10-12');
const GRADE = arg('grade', 'A');
const LIMIT = Number(arg('limit', '0')) || null;
const APPLY = process.argv.includes('--apply');
const RECHECK = process.argv.includes('--recheck');

for (const f of ['.env', '.env.local']) {
  if (!existsSync(f)) continue;
  for (const line of readFileSync(f, 'utf8').split(/\r?\n/)) {
    const m = line.match(/^\s*([A-Za-z0-9_]+)\s*=\s*(.*)$/);
    if (m) process.env[m[1].trim()] ??= m[2].trim().replace(/^["']|["']$/g, '');
  }
}

/**
 * Compile the REAL callLog.service rather than re-deriving the card's number list.
 *
 * numbersOnCard applies the identity guard on the co-insured, the DNC ordering and the
 * dedupe. A second implementation here would drift from the card the first time either
 * changed, and the whole exercise is "grade what the caller sees".
 */
// Built inside the project, not a temp dir: the emitted JS requires @neondatabase and
// friends, and Node resolves those by walking up from the file to node_modules.
const out = resolve('.verify-build');
mkdirSync(out, { recursive: true });
const tsconfig = join(out, 'tsconfig.json');
writeFileSync(tsconfig, JSON.stringify({
  compilerOptions: {
    target: 'es2022', module: 'commonjs', moduleResolution: 'node',
    skipLibCheck: true, esModuleInterop: true,
    baseUrl: resolve('.'), paths: { '@/*': ['src/*'] }, outDir: out,
  },
  include: [resolve('src/services/callLog.service.ts'), resolve('src/lib/integrations/trestle.ts')],
}));
execSync(`npx tsc -p "${tsconfig}"`, { stdio: 'pipe' });
const req = createRequire(import.meta.url);
const origResolve = Module._resolveFilename;
Module._resolveFilename = function (request, ...rest) {
  // The emitted JS keeps the @/ specifiers; point them at the build output.
  if (request.startsWith('@/')) request = join(out, request.slice(2));
  return origResolve.call(this, request, ...rest);
};
const { numbersOnCard } = req(join(out, 'services/callLog.service.js'));
const { realContact, normalisePhone, GATE_ACTIVITY_MIN } = req(join(out, 'lib/integrations/trestle.js'));

const pool = new Pool({ connectionString: process.env.DATABASE_URL });
const q = async (text, params) => {
  let e;
  for (let i = 0; i < 6; i++) {
    try { return await pool.query(text, params); } catch (x) {
      e = x;
      if (!/connect/i.test(String(x?.message ?? ''))) throw x;
      await new Promise((r) => setTimeout(r, 1500));
    }
  }
  throw e;
};

const leads = (await q(
  `SELECT * FROM "Lead" WHERE "cohort" = $1 AND COALESCE("manualGrade","grade") = $2 ORDER BY "propertyId"`,
  [COHORT, GRADE],
)).rows;

const existing = new Set(
  (await q(`SELECT "leadId","value","personRole" FROM "ContactVerification"`)).rows
    .map((r) => `${r.leadId}|${r.value}|${r.personRole}`),
);

const jobs = [];
for (const l of (LIMIT ? leads.slice(0, LIMIT) : leads)) {
  for (const n of numbersOnCard(l)) {
    const phone = normalisePhone(n.number);
    // numbersOnCard names the person for us — the insured or the co-insured, already
    // guarded against a co-insured slot that merely repeats the insured's own name.
    const who = n.person;
    if (!phone || !who) continue;
    const role = n.role === 'co_insured' ? 'coInsured' : 'insured';
    if (!RECHECK && existing.has(`${l.id}|${phone}|${role}`)) continue;
    jobs.push({ lead: l, phone, role, who, email: role === 'insured' ? (l.email1 ?? null) : (l.owner2Email ?? null) });
  }
}

console.log(APPLY ? 'APPLYING' : 'DRY RUN — nothing will be written');
console.log(`${COHORT} grade ${GRADE}: ${leads.length} leads`);
console.log(`${jobs.length} numbers to grade${RECHECK ? '' : `  (${existing.size} already have a verdict and are skipped)`}\n`);

const results = [];
let pass = 0, notTheirs = 0, quiet = 0, errored = 0, stopped = false;
for (const [i, j] of jobs.entries()) {
  let g = null, err = '';
  try {
    g = await realContact({
      name: j.who, phone: j.phone, email: j.email,
      street: j.lead.addressStreet, city: j.lead.addressCity,
      state: j.lead.addressState ?? 'NJ', zip: j.lead.addressZip,
    });
  } catch (e) {
    err = String(e?.message ?? e);
    if (err.startsWith('TRESTLE_QUOTA')) {
      console.log(`\n!! quota exhausted after ${i} lookups — stopping so the rest are not written as failures`);
      stopped = true;
      break;
    }
    errored++;
  }
  const verdict = !g ? 'error'
    : g.nameMatch === false ? 'NOT THEIRS'
      : (g.activityScore ?? 0) >= GATE_ACTIVITY_MIN ? 'verified' : 'quiet line';
  if (verdict === 'verified') pass++;
  else if (verdict === 'NOT THEIRS') notTheirs++;
  else if (verdict === 'quiet line') quiet++;

  results.push({
    propertyId: j.lead.propertyId, person: j.who, role: j.role, phone: j.phone, verdict,
    nameMatch: g?.nameMatch ?? null, activityScore: g?.activityScore ?? null,
    contactGrade: g?.contactGrade ?? null, lineType: g?.lineType ?? null, error: err,
  });
  if (i % 25 === 0 || verdict === 'NOT THEIRS') {
    console.log(`${String(i + 1).padStart(4)}/${jobs.length} ${verdict.padEnd(11)} ${j.phone}  ${j.who}`);
  }

  if (APPLY) {
    await q(
      `INSERT INTO "ContactVerification"
         ("id","leadId","channel","value","personRole","nameSent","nameMatch","isValid",
          "activityScore","contactGrade","lineType","provider","checkedAt","error")
       VALUES ($1,$2,'phone',$3,$4,$5,$6,$7,$8,$9,$10,'trestle',$11,$12)
       ON CONFLICT ("leadId","value","personRole") DO UPDATE SET
         "nameSent" = EXCLUDED."nameSent", "nameMatch" = EXCLUDED."nameMatch",
         "isValid" = EXCLUDED."isValid", "activityScore" = EXCLUDED."activityScore",
         "contactGrade" = EXCLUDED."contactGrade", "lineType" = EXCLUDED."lineType",
         "checkedAt" = EXCLUDED."checkedAt", "error" = EXCLUDED."error"`,
      [randomUUID(), j.lead.id, j.phone, j.role, j.who,
        g?.nameMatch ?? null, g?.isValid ?? null, g?.activityScore ?? null,
        g?.contactGrade ?? null, g?.lineType ?? null,
        g ? new Date().toISOString() : null, err || null],
    );
  }
  await new Promise((r) => setTimeout(r, 220));
}

console.log(`\n── ${COHORT} grade ${GRADE} ─────────────────────────`);
console.log(`graded this run : ${results.length} of ${jobs.length}${stopped ? '  (stopped on quota)' : ''}`);
console.log(`verified        : ${pass}`);
console.log(`quiet line      : ${quiet}`);
console.log(`NOT theirs      : ${notTheirs}`);
if (errored) console.log(`errored         : ${errored}`);

const path = `contact-verify-${COHORT}-${GRADE}.csv`;
const cols = Object.keys(results[0] ?? { propertyId: '' });
const esc = (v) => `"${String(v ?? '').replace(/"/g, '""')}"`;
writeFileSync(path, [cols.join(','), ...results.map((r) => cols.map((c) => esc(r[c])).join(','))].join('\n'));
console.log(`\nPer-number detail → ${path}`);
console.log(APPLY ? 'Written to ContactVerification. No card was changed.' : 'DRY RUN — nothing written.');
await pool.end();
