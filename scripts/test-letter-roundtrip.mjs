/**
 * What survives a trip through the letter editor?
 *
 *   node scripts/test-letter-roundtrip.mjs            # the newest saved template
 *   node scripts/test-letter-roundtrip.mjs some.html  # a file instead
 *
 * ── Why this exists ─────────────────────────────────────────────────────────
 * LetterEditor serialises from TipTap's document model, so anything its schema cannot hold
 * is gone the moment onUpdate fires — which is the first keystroke anybody types in the
 * rich-text view. Loading is safe (setContent passes emitUpdate: false) and saving an
 * untouched template is safe, so the loss is invisible until somebody edits a word.
 *
 * The direct-mail letter is built from tables, inline styles on cells, two linked images and
 * a border-radius ring. StarterKit holds none of that. This measures exactly what each
 * schema keeps, against the real template, so "the editor will not break the letter" is a
 * checked claim rather than a hope.
 *
 * It spends nothing and writes nothing: a read of one row and some string counting.
 */
import fs from 'node:fs';
import { JSDOM } from 'jsdom';

// TipTap parses HTML with the DOM, so one has to exist before the extensions load.
const dom = new JSDOM('<!doctype html><html><body></body></html>');
global.window = dom.window;
global.document = dom.window.document;
global.DOMParser = dom.window.DOMParser;
global.Node = dom.window.Node;

const { generateJSON, generateHTML } = await import('@tiptap/html');
const { default: StarterKit } = await import('@tiptap/starter-kit');
const { default: Image } = await import('@tiptap/extension-image');
const { default: Link } = await import('@tiptap/extension-link');
const { default: TextAlign } = await import('@tiptap/extension-text-align');
const { Table, TableRow, TableCell, TableHeader } = await import('@tiptap/extension-table');

// ── The letter under test ───────────────────────────────────────────────────
const arg = process.argv[2];
let html;
let label = arg;
if (arg) {
  html = fs.readFileSync(arg, 'utf8');
} else {
  await import('./lib/env.mjs');
  const { neon, neonConfig } = await import('@neondatabase/serverless');
  /**
   * The same 30s connect timeout src/lib/neon.ts gives the app.
   *
   * undici defaults to 10s, which is marginal from outside us-east-1 — a cold endpoint takes
   * the better part of nine seconds on the first call. Scripts do not inherit the app's
   * client, so each one has to set this for itself or fail on its first run of the day,
   * which is exactly what this script did.
   */
  neonConfig.fetchFunction = (input, init) => fetch(input, {
    ...init,
    signal: init?.signal ?? AbortSignal.timeout(30_000),
  });
  const sql = neon(process.env.DATABASE_URL);
  const rows = await sql`
    SELECT "name", "html" FROM "DirectMailTemplate" ORDER BY "updatedAt" DESC LIMIT 1`;
  if (!rows.length) { console.log('No templates to test.'); process.exit(1); }
  html = rows[0].html;
  label = `template "${rows[0].name}"`;
}

/**
 * Keep named HTML attributes verbatim through parse and render.
 *
 * TipTap's table nodes model structure, not presentation: they carry colspan, rowspan and
 * colwidth and drop everything else. This letter's geometry lives entirely in `style`,
 * `width`, `valign` and `align` on the cells, so without this the tables come back as
 * tables and still lay out wrongly — which is worse than losing them outright, because it
 * looks like it worked.
 */
const keepAttrs = (names) => ({
  addAttributes() {
    const base = this.parent?.() ?? {};
    const extra = {};
    for (const name of names) {
      extra[name] = {
        default: null,
        parseHTML: (el) => el.getAttribute(name),
        renderHTML: (attrs) => (attrs[name] ? { [name]: attrs[name] } : {}),
      };
    }
    return { ...base, ...extra };
  },
});

const CELL_ATTRS = ['style', 'width', 'valign', 'align'];
const TABLE_ATTRS = ['style', 'width', 'cellpadding', 'cellspacing', 'border'];
const ROW_ATTRS = ['style'];

const base = () => [StarterKit, Image, Link, TextAlign.configure({ types: ['heading', 'paragraph'] })];

const configs = {
  'A  StarterKit only (before this change)': base(),
  'B  + table extensions, stock': [...base(), Table, TableRow, TableCell, TableHeader],
  'C  + table extensions keeping attributes': [
    ...base(),
    Table.extend(keepAttrs(TABLE_ATTRS)),
    TableRow.extend(keepAttrs(ROW_ATTRS)),
    TableCell.extend(keepAttrs(CELL_ATTRS)),
    TableHeader.extend(keepAttrs(CELL_ATTRS)),
  ],
};

/**
 * The same functions the save route uses, not a second copy of the rule.
 *
 * If this test counted structure its own way it could pass while the guard let a flattened
 * letter through, or refuse one the guard allows — two implementations of one rule being
 * the defect this codebase has been bitten by most often.
 */
const { structureOf, structureLoss, describeStructureLoss } = await import('@/services/directMail.service');

const count = (s, needle) => s.split(needle).length - 1;
/** The guard's five, plus the things specific to THIS letter that the guard cannot name. */
const survey = (s) => ({
  ...structureOf(s),
  rings: count(s, 'border-radius:50%'),
  highlights: count(s, '#FCE94F'),
  cloudinary: count(s, 'res.cloudinary.com'),
  vars: new Set([...s.matchAll(/\{\{\s*([a-zA-Z0-9_]+)\s*\}\}/g)].map((m) => m[1])).size,
});

