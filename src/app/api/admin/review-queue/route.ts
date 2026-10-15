import { NextRequest, NextResponse } from 'next/server';
import { getReviewQueue } from '@/services/reviewQueue.service';

/**
 * GET /api/admin/review-queue?grade=A
 *
 * Everything in the pipeline waiting on a person, across C1–C8.
 *
 * Read-only. Nothing here decides anything — the decisions live on the lead card, where the
 * evidence and the existing override tools already are. A queue that could also resolve its
 * own rows would be a second place those rules exist.
 */
export const dynamic = 'force-dynamic';

export async function GET(request: NextRequest) {
  try {
    const grade = request.nextUrl.searchParams.get('grade') || 'A';
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
