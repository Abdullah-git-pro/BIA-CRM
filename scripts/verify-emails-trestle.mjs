/**
 * Grade a cohort's email addresses through Trestle. DRY BY DEFAULT — --apply writes.
 *
 *   node scripts/verify-emails-trestle.mjs --cohort=2026-10-12 --grade=A
 *   node scripts/verify-emails-trestle.mjs --cohort=2026-10-12 --grade=A --apply
 *
 * ── Why this is separate from the phone run ─────────────────────────────────
 * Trestle's Real Contact grades a phone AND an email in one request, and the phone run was
 * already sending the address along — so we paid for 306 email verdicts on 14 Oct and threw
 * every one away, because the writer only ever inserted 'phone' rows. This recovers them.
 *
 * It is not simply "re-run the phone script". A phone needs a verdict per NUMBER, of which a
 * card carries up to 24. An email needs one per ADDRESS, of which a card carries at most
 * three. Grading emails through the phone loop would buy 473 lookups to learn 134 facts; one
 * call per (person, address) buys them in 96.
 *
 * ── What the verdict means ──────────────────────────────────────────────────
 *   email.name_match   the address is associated with the person we named
 *   email.is_valid     the provider believes the mailbox exists
 *
 * This is NOT a replacement for ZeroBounce, which answers deliverability — whether a send
 * will bounce. They answer different questions and the campaign still gates on ZeroBounce.
 * What this adds is WHOSE address it is, which is the gap behind the name-check finding:
 * 22% of addresses we had emailed failed a name check and opened at 3.3% against 17.2%.
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

for (const f of ['.env', '.env.local']) {
  if (!existsSync(f)) continue;
  for (const line of readFileSync(f, 'utf8').split(/\r?\n/)) {
    const m = line.match(/^\s*([A-Za-z0-9_]+)\s*=\s*(.*)$/);
    if (m) process.env[m[1].trim()] ??= m[2].trim().replace(/^["']|["']$/g, '');
  }
}

const out = resolve('.verify-build');
mkdirSync(out, { recursive: true });
const tsconfig = join(out, 'tsconfig.json');
writeFileSync(tsconfig, JSON.stringify({
  compilerOptions: {
    target: 'es2022', module: 'commonjs', moduleResolution: 'node',
    skipLibCheck: true, esModuleInterop: true,
    baseUrl: resolve('.'), paths: { '@/*': ['src/*'] }, outDir: out,
  },
  // Same include set as the phone runner: with one input tsc flattens the output and the
  // require path changes underneath you. Several inputs keep the src tree shape.
  include: [
    resolve('src/services/callLog.service.ts'),
    resolve('src/services/recipients.service.ts'),
    resolve('src/lib/integrations/trestle.ts'),
  ],
}));
execSync(`npx tsc -p "${tsconfig}"`, { stdio: 'pipe' });
const req = createRequire(import.meta.url);
const origResolve = Module._resolveFilename;
Module._resolveFilename = function (r, ...rest) {
  if (r.startsWith('@/')) r = join(out, r.slice(2));
  return origResolve.call(this, r, ...rest);
};
const { realContact, normalisePhone } = req(join(out, 'lib/integrations/trestle.js'));
/**
 * The addresses the CARD attributes to each person, not the three slot columns.
 *
 * email1/email2/owner2Email are 134 addresses on C2; the cards actually carry 192 that the
 * trace attributed to one of these two people. Grading only the slots left 67 addresses a
 * campaign can reach with no verdict at all — the same gap the phone run had before it was
 * pointed at numbersOnCard.
 *
 * NOT emailsAll, which is 244 and includes prior residents of the property. Those are not
 * this household's to grade, and paying to learn that would be the Cifelli card again.
 */
const { insuredEmails, coInsuredEmails } = req(join(out, 'services/recipients.service.js'));

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

/**
 * A phone is a required parameter, so each email needs one to ride on.
 *
 * Any number already graded for that person will do — we are not asking about the phone, and
 * re-sending one simply refreshes a verdict we already hold. Preferring a number we have
 * seen before keeps the request inside data the provider has already matched.
 */
const graded = new Map();
for (const r of (await q(`SELECT "leadId","value","personRole" FROM "ContactVerification" WHERE "channel"='phone'`)).rows) {
  graded.set(`${r.leadId}|${r.personRole}`, r.value);
}