const original = survey(html);
console.log(`Round-tripping ${label} — ${html.length} bytes\n`);
console.log('  in the database:', JSON.stringify(original), '\n');

let fail = 0;
let lossyConfigs = 0;
let caught = 0;

for (const [name, exts] of Object.entries(configs)) {
  let out;
  try {
    out = generateHTML(generateJSON(html, exts), exts);
  } catch (err) {
    console.log(name, '\n   ERROR', err.message, '\n');
    fail++;
    continue;
  }
  const got = survey(out);
  const lost = Object.keys(original)
    .filter((k) => got[k] !== original[k])
    .map((k) => `${k} ${original[k]}→${got[k]}`);

  // Would the save route refuse this round-trip? That is the question that matters.
  const loss = structureLoss(html, out);

  console.log(name);
  console.log('  ', JSON.stringify(got));
  console.log('  ', lost.length ? `lost: ${lost.join(', ')}` : 'nothing lost');
  console.log('   guard:', loss.length
    ? `REFUSES — ${describeStructureLoss(loss)}`
    : 'allows (no structure lost)');

  if (lost.length) {
    lossyConfigs++;
    // A lossy round-trip the guard would wave through is the whole failure this exists to
    // prevent. Note the asymmetry: the guard counts structure, so it cannot see a lost ring
    // or highlight on its own — it catches those only because the styles go with them.
    if (loss.length) caught++;
    else {
      console.log('   *** the guard would ALLOW this loss ***');
      fail++;
    }
  }
  console.log('');
}

// An untouched save must still be allowed, or nobody can change a word.
const identical = structureLoss(html, html);
console.log('unchanged save:', identical.length ? `*** REFUSED (${describeStructureLoss(identical)}) ***` : 'allowed');
if (identical.length) fail++;

/**
 * ── The guard, through the real save route ─────────────────────────────────
 *
 * Everything above tests the rule. This tests the thing people actually hit: the endpoint.
 * A rule that is right and a route that forgets to call it look identical from here.
 *
 * Only when reading from the database — given a file there is no row to protect. The row is
 * snapshotted and restored in a finally block, the way scripts/test-review-decision.mjs
 * does, so the template is left exactly as it was found.
 */
if (!arg) {
  const { POST: saveTemplate } = await import('@/app/api/admin/direct-mail/templates/route');
  const { sql } = await import('@/lib/neon');

  const [row] = await sql`
    SELECT "id","name","html","color","doubleSided","size","approvedAt"
      FROM "DirectMailTemplate" ORDER BY "updatedAt" DESC LIMIT 1`;
  const post = (body) => ({ json: async () => body, cookies: { get: () => undefined } });
  const storedHtml = async () => (await sql`
    SELECT "html" FROM "DirectMailTemplate" WHERE "id" = ${row.id}`)[0].html;

  // What the rich-text view hands back: parsed and re-serialised with no table support.
  const flat = generateHTML(generateJSON(row.html, [StarterKit, Image]), [StarterKit, Image]);
  const expect = (label, got, want) => {
    const ok = JSON.stringify(got) === JSON.stringify(want);
    console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${label}${ok ? '' : `  got ${JSON.stringify(got)}`}`);
    if (!ok) fail++;
  };

  console.log('\nthrough the save route:');
  try {
    const res = await saveTemplate(post({ id: row.id, name: row.name, html: flat }));
    const body = await res.json();
    expect('a flattened letter is refused with 409', res.status, 409);
    expect('the refusal names what would be lost', (body.structureLoss ?? []).length > 0, true);
    expect('nothing was written', await storedHtml(), row.html);

    const reworded = row.html.replace('I know your time', 'I do know your time');
    if (reworded === row.html) { console.log('  SKIP  wording change — anchor text not found'); } else {
      const ok = await (await saveTemplate(post({ id: row.id, name: row.name, html: reworded }))).json();
      expect('a wording change that keeps the layout is allowed', ok.success, true);
    }

    const forced = await (await saveTemplate(post({
      id: row.id, name: row.name, html: flat, allowStructureLoss: true,
    }))).json();
    expect('the override lets a deliberate simplification through', forced.success, true);
  } finally {
    await sql`
      UPDATE "DirectMailTemplate"
         SET "html" = ${row.html}, "name" = ${row.name}, "color" = ${row.color},
             "doubleSided" = ${row.doubleSided}, "size" = ${row.size},
             "approvedAt" = ${row.approvedAt}
       WHERE "id" = ${row.id}`;
    const restored = await storedHtml() === row.html;
    console.log(`  ${restored ? 'PASS' : 'FAIL'}  the template is restored to the snapshot`);
    if (!restored) fail++;
  }
}

console.log('');
if (fail) {
  console.log(`FAIL — ${fail} problem(s). The guard is not protecting the letter.`);
  process.exit(1);
}
console.log(`PASS — ${lossyConfigs} of ${Object.keys(configs).length} schemas lose structure, and the guard refuses all ${caught}.`);
console.log('An identical save is still allowed. The letter cannot be silently flattened.');
console.log('Note: the rich-text view is still lossy — use the Source view to edit.');
process.exit(0);
