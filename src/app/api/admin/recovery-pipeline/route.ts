import { NextRequest, NextResponse } from 'next/server';
import {
  stageCounts, leadsAtStage, runTracerfyBlast, runBatchDataBlast,
  type RecoveryStage,
} from '@/services/recoveryPipeline.service';
import { getProcessRuns, stalledRuns } from '@/services/processRun.service';

const STAGES: RecoveryStage[] = ['isolated', 'tracerfy', 'batchdata', 'recovered'];

/**
 * GET  /api/admin/recovery-pipeline?effFrom&effTo[&stage]
 *        counts for all four stages, plus the rows of one stage when asked
 * POST /api/admin/recovery-pipeline
 *        body: { vendor: 'tracerfy'|'batchdata', effFrom?, effTo?, limit?, dryRun? }
 *
 * Admin/superadmin only (enforced by middleware on /api/admin).
 * dryRun defaults TRUE — both vendors cost money per call.
 */
export async function GET(request: NextRequest) {
  try {
    const q = request.nextUrl.searchParams;
    const effFrom = q.get('effFrom') || undefined;
    const effTo = q.get('effTo') || undefined;
    const stage = q.get('stage') as RecoveryStage | null;

    /**
     * Which grade's pipeline. Anything but 'B' means 'A', so a malformed value returns the
     * population this endpoint has always returned rather than an empty screen.
     */
    const grade = q.get('grade') === 'B' ? 'B' : 'A';

    const counts = await stageCounts(effFrom, effTo, grade);
    const rows = stage && STAGES.includes(stage)
      ? await leadsAtStage(stage, effFrom, effTo, grade)
      : [];
    /**
     * The run history travels with the counts (Frank, fix 20).
     *
     * On the same payload rather than its own endpoint because it answers the question the
     * counts provoke. A stage showing 45 waiting means one thing if nothing has ever been
     * run against that week and something else entirely if three runs have found nothing —
     * and the counts alone cannot tell those apart.
     */
    const runs = await getProcessRuns({ from: effFrom, to: effTo, limit: 50 });
    const stalled = await stalledRuns();
    return NextResponse.json({
      // `grade` is echoed back so the screen can prove which pipeline it is drawing. Two
      // populations with identical stage names and a toggle between them is exactly the
      // shape where a stale response gets read as the other one.
      success: true, grade, counts, stage, count: rows.length, data: rows, runs, stalled,
    });
  } catch (error) {
    console.error('GET /api/admin/recovery-pipeline error:', error);
    return NextResponse.json({ success: false, error: 'Failed to read the pipeline' }, { status: 500 });
  }
}

export async function POST(request: NextRequest) {
  try {
    const body = await request.json().catch(() => ({} as any));
    const vendor = body?.vendor;
    if (vendor !== 'tracerfy' && vendor !== 'batchdata') {
      return NextResponse.json({ success: false, error: 'vendor must be tracerfy or batchdata' }, { status: 400 });
    }
    /*
     * The grade decides which pipeline runs, and it has to be carried here.
     *
     * The GET above already takes one. This did not, so a run launched from the Grade B
     * tab blasted the Grade A stage — empty — and reported "tried 0". The counts returned
     * afterwards were Grade A's too, so the screen redrew with the wrong pipeline's
     * numbers on top of it.
     */
    const grade: 'A' | 'B' = body?.grade === 'B' ? 'B' : 'A';
    const opts = {
      effFrom: body?.effFrom || undefined,
      effTo: body?.effTo || undefined,
      limit: Math.min(Math.max(Number(body?.limit) || 25, 1), 200),
      dryRun: body?.dryRun !== false,
      createdBy: body?._createdBy ?? null,
      grade,
    };
    const result = vendor === 'tracerfy'
      ? await runTracerfyBlast(opts)
      : await runBatchDataBlast(opts);
    const counts = await stageCounts(opts.effFrom, opts.effTo, grade);
    return NextResponse.json({ success: true, grade, ...result, counts });
  } catch (error: any) {
    console.error('POST /api/admin/recovery-pipeline error:', error);
    return NextResponse.json(
      { success: false, error: error?.message || 'Blast failed' },
      { status: 500 },
    );
  }
}
