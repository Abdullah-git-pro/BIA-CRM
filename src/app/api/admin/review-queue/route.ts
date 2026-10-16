import { NextRequest, NextResponse } from 'next/server';
import { getReviewQueue, getDecided } from '@/services/reviewQueue.service';

/**
 * GET /api/admin/review-queue?grade=A
 * GET /api/admin/review-queue?grade=A&view=decided
 *
 * Everything in the pipeline waiting on a person, across C1–C8 — and, under view=decided,
 * everything a person has already settled.
 *
 * The two are separate requests rather than one payload because the queue is opened many
 * times a day and the decision history is read occasionally; making every queue load pay for
 * a second full-book scan would slow the screen people actually live in.
 */
export const dynamic = 'force-dynamic';

export async function GET(request: NextRequest) {
  try {
    const grade = request.nextUrl.searchParams.get('grade') || 'A';
    if (request.nextUrl.searchParams.get('view') === 'decided') {
      const data = await getDecided({ grade });
      return NextResponse.json({ success: true, ...data, total: data.items.length });
    }
    const data = await getReviewQueue({ grade });
    return NextResponse.json({ success: true, ...data, total: data.items.length });
  } catch (err) {
    console.error('GET /api/admin/review-queue error:', err);
    return NextResponse.json(
      { success: false, error: err instanceof Error ? err.message : 'Could not build the queue' },
      { status: 500 },
    );
  }
}
