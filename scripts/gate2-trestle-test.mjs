/**
 * Gate 2/3 validation: does Trestle agree with calls we have already made?
 *
 *   node scripts/gate2-trestle-test.mjs --limit=5      (smoke test)
 *   node scripts/gate2-trestle-test.mjs                (the full set)
 *
 * ── Why this test and not a pilot ───────────────────────────────────────────
 * Frank's SOP puts an identity check (Gate 2) and a liveness check (Gate 3) in front of
 * the dialler. Both are worth paying for only if they would have stopped the calls that
 * wasted time, and we are in the rare position of already knowing which ones those were:
 * 158 numbers rang dead, 49 were answered by somebody who was not our policyholder, and
 * 14 reached the right person. That is ground truth, so Trestle can be scored rather than
 * trusted.
 *
 * Trestle returns both gates from one call — `phone.name_match` is Gate 2 and
 * `phone.activity_score` is the 0-100 figure Frank's "70 or higher" refers to.
 *
 * The name sent is the person we MEANT to reach on that attempt, taken from the call
 * record's role, not whoever happened to pick up. Sending the wrong side would score the
 * API against a question we never asked it.
 */
import { readFileSync, existsSync, writeFileSync } from 'fs';

for (const f of ['.env', '.env.local']) {
  if (!existsSync(f)) continue;
  for (const line of readFileSync(f, 'utf8').split(/\r?\n/)) {
    const m = line.match(/^\s*([A-Za-z0-9_]+)\s*=\s*(.*)$/);
    if (m) process.env[m[1].trim()] ??= m[2].trim().replace(/^["']|["']$/g, '');
  }
}
const KEY = process.env.TRESTLE_API_KEY;
if (!KEY) throw new Error('TRESTLE_API_KEY is not set in .env.local');
const LIMIT = Number((process.argv.find((a) => a.startsWith('--limit=')) ?? '').slice(8)) || null;

function parseCsv(t) {
  const rows = []; let row = [], cur = '', q = false;
  for (let i = 0; i < t.length; i++) {
    const c = t[i];
    if (q) { if (c === '"') { if (t[i + 1] === '"') { cur += '"'; i++; } else q = false; } else cur += c; }
    else if (c === '"') q = true;
    else if (c === ',') { row.push(cur); cur = ''; }
    else if (c === '\n') { row.push(cur); rows.push(row); row = []; cur = ''; }
    else if (c !== '\r') cur += c;
  }
  if (cur || row.length) { row.push(cur); rows.push(row); }
  return rows;
}
const csvRows = parseCsv(readFileSync('gate2-trestle-test-set.csv', 'utf8'));
const head = csvRows[0];
const all = csvRows.slice(1).filter((r) => r.length > 3)
  .map((r) => Object.fromEntries(head.map((h, i) => [h, r[i]])));
/**
 * Decisive cases first, because the quota runs out before the file does.
 *
 * The first run spent its whole allocation on numbers that rang dead — the least
 * informative group, since a disconnected number can still be correctly attributed to the
 * person who used to hold it. The question Gate 2 exists to answer is whether `name_match`
 * catches the calls a STRANGER answered, and those sat at the bottom of the file.
 *
 * So the two groups with a human on the line are checked first, and the dead numbers last.
 */
const PRIORITY = { 'wrong person answered': 0, 'right person': 1, dead: 2 };
const ordered = [...all].sort((a, b) =>
  (PRIORITY[a.groundTruth] ?? 9) - (PRIORITY[b.groundTruth] ?? 9));
const rows = LIMIT ? ordered.slice(0, LIMIT) : ordered;

console.log(`${rows.length} numbers to check against Trestle\n`);

const out = [];
let n = 0;
for (const r of rows) {
  n++;
  // Who we were TRYING to reach on that attempt — the call record says which.
  const co = String(r.weDialledAs ?? '').includes('co');
  const first = co ? r.coInsuredFirst : r.insuredFirst;
  const last = co ? r.coInsuredLast : r.insuredLast;
  const name = [first, last].filter(Boolean).join(' ').trim();
  if (!name || !r.phone) continue;

  const qs = new URLSearchParams({
    name,
    phone: String(r.phone).replace(/\D/g, ''),
    'address.street_line_1': r.addressStreet ?? '',
    'address.city': r.addressCity ?? '',
    'address.state_code': 'NJ',
    'address.postal_code': r.addressZip ?? '',
    'address.country_code': 'US',
  });

  let j = null, err = '';
  try {
    const res = await fetch(`https://api.trestleiq.com/2.0/real_contact?${qs}`, {
      headers: { 'x-api-key': KEY, Accept: 'application/json' },
      signal: AbortSignal.timeout(20000),
    });
    const text = await res.text();
    if (!res.ok) err = `HTTP ${res.status}: ${text.slice(0, 180)}`;
    else j = JSON.parse(text);
  } catch (e) { err = String(e?.message ?? e); }

  const ph = j?.phone ?? {};
  const rec = {
    phone: r.phone, groundTruth: r.groundTruth, dialledAs: r.weDialledAs, nameSent: name,
    nameMatch: ph.name_match ?? null,
    isValid: ph.is_valid ?? null,
    activityScore: ph.activity_score ?? null,
    contactGrade: ph.contact_grade ?? null,
    lineType: ph.line_type ?? null,
    error: err,
  };
  out.push(rec);
  console.log(
    `${String(n).padStart(4)}/${rows.length} ${String(r.groundTruth).padEnd(22)} `
    + (err ? `ERROR ${err}` :
      `name_match=${String(ph.name_match).padEnd(5)} valid=${String(ph.is_valid).padEnd(5)} `
      + `activity=${String(ph.activity_score ?? '—').padStart(3)} grade=${ph.contact_grade ?? '—'} ${ph.line_type ?? ''}`),
  );
  await new Promise((r2) => setTimeout(r2, 250));
}

// ── Score it ────────────────────────────────────────────────────────────────
const ok = out.filter((r) => !r.error);
const group = (truth) => ok.filter((r) => r.groundTruth === truth);
const pct = (a, b) => (b ? `${((a / b) * 100).toFixed(0)}%` : '—');

console.log(`\n── Scored against calls we already made ─────────────`);
for (const truth of ['right person', 'wrong person answered', 'dead']) {
  const g = group(truth);
  if (!g.length) continue;
  const nm = g.filter((r) => r.nameMatch === true).length;
  const valid = g.filter((r) => r.isValid === true).length;
  const scored = g.filter((r) => typeof r.activityScore === 'number');
  const avg = scored.length ? Math.round(scored.reduce((t, r) => t + r.activityScore, 0) / scored.length) : null;
  const over70 = scored.filter((r) => r.activityScore >= 70).length;
  console.log(`\n${truth}  (${g.length})`);
  console.log(`   name_match true   : ${nm} (${pct(nm, g.length)})`);
  console.log(`   is_valid true     : ${valid} (${pct(valid, g.length)})`);
  console.log(`   activity >= 70    : ${over70} (${pct(over70, scored.length)})   average ${avg ?? '—'}`);
}
const errs = out.filter((r) => r.error).length;
if (errs) console.log(`\n${errs} lookups errored`);

const path = 'gate2-trestle-results.csv';
const cols = Object.keys(out[0] ?? { phone: '' });
const esc = (v) => `"${String(v ?? '').replace(/"/g, '""')}"`;
writeFileSync(path, [cols.join(','), ...out.map((r) => cols.map((c) => esc(r[c])).join(','))].join('\n'));
console.log(`\nPer-number detail → ${path}`);
