import { NextRequest, NextResponse } from 'next/server';
import { syncPlacement, latestByDomain } from '@/services/inboxPlacement.service';
import { isConfigured } from '@/lib/integrations/seedTest';

/**
 * Inbox placement readings from the seed tool — the feed for §02's gate on sending.
 *
 *   GET  /api/admin/inbox-placement
 *        The latest reading per sending domain, plus the combined one the gate reads.
 *        Reads only — contacts nothing outside.
 *
 *   POST /api/admin/inbox-placement
 *        Pull finished tests from the seed tool and record any not already held.
 *        Idempotent: a test already recorded is left alone, never rewritten.
 *
 * ── Why POST and not a cron, yet ─────────────────────────────────────────────
 * §08 wants a weekly reading, and a measurement that depends on somebody remembering is
 * the judgment §08 exists to remove. This should be called on a schedule beside the
 * protective-metrics enforcement. Until it is, it is as regular as whoever clicks it —
 * which is worth saying plainly rather than leaving as an assumption.
 */
export const maxDuration = 60;

export async function GET() {
  try {
    const rows = await latestByDomain();
    const overall = rows.find((r) => !r.domain) ?? null;
    return NextResponse.json({
      success: true,
      configured: isConfigured(),
      overall,
      byDomain: rows.filter((r) => r.domain),
      note: isConfigured()
        ? null
        : 'No seed-tool API key is configured, so no new readings can be taken.',
    });
  } catch (err) {
    console.error('GET /api/admin/inbox-placement error:', err);
    return NextResponse.json(
      { success: false, error: err instanceof Error ? err.message : 'Could not read the inbox-placement history' },
      { status: 500 },
    );
  }
}

export async function POST(req: NextRequest) {
  try {
    const limit = Number(req.nextUrl.searchParams.get('limit'));
    const result = await syncPlacement({
      limitPerProject: Number.isFinite(limit) && limit > 0 ? limit : undefined,
    });
    return NextResponse.json({ success: true, ...result });
  } catch (err) {
    console.error('POST /api/admin/inbox-placement error:', err);
    return NextResponse.json(
      { success: false, error: err instanceof Error ? err.message : 'Could not pull readings from the seed tool' },
      { status: 500 },
    );
  }
}