const name = (f, l) => [f, l].filter(Boolean).join(' ').trim();
const jobs = [];
for (const l of (LIMIT ? leads.slice(0, LIMIT) : leads)) {
  const insured = name(l.owner1FirstName, l.owner1LastName);
  const co = name(l.owner2FirstName, l.owner2LastName);
  const coIsReal = co && co.toLowerCase() !== insured.toLowerCase();
  const seen = new Set();
  const push = (email, role, who) => {
    const e = String(email ?? '').trim().toLowerCase();
    if (!e || !who || seen.has(`${e}|${role}`)) return;
    const phone = graded.get(`${l.id}|${role}`)
      ?? normalisePhone(role === 'insured' ? (l.phone1 ?? l.phone2) : l.owner2Phone);
    // Without a phone there is no way to ask, and inventing one would score the answer
    // against a number that is not this household's.
    if (!phone) return;
    seen.add(`${e}|${role}`);
    jobs.push({ lead: l, email: e, role, who, phone });
  };
  for (const e of insuredEmails(l)) push(e, 'insured', insured);
  if (coIsReal) for (const e of coInsuredEmails(l)) push(e, 'coInsured', co);
}

/**
 * Already-graded addresses are skipped.
 *
 * Re-asking costs money and tells us nothing new. Pass --recheck when the matcher has
 * changed and the stored verdicts need to move with it.
 */
const existing = new Set(
  (await q(`SELECT "leadId","value","personRole" FROM "ContactVerification" WHERE "channel"='email'`)).rows
    .map((r) => `${r.leadId}|${r.value}|${r.personRole}`),
);
const RECHECK = process.argv.includes('--recheck');
if (!RECHECK) {
  for (let i = jobs.length - 1; i >= 0; i--) {
    if (existing.has(`${jobs[i].lead.id}|${jobs[i].email}|${jobs[i].role}`)) jobs.splice(i, 1);
  }
}

console.log(APPLY ? 'APPLYING' : 'DRY RUN — nothing will be written');
console.log(`${COHORT} grade ${GRADE}: ${leads.length} leads → ${jobs.length} addresses to grade\n`);

const results = [];
let theirs = 0, notTheirs = 0, invalid = 0, errored = 0, stopped = false;
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
    : g.emailNameMatch === false ? 'NOT THEIRS'
      : g.emailIsValid === false ? 'invalid mailbox'
        : g.emailNameMatch === true ? 'theirs' : 'no answer from provider';
  if (verdict === 'theirs') theirs++;
  else if (verdict === 'NOT THEIRS') notTheirs++;
  else if (verdict === 'invalid mailbox') invalid++;

  results.push({
    propertyId: j.lead.propertyId, person: j.who, role: j.role, email: j.email, verdict,
    emailNameMatch: g?.emailNameMatch ?? null, emailIsValid: g?.emailIsValid ?? null, error: err,
  });
  if (i % 20 === 0 || verdict === 'NOT THEIRS') {
    console.log(`${String(i + 1).padStart(4)}/${jobs.length} ${verdict.padEnd(16)} ${j.email.padEnd(34)} ${j.who}`);
  }

  if (APPLY) {
    await q(
      `INSERT INTO "ContactVerification"
         ("id","leadId","channel","value","personRole","nameSent","nameMatch","isValid",
          "emailAgeScore","emailContactGrade","provider","checkedAt","error")
       VALUES ($1,$2,'email',$3,$4,$5,$6,$7,$8,$9,'trestle',$10,$11)
       ON CONFLICT ("leadId","value","personRole") DO UPDATE SET
         "nameSent" = EXCLUDED."nameSent", "nameMatch" = EXCLUDED."nameMatch",
         "isValid" = EXCLUDED."isValid", "emailAgeScore" = EXCLUDED."emailAgeScore",
         "emailContactGrade" = EXCLUDED."emailContactGrade",
         "checkedAt" = EXCLUDED."checkedAt", "error" = EXCLUDED."error"`,
      [randomUUID(), j.lead.id, j.email, j.role, j.who,
        g?.emailNameMatch ?? null, g?.emailIsValid ?? null,
        g?.emailAgeScore ?? null, g?.emailContactGrade ?? null,
        g ? new Date().toISOString() : null, err || null],
    );
  }
  await new Promise((r) => setTimeout(r, 220));
}

console.log(`\n── ${COHORT} grade ${GRADE}, email ──────────────────`);
console.log(`graded          : ${results.length} of ${jobs.length}${stopped ? '  (stopped on quota)' : ''}`);
console.log(`this person's   : ${theirs}`);
console.log(`NOT theirs      : ${notTheirs}`);
console.log(`invalid mailbox : ${invalid}`);
if (errored) console.log(`errored         : ${errored}`);

const path = `email-verify-${COHORT}-${GRADE}.csv`;
const cols = Object.keys(results[0] ?? { propertyId: '' });
const esc = (v) => `"${String(v ?? '').replace(/"/g, '""')}"`;
writeFileSync(path, [cols.join(','), ...results.map((r) => cols.map((c) => esc(r[c])).join(','))].join('\n'));
console.log(`\nPer-address detail → ${path}`);
console.log(APPLY ? 'Written to ContactVerification.' : 'DRY RUN — nothing written.');
await pool.end();
