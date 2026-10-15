import { NextResponse } from 'next/server';
import { sql } from '@/lib/neon';

/**
 * GET /api/leads/{propertyId}/contact-verification
 *
 * Every identity verdict held for one lead's contact points, both channels.
 *
 * ── Why its own endpoint ────────────────────────────────────────────────────
 * The call panel already gets the phone verdicts through /calls, because it needs them to
 * decide what to offer. The card needs the EMAIL ones for a different reason — to say which
 * address is actually this person's before somebody copies it into a campaign — and loading
 * them through the lead payload would put a join on every screen that reads a lead.
 *
 * A lead with no verdicts returns empty lists, which is most of the book: only C2 has been
 * graded. Absent must read as "not checked", never as "failed".
 */
export const dynamic = 'force-dynamic';

export async function GET(_req: Request, ctx: { params: Promise<{ id: string }> }) {
  try {
    const { id } = await ctx.params;
    const rows = await sql`
      SELECT v."channel", v."value", v."personRole", v."nameMatch", v."isValid",
             v."activityScore", v."emailAgeScore", v."emailContactGrade"
        FROM "ContactVerification" v
        JOIN "Lead" l ON l."id" = v."leadId"
       WHERE l."propertyId" = ${id} OR l."id" = ${id}` as Array<Record<string, unknown>>;

    const shape = (channel: string) => rows
      .filter((r) => r.channel === channel)
      .map((r) => ({
        value: String(r.value),
        role: String(r.personRole),
        nameMatch: r.nameMatch as boolean | null,
        isValid: r.isValid as boolean | null,
        activityScore: r.activityScore == null ? null : Number(r.activityScore),
        /**
         * The address's age and activity, 0–100. Null on everything graded before 15 Oct —
         * it is a paid add-on we were not asking for, so absent means "never scored", not
         * "scored badly", and nothing may read a missing score as a low one.
         */
        ageScore: r.emailAgeScore == null ? null : Number(r.emailAgeScore),
        contactGrade: (r.emailContactGrade as string | null) ?? null,
      }));

    return NextResponse.json({ success: true, email: shape('email'), phone: shape('phone') });
  } catch (err) {
    console.error('GET /api/leads/[id]/contact-verification error:', err);
    return NextResponse.json({ success: false, error: 'Could not read the verdicts' }, { status: 500 });
  }
}
