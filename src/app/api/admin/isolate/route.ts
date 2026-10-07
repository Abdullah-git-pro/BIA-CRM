import { NextRequest, NextResponse } from 'next/server';
import { isolateUnreachable } from '@/services/isolate.service';

/**
 * POST /api/admin/isolate
 *   body: { effFrom?, effTo?, dryRun?, grade? }
 *
 * Parks leads with no insured email as 'isolated', keeping the status they held so it can
 * be restored, and puts back any isolated lead that has since become reachable.
 * Admin/superadmin only (enforced by middleware on /api/admin).
 *
 * dryRun defaults TRUE — this changes producer-visible status on leads that are mostly
 * already rated, and that is not something to do merely because a request arrived.
 *
 * ── grade is explicit, and an unknown one is refused ─────────────────────────
 * This handled Grade A only, silently: the service hard-coded it and the route never
 * asked. The recovery pipeline then grew a Grade B tab whose Isolate button posted here,
 * so it isolated the Grade A leads in range — none — and reported success having done
 * nothing. A bad value is rejected rather than defaulted, because defaulting is exactly
 * what made the Grade B button look like it worked.
 */
const GRADES = ['A', 'B'] as const;

export async function POST(request: NextRequest) {
  try {
    const body = await request.json().catch(() => ({} as any));
    const grade = body?.grade ?? 'A';
    if (!GRADES.includes(grade)) {
      return NextResponse.json(
        { success: false, error: `grade must be one of ${GRADES.join(', ')} — got "${grade}"` },
        { status: 400 },
      );
    }
    const result = await isolateUnreachable({
      effFrom: body?.effFrom || undefined,
      effTo: body?.effTo || undefined,
      dryRun: body?.dryRun !== false,
      createdBy: body?._createdBy ?? null,
      grade,
    });
    return NextResponse.json({ success: true, ...result });
  } catch (error: any) {
    console.error('POST /api/admin/isolate error:', error);
    return NextResponse.json(
      { success: false, error: error?.message || 'Isolate failed' },
      { status: 500 },
    );
  }
}
