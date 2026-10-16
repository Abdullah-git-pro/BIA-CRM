import { NextRequest, NextResponse } from 'next/server';
import { sql } from '@/lib/neon';
import { getSessionUser, actorLabel } from '@/lib/auth';
import { addActivity } from '@/services/storage.service';

/**
 * A person settling a name the roll could not.
 *
 *   POST /api/admin/review-queue/decide
 *     { propertyId, decision: 'confirmed' | 'rejected' | 'reopen', note? }
 *
 * ── Who this is for ─────────────────────────────────────────────────────────
 * Frank or Ruben open a card the township could not confirm, look at the evidence, and say
 * whether the name we hold is the policyholder. Until now there was nowhere to put that
 * answer: the card could only re-ask the township, which returns what it returned before.
 *
 * ── It does not touch the machine's verdict ─────────────────────────────────
 * ownerVerifyStatus stays exactly as the roll left it. The decision sits beside it, so the
 * difference between "the deed confirms this" and "a colleague was satisfied" survives — and
 * anything downstream can say which of the two it is relying on.
 *
 * ── Rejected is a decision too ──────────────────────────────────────────────
 * It is not the absence of one. A card somebody has looked at and judged wrong should leave
 * the queue — otherwise the queue re-offers it until a second person wastes the same ten
 * minutes — but it must never become mailable. Only 'confirmed' opens that gate.
 */
export const dynamic = 'force-dynamic';

const DECISIONS = new Set(['confirmed', 'rejected', 'reopen']);

export async function POST(req: NextRequest) {
  try {
    const user = await getSessionUser(req);
    if (!user) {
      return NextResponse.json({ success: false, error: 'Not authenticated' }, { status: 401 });
    }
    const by = actorLabel(user);
    const b = await req.json();

    const propertyId = String(b.propertyId ?? '').trim();
    const decision = String(b.decision ?? '').trim();
    const note = String(b.note ?? '').trim().slice(0, 1000) || null;

    if (!propertyId) {
      return NextResponse.json({ success: false, error: 'Which lead?' }, { status: 400 });
    }
    if (!DECISIONS.has(decision)) {
      return NextResponse.json(
        { success: false, error: "A decision is 'confirmed', 'rejected' or 'reopen'." },
        { status: 400 },
      );
    }

    const [lead] = await sql`
      SELECT "id", "propertyId", "ownerVerifyStatus", "ownerVerifyName",
             "owner1FirstName", "owner1LastName", "ownerReviewDecision"
        FROM "Lead" WHERE "propertyId" = ${propertyId} OR "id" = ${propertyId}
    ` as Array<Record<string, any>>;
    if (!lead) {
      return NextResponse.json({ success: false, error: 'No such lead.' }, { status: 404 });
    }

    const owner = [lead.owner1FirstName, lead.owner1LastName].filter(Boolean).join(' ').trim();

    if (decision === 'reopen') {
      /**
       * Clearing a decision is itself recorded.
       *
       * Somebody reversing a colleague's judgement is exactly the event a later reader needs
       * to see — and a silent clear would make the card look as though it had never been
       * reviewed at all.
       */
      await sql`
        UPDATE "Lead"
           SET "ownerReviewDecision" = NULL, "ownerReviewBy" = NULL, "ownerReviewAt" = NULL,
               "ownerReviewNote" = NULL, "ownerReviewRollName" = NULL,
               "ownerReviewStatusAt" = NULL
         WHERE "id" = ${lead.id}`;
      await addActivity(lead.id, 'owner_review_reopened',
        `${by} reopened the name review for ${owner || 'this card'}${note ? ` — ${note}` : ''}`,
        undefined, by ?? undefined);
      return NextResponse.json({ success: true, propertyId: lead.propertyId, decision: null });
    }

    /**
     * The roll's name and verdict are copied in as they stand right now.
     *
     * A decision is about the evidence that was on screen. If the roll is read again later
     * and names somebody else, this is what makes that drift visible rather than leaving a
     * tick attached to a fact that has since changed.
     */
    await sql`
      UPDATE "Lead"
         SET "ownerReviewDecision"  = ${decision},
             "ownerReviewBy"        = ${by},
             "ownerReviewAt"        = NOW(),
             "ownerReviewNote"      = ${note},
             "ownerReviewRollName"  = ${lead.ownerVerifyName ?? null},
             "ownerReviewStatusAt"  = ${lead.ownerVerifyStatus ?? null}
       WHERE "id" = ${lead.id}`;

    await addActivity(
      lead.id,
      decision === 'confirmed' ? 'owner_review_confirmed' : 'owner_review_rejected',
      `${by} ${decision === 'confirmed' ? 'confirmed' : 'rejected'} the name on this card`
      + ` (${owner || 'no name on file'}`
      + `${lead.ownerVerifyName ? ` vs roll "${lead.ownerVerifyName}"` : ''})`
      + `${note ? ` — ${note}` : ''}`,
      // The actor goes in the column too, not only in the sentence: a report filtering on
      // createdBy should find these, and a sentence is not a field.
      undefined,
      by ?? undefined,
    );

    return NextResponse.json({
      success: true,
      propertyId: lead.propertyId,
      decision,
      by,
      // So the caller can show what the decision was taken against.
      rollName: lead.ownerVerifyName ?? null,
      wasStatus: lead.ownerVerifyStatus ?? null,
    });
  } catch (err) {
    console.error('POST /api/admin/review-queue/decide error:', err);
    return NextResponse.json(
      { success: false, error: err instanceof Error ? err.message : 'Could not record the decision' },
      { status: 500 },
    );
  }
}
