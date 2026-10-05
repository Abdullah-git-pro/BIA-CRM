import { NextRequest, NextResponse } from 'next/server';
import { getQcReport, QcReportType } from '@/services/reports.service';

/**
 * The allowlist, written as a Record so TypeScript enforces it.
 *
 * It used to be a hand-maintained array of the same strings as QcReportType. Adding a
 * report to the type therefore compiled cleanly and then failed at runtime with "Invalid
 * report type" — the report appeared in the picker, returned nothing, and the only clue
 * was a red banner that named no report.
 *
 * `Record<QcReportType, true>` makes a missing key a COMPILE error, so the next report
 * cannot be half-added. The keys are the allowlist; the values carry no meaning.
 */
const VALID_REPORTS: Record<QcReportType, true> = {
  recapture_log: true,
  co_insured_verify: true,
  coinsured_contact_mix: true,
  already_ours: true,
  referral: true,
  grade_overrides: true,
  keyword: true,
  roof_b: true,
  type_mismatch: true,
  owner_verify: true,
  contact_coverage: true,
  skiptrace_mismatch: true,
  blast_skiptrace: true,
  cohort: true,
  reachability: true,
  call_outcome: true,
  emails_insured: true,
  emails_all: true,
};
const VALID = Object.keys(VALID_REPORTS) as QcReportType[];

/**
 * GET /api/admin/reports?report=referral|grade_overrides|keyword|roof_b
 *   referral       → &carrier=travelers|plymouth|any &value=review|ineligible|eligible
 *   keyword        → &q=<term>
 *   all            → optional &effFrom=YYYY-MM-DD &effTo=YYYY-MM-DD
 * Admin/superadmin only (enforced by middleware on /api/admin).
 */
export async function GET(request: NextRequest) {
  try {
    const p = request.nextUrl.searchParams;
    const report = p.get('report') as QcReportType | null;
    if (!report || !VALID.includes(report)) {
      return NextResponse.json({ success: false, error: 'Invalid report type' }, { status: 400 });
    }
    const rows = await getQcReport(report, {
      carrier: (p.get('carrier') as any) || 'any',
      value: (p.get('value') as any) || 'review',
      setBy: (p.get('setBy') as any) || 'any',
      q: p.get('q') || '',
      effFrom: p.get('effFrom') || undefined,
      effTo: p.get('effTo') || undefined,
      // Grade-B roof report: the age band of the HOUSE, not of the roof.
      ageMin: p.get('ageMin') ? Number(p.get('ageMin')) : undefined,
      ageMax: p.get('ageMax') ? Number(p.get('ageMax')) : undefined,
      // Anything but 'B' means 'A', so a malformed value can never widen a file — it can
      // only return the population that was already the default.
      grade: p.get('grade') === 'B' ? 'B' : 'A',
    });
    return NextResponse.json({ success: true, count: rows.length, data: rows });
  } catch (error) {
    console.error('GET /api/admin/reports error:', error);
    return NextResponse.json({ success: false, error: 'Failed to run report' }, { status: 500 });
  }
}
