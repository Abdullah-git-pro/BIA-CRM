import { NextRequest, NextResponse } from 'next/server';
import { getPipelineStatus } from '@/services/pipelineStatus.service';

/**
 * GET /api/admin/pipeline?grade=A&effFrom=&effTo=
 *
 * Where every cohort has got to across REAPI → WIIP → skip trace.
 *
 * Read-only, and there is deliberately no POST beside it. Running the roll over a cohort
 * leans on a small municipal service and running traces spends credits; the rule set on
 * 13 Oct is that neither happens without somebody asking for it. Making this endpoint
 * capable of starting work would put a "run everything" button one fetch away from a
 * screen whose whole purpose is to be looked at.
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
