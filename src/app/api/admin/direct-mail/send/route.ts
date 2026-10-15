import { NextRequest, NextResponse } from 'next/server';
import { sql } from '@/lib/neon';
import { getSessionUser, actorLabel } from '@/lib/auth';
import { cohortMail, checkTemplate } from '@/services/directMail.service';
import { sendOne, attempted, failures } from '@/services/directMailSend.service';
import { liveEnabled, type LobMode } from '@/lib/integrations/lob';
import { numberedCohorts } from '@/services/cohort';
import { randomUUID } from 'crypto';

/**
 * Printing a batch.
 *
 *   POST /api/admin/direct-mail/send?...&dry=1   what it would do, and what it would cost
 *   POST /api/admin/direct-mail/send?...         one chunk of the batch
 *
 * ── This is the only endpoint in the CRM that cannot be undone ──────────────
 * Everything else here is correctable. A tax-roll verdict is re-run; a contact verdict is
 * re-graded for $0.035; an email sequence is stopped mid-flight. A letter is printed,
 * posted, and in somebody's hand — and it carries a named person's address and an estimated
 * premium, so a mistake is a disclosure rather than a wasted $1.06.
 *
 * Hence four locks, none of which is advisory:
 *
 *   1. dry=1 first. The caller is expected to show the count and the cost and get a yes.
 *   2. mode is explicit, and 'live' additionally needs LOB_LIVE_ENABLED in the environment.
 *   3. live refuses an unapproved template. Frank's compliance review is a precondition of
 *      printing, not a note beside it.
 *   4. MAX_BATCH caps a single run, so no bug and no held-down key can turn 50 into 993.
 *
 * ── Chunked, and the ledger is written before the vendor is called ──────────
 * A letter takes about a second end to end, so a cohort cannot finish inside a serverless
 * budget. The caller loops. sendOne writes its row first and updates it after, so a process
 * that dies mid-batch leaves a visible 'queued' row rather than a printed letter nobody
 * knows about.
 */
export const dynamic = 'force-dynamic';
export const maxDuration = 60;

const DEFAULT_CHUNK = 10;
const MAX_CHUNK = 25;
/**
 * The ceiling on one run.
 *
 * C2 is 50 and the largest week is 109, so this never obstructs real work — it exists so
 * that the worst case of a loop that fails to terminate is one cohort's worth of paper
 * rather than the book.
 */
const MAX_BATCH = 250;

