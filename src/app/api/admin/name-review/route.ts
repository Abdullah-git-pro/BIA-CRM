import { NextRequest, NextResponse } from 'next/server';
import { getSessionUser, actorLabel } from '@/lib/auth';
import { getReviewList, decideReview, reviewSummary } from '@/services/emailNameReview.service';

/**
 * The surname review queue (Frank, 24 Sep 2026 · second email §7).
 *
 *   GET  /api/admin/name-review                 the open queue + counts
 *   GET  /api/admin/name-review?all=1           decided rows as well
 *   POST /api/admin/name-review  { ids, decision, note }
 *
 * Admin/superadmin only (enforced by middleware on /api/admin).
 *
 * ── Why a decision needs a name against it ──────────────────────────────────
 * "Failures go to a review list, not into a send." What releases an address is a person
 * saying it belongs to the insured, so the row records who said it. An approval with no
 * name on it is indistinguishable from the silent release the rule exists to prevent — and
 * if an address turns out to have been a stranger's, the question afterwards is always who
 * cleared it and on what basis.
 *
 * The actor comes from the session, never from the request body.
 */
export const dynamic = 'force-dynamic';

export async function GET(request: NextRequest) {
  try {
    /**
     * Three views, not two: what is left, what has been settled, and everything.
     *
     * `all=1` had been doing double duty as "show decided", so a button reading "Showing
     * decided" returned the settled rows and all 655 outstanding ones together.
     */
    const view = request.nextUrl.searchParams.get('view') ?? 'open';
    const cohort = request.nextUrl.searchParams.get('cohort');
    const grade = request.nextUrl.searchParams.get('grade');
    /** The lead card asks about one household; it has no use for the whole queue. */
    const leadId = request.nextUrl.searchParams.get('leadId');
    const [rows, summary] = await Promise.all([
      getReviewList({
        openOnly: view === 'open',
        decidedOnly: view === 'decided',
        cohortFrom: cohort || undefined,
        cohortTo: cohort || undefined,
        grade: grade || undefined,
        leadId: leadId || undefined,
        limit: leadId ? 50 : 2000,
      }),
      // Scoped the same way the list is, so the week picker cannot disagree with the
      // headline beside it.
      reviewSummary({ grade: grade || undefined }),
    ]);
    return NextResponse.json({ success: true, rows, summary, view });
  } catch (err) {
    return NextResponse.json(
      { success: false, error: err instanceof Error ? err.message : 'Could not load the queue' },
      { status: 500 },
    );
  }
}

export async function POST(request: NextRequest) {
  try {
    const user = await getSessionUser(request);
    const who = actorLabel(user);
    /**
     * No session, no decision. This is the one write on the screen and it is what puts an
     * address back into a send, so it does not happen anonymously.
     */
    if (!who) {
      return NextResponse.json(
        { success: false, error: 'Sign in again before deciding — a decision is recorded against your name.' },
        { status: 401 },
      );
    }

    const body = await request.json().catch(() => ({}));
    const ids: string[] = Array.isArray(body?.ids) ? body.ids.map(String).filter(Boolean) : [];
    const decision = body?.decision === 'approved' ? 'approved'
      : body?.decision === 'rejected' ? 'rejected' : null;
    const note = typeof body?.note === 'string' && body.note.trim() ? body.note.trim() : null;

    if (!ids.length) {
      return NextResponse.json({ success: false, error: 'Nothing selected.' }, { status: 400 });
    }
    if (!decision) {
      return NextResponse.json({ success: false, error: 'Pick approve or reject.' }, { status: 400 });
    }

    /**
     * decideReview only touches rows with no decision yet, so a double submit — two tabs, a
     * slow connection, a second click — settles as one decision rather than overwriting the
     * first person's with the second's. `decided` is what actually changed, not what was asked.
     */
    const decided = await decideReview(ids, { decision, decidedBy: who, note });
    const summary = await reviewSummary();
    return NextResponse.json({ success: true, decided, asked: ids.length, summary });
  } catch (err) {
    return NextResponse.json(
      { success: false, error: err instanceof Error ? err.message : 'Could not record that' },
      { status: 500 },
    );
  }
}
