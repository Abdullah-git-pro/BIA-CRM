import { NextRequest, NextResponse } from 'next/server';
import { getPipelineCohortLeads } from '@/services/pipelineCohort.service';

/**
 * GET /api/admin/pipeline/{cohort}?grade=A
 *
 * The leads behind one row of the pipeline screen — which are confirmed, which need a
 * person, which the roll does not hold.
 *
 * Read-only like its parent: nothing here starts a roll lookup or a trace.
 */
export const dynamic = 'force-dynamic';

export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ cohort: string }> },
) {
  try {
    const { cohort } = await params;
    // A cohort is the Monday of a renewal week. Anything else is a typed URL, not a week.
    if (!/^\d{4}-\d{2}-\d{2}$/.test(cohort)) {
      return NextResponse.json({ success: false, error: 'Not a renewal week' }, { status: 400 });
    }
    const grade = request.nextUrl.searchParams.get('grade') || 'A';
    const data = await getPipelineCohortLeads({ cohort, grade });

    const counts = {
      total: data.leads.length,
      confirmed: data.leads.filter((l) => l.bucket === 'confirmed').length,
      review: data.leads.filter((l) => l.bucket === 'review').length,
      notOnRoll: data.leads.filter((l) => l.bucket === 'not_on_roll').length,
      notChecked: data.leads.filter((l) => l.bucket === 'not_checked').length,
      tracedBeforeRoll: data.leads.filter((l) => l.tracedBeforeRoll).length,
    };

    return NextResponse.json({ success: true, ...data, counts });
  } catch (err) {
    console.error('GET /api/admin/pipeline/[cohort] error:', err);
    return NextResponse.json(
      { success: false, error: err instanceof Error ? err.message : 'Could not read the cohort' },
      { status: 500 },
    );
  }
}
