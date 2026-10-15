import { NextRequest, NextResponse } from 'next/server';
import { getPipelineStatus } from '@/services/pipelineStatus.service';

/**
 * GET /api/admin/pipeline?grade=A&effFrom=&effTo=
 *
 * Where every cohort has got to across REAPI → WIIP → skip trace.
 *
 * Read-only. Starting work is ./run, which is a separate endpoint on purpose: it takes one
 * cohort and one stage at a time, it refuses the skip trace outright, and the contact check
 * will tell you what it would cost before it spends anything. Letting the screen's own read
 * also start things would put a "run everything" button one fetch away from the view whose
 * whole purpose is to be looked at.
 */
export const dynamic = 'force-dynamic';

export async function GET(request: NextRequest) {
  try {
    const grade = request.nextUrl.searchParams.get('grade') || 'A';
    const effFrom = request.nextUrl.searchParams.get('effFrom') || undefined;
    const effTo = request.nextUrl.searchParams.get('effTo') || undefined;
    const cohorts = await getPipelineStatus({ grade, effFrom, effTo });

    /** Book-level totals, so the page does not have to re-add the columns to show them. */
    const sum = (k: keyof (typeof cohorts)[number]) =>
      cohorts.reduce((t, c) => t + (Number(c[k]) || 0), 0);

    return NextResponse.json({
      success: true,
      grade,
      cohorts,
      totals: {
        total: sum('total'),
        rollChecked: sum('rollChecked'),
        rollNeedsReview: sum('rollNeedsReview'),
        coNeedsReview: sum('coNeedsReview'),
        traced: sum('traced'),
        tracedBeforeRoll: sum('tracedBeforeRoll'),
        contactsCards: sum('contactsCards'),
        contactsNotTheirs: sum('contactsNotTheirs'),
      },
    });
  } catch (err) {
    console.error('GET /api/admin/pipeline error:', err);
    return NextResponse.json(
      { success: false, error: err instanceof Error ? err.message : 'Could not read the pipeline' },
      { status: 500 },
    );
  }
}
