import { NextRequest, NextResponse } from 'next/server';
import { sql } from '@/lib/neon';

/**
 * GET /api/lead-campaigns/bounces?campaignId=<id>
 *
 * The bounces for one campaign, newest first — the detail its analytics card only counts.
 *
 * ── Read from our own records, not the platform ─────────────────────────────
 * The platform shows this on its own Bounces tab but exposes no endpoint for it:
 * /campaigns/{id}/bounces and /bounces both 404, and the lead record carries only a
 * status of -1 with no type or reason. Our webhook already receives each bounce and
 * stores the address, the sending mailbox, the step and the time — which is everything
 * the tab shows except the vendor's own wording.
 *
 * Reading it locally also means this answers instantly and keeps working when the vendor
 * is unreachable, which a screen somebody checks after a bad send ought to do. Nothing
 * here calls the platform, deliberately.
 *
 * ── Why it is scoped to a campaign ──────────────────────────────────────────
 * A bounce is not interpretable on its own. "One hard bounce" means something different
 * depending on whether it came out of the Grade B insured sequence or a co-insured blast,
 * and the campaign is what anyone needs in order to decide whether to act. So this is read
 * from the campaign it belongs to, beside the bounce rate that raised the question, rather
 * than from a list of every bounce in the account divorced from its sequence.
 *
 * campaignId is optional only so the route stays usable for a future account-wide view;
 * every caller today passes one.
 */
export const dynamic = 'force-dynamic';

export async function GET(req: NextRequest) {
  try {
    const campaignId = req.nextUrl.searchParams.get('campaignId');

    const rows = await sql`
      SELECT o."bouncedAt", o."bounceType", o."bounceReason", o."recipientEmail",
             o."sendingMailbox", o."emailStep", o."personRole", o."cohort",
             o."vendorCampaignId",
             l."owner1FirstName", l."owner1LastName", l."propertyId",
             l."campaignStatus", l."suppressedReason"
        FROM "OutreachEvent" o
        LEFT JOIN "Lead" l ON l."id" = o."leadId"
       WHERE o."bouncedAt" IS NOT NULL
         AND (${campaignId}::text IS NULL OR o."vendorCampaignId" = ${campaignId})
       ORDER BY o."bouncedAt" DESC
       LIMIT 500` as Array<Record<string, unknown>>;

    const data = rows.map((r) => ({
      bouncedAt: r.bouncedAt,
      /*
       * Hard and soft are not the same event and must not be totalled together: one is a
       * dead address that suppresses, the other a full mailbox or a momentary fault.
       * Anything we could not classify is reported as unknown rather than quietly soft.
       */
      type: r.bounceType === 'hard' ? 'hard' : r.bounceType === 'soft' ? 'soft' : 'unknown',
      reason: r.bounceReason ?? null,
      email: r.recipientEmail,
      sentFrom: r.sendingMailbox ?? null,
      step: r.emailStep ?? null,
      person: r.personRole ?? null,
      cohort: r.cohort ?? null,
      campaignId: r.vendorCampaignId ? String(r.vendorCampaignId) : null,
      owner: [r.owner1FirstName, r.owner1LastName].filter(Boolean).join(' ') || null,
      propertyId: r.propertyId ?? null,
      // Whether the bounce actually did anything. A hard bounce that did not suppress is
      // the failure worth seeing, and it is invisible on a screen that only counts them.
      suppressed: r.campaignStatus === 'suppressed' || r.suppressedReason != null,
    }));

    const counts = {
      total: data.length,
      hard: data.filter((d) => d.type === 'hard').length,
      soft: data.filter((d) => d.type === 'soft').length,
      unknown: data.filter((d) => d.type === 'unknown').length,
      hardNotSuppressed: data.filter((d) => d.type === 'hard' && !d.suppressed).length,
    };

    return NextResponse.json({ success: true, counts, data });
  } catch (error) {
    console.error('GET /api/lead-campaigns/bounces error:', error);
    return NextResponse.json({ success: false, error: 'Could not read bounces' }, { status: 500 });
  }
}