export async function POST(req: NextRequest) {
  try {
    const p = req.nextUrl.searchParams;
    const cohort = (p.get('cohort') ?? '').trim();
    const templateId = (p.get('templateId') ?? '').trim();
    const dry = p.get('dry') === '1';
    const mode: LobMode = p.get('mode') === 'live' ? 'live' : 'test';
    const batchId = (p.get('batchId') ?? '').trim() || randomUUID();

    const chunkRaw = Number(p.get('chunk') ?? DEFAULT_CHUNK);
    const chunk = Math.min(Math.max(Number.isFinite(chunkRaw) ? chunkRaw : DEFAULT_CHUNK, 1), MAX_CHUNK);

    if (!numberedCohorts().includes(cohort)) {
      return NextResponse.json({ success: false, error: 'Pick one of the numbered weeks.' }, { status: 400 });
    }
    if (!templateId) {
      return NextResponse.json({ success: false, error: 'Pick a letter.' }, { status: 400 });
    }

    const [tpl] = await sql`
      SELECT * FROM "DirectMailTemplate" WHERE "id" = ${templateId}` as Array<Record<string, any>>;
    if (!tpl) {
      return NextResponse.json({ success: false, error: 'That letter no longer exists.' }, { status: 404 });
    }

    if (mode === 'live' && !liveEnabled()) {
      return NextResponse.json({
        success: false,
        error: 'Live mail is switched off. It needs LOB_LIVE_ENABLED set deliberately, and that should only happen after the letter has been through its compliance review.',
      }, { status: 400 });
    }
    /**
     * An unapproved letter cannot be posted, whatever the environment says.
     *
     * Editing the wording clears the approval, so "approved" always means approved as it
     * currently reads — not approved once, months ago, in a version nobody can see.
     */
    if (mode === 'live' && !tpl.approvedAt) {
      return NextResponse.json({
        success: false,
        error: 'This letter has not been reviewed for compliance. Nothing goes in the post until it has.',
      }, { status: 400 });
    }

    /**
     * The envelope needs a sender before anything is printed.
     *
     * Lob requires it and refuses the letter without it — "from.address_line1 is required",
     * one 422 per letter, discovered one at a time while a batch grinds through a cohort.
     * Four went that way before this check existed. It is knowable before the first letter,
     * so it is checked before the first letter, and the quote reports it rather than
     * letting somebody approve a run that cannot succeed.
     */
    const missingFrom = ['fromName', 'fromStreet', 'fromCity', 'fromState', 'fromZip']
      .filter((k) => !String(tpl[k] ?? '').trim());

    const { recipients, readiness } = await cohortMail(cohort, 'A');
    const done = await attempted(cohort, mode);
    const pending = recipients.filter((r) => !done.has(r.leadId));

    // Would every letter render completely? A gap in a sentence is permanent on paper.
    const check = checkTemplate(String(tpl.html ?? ''), pending);
    const blocked = check.unknown.length > 0 || check.missingFor.length > 0 || missingFrom.length > 0;

    const [cfg] = await sql`
      SELECT "value" FROM "AppConfig" WHERE "key" = 'cost_per_letter'` as Array<{ value: string }>;
    const unit = Number(cfg?.value ?? 0) || 0;

    if (dry) {
      return NextResponse.json({
        success: true, dry: true, cohort, mode, batchId,
        pending: pending.length,
        alreadySent: done.size,
        /**
         * Letters the vendor refused — almost always an address it will not accept, which
         * does not heal on a retry. Shown so somebody fixes the address rather than the
         * batch quietly re-offering the same household every run.
         */
        failures: await failures(cohort, mode),
        readiness,
        unitCost: unit,
        estimatedCost: Number((pending.length * unit).toFixed(2)),
        liveAvailable: liveEnabled(),
        approved: !!tpl.approvedAt,
        check,
        blocked,
        missingFrom,
        overCap: pending.length > MAX_BATCH,
        maxBatch: MAX_BATCH,
      });
    }

    if (missingFrom.length) {
      return NextResponse.json({
        success: false,
        error: 'This letter has no return address, and the printer will refuse every one of them. Fill it in first.',
        missingFrom,
      }, { status: 400 });
    }
    if (blocked) {
      return NextResponse.json({
        success: false,
        error: 'Some of these letters would print with a gap in them. Fix the letter first.',
        check,
      }, { status: 400 });
    }
    if (pending.length > MAX_BATCH) {
      return NextResponse.json({
        success: false,
        error: `${pending.length} is more than one run may print (${MAX_BATCH}). Split it.`,
      }, { status: 400 });
    }
    if (!pending.length) {
      return NextResponse.json({
        success: true, cohort, mode, batchId, processed: 0, remaining: 0, done: true, results: [],
      });
    }

    const user = await getSessionUser(req);
    const by = actorLabel(user);

    const batch = pending.slice(0, chunk);
    const results = [];
    for (const recipient of batch) {
      results.push(await sendOne({
        mode, cohort, batchId, recipient, by,
        template: {
          id: String(tpl.id), html: String(tpl.html ?? ''),
          color: !!tpl.color, doubleSided: tpl.doubleSided !== false, size: String(tpl.size ?? 'us_letter'),
          fromName: tpl.fromName, fromStreet: tpl.fromStreet,
          fromCity: tpl.fromCity, fromState: tpl.fromState, fromZip: tpl.fromZip,
        },
      }));
    }

    const sent = results.filter((r) => r.status === 'sent').length;
    const failed = results.filter((r) => r.status === 'failed').length;

    return NextResponse.json({
      success: true, cohort, mode, batchId,
      processed: results.length,
      sent,
      failed,
      // What is left AFTER this chunk, so the caller can stop without another request.
      remaining: Math.max(0, pending.length - results.length),
      done: pending.length - results.length <= 0,
      results,
    });
  } catch (err) {
    console.error('POST /api/admin/direct-mail/send error:', err);
    return NextResponse.json(
      { success: false, error: err instanceof Error ? err.message : 'The run failed' },
      { status: 500 },
    );
  }
}
