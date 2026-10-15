import { NextRequest, NextResponse } from 'next/server';
import { sql } from '@/lib/neon';
import { cohortMail, wrapLetter } from '@/services/directMail.service';
import { createLetter, getLetter } from '@/lib/integrations/lob';
import { numberedCohorts } from '@/services/cohort';
import { randomUUID } from 'crypto';

/**
 * A proof: the letter as it will actually be printed, for one real household.
 *
 *   POST /api/admin/direct-mail/proof   { templateId, cohort, propertyId? }  -> { letterId }
 *   GET  /api/admin/direct-mail/proof?letterId=…                            -> pages, when ready
 *
 * ── Why a proof is not a send ───────────────────────────────────────────────
 * It writes nothing to DirectMailSend. The ledger means "letters we asked to have printed
 * for real", and a proof is somebody looking at their own draft. Recording them there would
 * make the first genuine batch read as a re-send, trip the already-mailed guard on whoever
 * was used as the sample, and put a row in the history of a household nobody wrote to.
 *
 * ── Always test mode, with no parameter to change that ──────────────────────
 * There is no `mode` on this endpoint. A proof that could be asked for in live mode is a
 * send button with a gentle name, and the whole point of this screen is that it cannot post
 * anything. Test letters are free, are never printed or mailed, and render the same pages
 * the printer would produce.
 *
 * ── Two steps, because rendering is not instant ─────────────────────────────
 * Creating the letter returns immediately; the page images take anywhere from a second to a
 * couple of minutes. Measured: one proof needed 33 polls at four-second intervals. A single
 * request that waited for both would sit past any serverless budget and time out, so the
 * caller creates, then asks.
 */
export const dynamic = 'force-dynamic';
export const maxDuration = 30;

export async function POST(req: NextRequest) {
  try {
    const b = await req.json();
    const templateId = String(b.templateId ?? '').trim();
    const cohort = String(b.cohort ?? '').trim();
    const propertyId = String(b.propertyId ?? '').trim();

    if (!templateId) {
      return NextResponse.json({ success: false, error: 'Pick a letter first.' }, { status: 400 });
    }
    if (!numberedCohorts().includes(cohort)) {
      return NextResponse.json({ success: false, error: 'Pick a renewal week.' }, { status: 400 });
    }

    const [tpl] = await sql`
      SELECT * FROM "DirectMailTemplate" WHERE "id" = ${templateId}` as Array<Record<string, any>>;
    if (!tpl) {
      return NextResponse.json({ success: false, error: 'That letter no longer exists.' }, { status: 404 });
    }
    if (!String(tpl.html ?? '').trim()) {
      return NextResponse.json({ success: false, error: 'The letter is empty.' }, { status: 400 });
    }

    const { recipients } = await cohortMail(cohort, 'A');
    if (!recipients.length) {
      return NextResponse.json(
        { success: false, error: 'Nobody in this week is mailable yet, so there is nothing to proof against.' },
        { status: 400 },
      );
    }

    /**
     * Proofed against a household that mails ELSEWHERE where the week has one.
     *
     * That is the case most likely to read wrong — the letter follows the owner rather than
     * the house — and it is the one a casual spot check would never pick.
     */
    const recipient = propertyId
      ? recipients.find((r) => r.propertyId === propertyId) ?? recipients[0]
      : recipients.find((r) => r.mailsElsewhere) ?? recipients[0];

    const letter = await createLetter({
      to: {
        name: recipient.name, street: recipient.street,
        city: recipient.city, state: recipient.state, zip: recipient.zip,
      },
      from: {
        name: tpl.fromName ?? '', street: tpl.fromStreet ?? '',
        city: tpl.fromCity ?? '', state: tpl.fromState ?? '', zip: tpl.fromZip ?? '',
      },
      html: wrapLetter(String(tpl.html)),
      mergeVariables: recipient.vars,
      color: !!tpl.color,
      doubleSided: tpl.doubleSided !== false,
      // Unique per proof: each one must render afresh, or an edited letter would come back
      // as the previous version — which is exactly what a repeated key does.
      idempotencyKey: `proof-${randomUUID()}`,
      description: `proof ${cohort} ${recipient.propertyId}`,
    }, 'test');

    return NextResponse.json({
      success: true,
      letterId: letter.id,
      expectedAt: letter.expectedDeliveryDate,
      recipient: {
        propertyId: recipient.propertyId,
        name: recipient.name,
        mailsElsewhere: recipient.mailsElsewhere,
        address: [recipient.street, recipient.city, recipient.state, recipient.zip]
          .filter(Boolean).join(', '),
      },
    });
  } catch (err) {
    console.error('POST /api/admin/direct-mail/proof error:', err);
    return NextResponse.json(
      { success: false, error: err instanceof Error ? err.message : 'Could not render a proof' },
      { status: 500 },
    );
  }
}

export async function GET(req: NextRequest) {
  try {
    const letterId = (req.nextUrl.searchParams.get('letterId') ?? '').trim();
    if (!/^ltr_[a-zA-Z0-9]+$/.test(letterId)) {
      return NextResponse.json({ success: false, error: 'Not a letter id.' }, { status: 400 });
    }

    const letter = await getLetter(letterId, 'test');
    const thumbs = Array.isArray(letter.thumbnails) ? letter.thumbnails : [];

    /**
     * Readiness is the vendor's `status`, not the presence of thumbnail URLs.
     *
     * The letter object carries a fully populated `thumbnails` array from the moment it is
     * created — complete with signed URLs — while the images behind them do not exist yet
     * and return 404. Trusting the array reported a proof as ready, listed its pages, and
     * rendered a row of broken images two pixels tall. `status` goes to 'rendered' when the
     * pages actually exist.
     */
    const ready = String(letter.status ?? '') === 'rendered' && thumbs.length > 0;

    return NextResponse.json({
      success: true,
      ready,
      status: letter.status ?? null,
      /**
       * Our own path, not the vendor's signed URL.
       *
       * Those URLs carry a signature and an expiry — one minted now is dead within hours —
       * so handing them to the browser produces a proof that works when you open it and is
       * a broken image when you come back to it. The page asks us; we ask the vendor.
       */
      // Only once the images exist. Handing out page paths early is what produced the
      // broken images — the paths were fine, the pages behind them were not there.
      pages: ready
        ? thumbs.map((_t: unknown, i: number) =>
          `/api/admin/direct-mail/proof/page?letterId=${encodeURIComponent(letterId)}&page=${i + 1}`)
        : [],
      pageCount: ready ? thumbs.length : 0,
      expectedAt: letter.expected_delivery_date ?? null,
      carrier: letter.carrier ?? null,
    });
  } catch (err) {
    console.error('GET /api/admin/direct-mail/proof error:', err);
    return NextResponse.json({ success: false, error: 'Could not read the proof' }, { status: 500 });
  }
}
