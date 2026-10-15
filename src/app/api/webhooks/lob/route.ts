import { NextRequest, NextResponse } from 'next/server';
import { sql } from '@/lib/neon';
import { createHmac, timingSafeEqual } from 'crypto';

/**
 * What the post office tells us happened to a letter.
 *
 *   POST /api/webhooks/lob
 *
 * A letter is the one channel where we learn the outcome from somebody else. An email tells
 * us it bounced; a phone call tells us it rang out. A letter goes into a box and the only
 * way to know whether it arrived — or came back, or was re-routed to a forwarding address —
 * is for the vendor to tell us. Without this the ledger would record 50 letters sent and
 * nothing afterwards, forever.
 *
 * ── Unauthenticated by necessity, so the signature IS the authentication ────
 * This endpoint has to be reachable by a third party, so it cannot sit behind a session.
 * Anyone can POST to it. The only thing separating a real event from an invention is the
 * HMAC, which is why an unverified request is refused rather than merely logged — a forged
 * "returned_to_sender" would retire a good address, and a forged "delivered" would hide a
 * batch that never arrived.
 *
 * ── Always answers 200, except on a bad signature ───────────────────────────
 * The vendor retries anything that is not a 2xx. An event we do not model, or one for a
 * letter we have no record of, is not a failure on their side and must not be retried
 * forever — it is acknowledged and recorded. The only thing worth refusing is a request we
 * cannot prove came from them.
 */
export const dynamic = 'force-dynamic';

/** Lob's own recommendation. Beyond this a captured request is a replay, not a delivery. */
const TOLERANCE_MS = 5 * 60 * 1000;

/**
 * Which timestamp an event fills.
 *
 * Only the events a person would act on get a column of their own. Everything else is kept
 * in lastEvent and in the event table, because an event we have not thought about yet is
 * exactly the one worth being able to find later.
 */
const COLUMN_FOR: Record<string, string> = {
  'letter.in_transit': 'inTransitAt',
  'letter.in_local_area': 'inLocalAreaAt',
  'letter.processed_for_delivery': 'processedAt',
  'letter.delivered': 'deliveredAt',
  'letter.returned_to_sender': 'returnedAt',
};

/** Events that mean the letter is not going to arrive, and the status they produce. */
const STATUS_FOR: Record<string, string> = {
  'letter.delivered': 'delivered',
  'letter.returned_to_sender': 'returned',
  'letter.failed': 'failed',
  'letter.rejected': 'failed',
};

function verify(raw: string, signature: string | null, timestamp: string | null): boolean {
  const secret = process.env.LOB_WEBHOOK_SECRET;
  if (!secret || !signature || !timestamp) return false;

  const age = Math.abs(Date.now() - Number(timestamp));
  if (!Number.isFinite(age) || age > TOLERANCE_MS) return false;

  // The RAW body, exactly as received: parsing and re-stringifying changes the bytes and
  // the digest with them.
  const expected = createHmac('sha256', secret).update(`${timestamp}.${raw}`).digest('hex');
  const a = Buffer.from(expected);
  const b = Buffer.from(signature);
  // Length-safe, and constant-time — a comparison that returns early leaks the digest.
  return a.length === b.length && timingSafeEqual(a, b);
}

export async function POST(req: NextRequest) {
  const raw = await req.text();

  if (!verify(raw, req.headers.get('lob-signature'), req.headers.get('lob-signature-timestamp'))) {
    console.warn('Lob webhook rejected: signature did not verify');
    return NextResponse.json({ success: false, error: 'Bad signature' }, { status: 401 });
  }

  try {
    const evt = JSON.parse(raw) as Record<string, any>;
    const eventId = String(evt.id ?? '');
    const eventType = String(evt.event_type?.id ?? '');
    const letterId = String(evt.reference_id ?? '');
    const occurredAt = evt.date_created ? new Date(evt.date_created).toISOString() : null;

    if (!eventId || !letterId) {
      return NextResponse.json({ success: true, ignored: 'no event or letter id' });
    }

    const [send] = await sql`
      SELECT "id", "status" FROM "DirectMailSend"
       WHERE "vendorLetterId" = ${letterId}` as Array<{ id: string; status: string }>;

    /**
     * Recorded before anything is interpreted, and keyed on the vendor's event id.
     *
     * A redelivered webhook — which is routine, because a slow 200 looks like a failure to
     * the sender — inserts nothing the second time, so no timestamp moves twice and no
     * event is double counted.
     */
    const claimed = await sql`
      INSERT INTO "DirectMailEvent" ("id","sendId","vendorLetterId","eventType","occurredAt","payload")
      VALUES (${eventId}, ${send?.id ?? null}, ${letterId}, ${eventType}, ${occurredAt}, ${JSON.stringify(evt.body ?? {})})
      ON CONFLICT ("id") DO NOTHING
      RETURNING "id"` as Array<{ id: string }>;

    if (!claimed.length) {
      return NextResponse.json({ success: true, duplicate: true });
    }
    // A letter we did not send — a proof, or somebody else's — is acknowledged and kept,
    // but there is no row of ours to update.
    if (!send) {
      return NextResponse.json({ success: true, unknownLetter: true });
    }

    const when = occurredAt ?? new Date().toISOString();
    const column = COLUMN_FOR[eventType];
    const status = STATUS_FOR[eventType];

    /**
     * The column is from a fixed map, never from the payload.
     *
     * eventType arrives over the wire from an endpoint anyone can reach, and interpolating
     * it into SQL would make the signature the only thing standing between a stranger and
     * our column names. COLUMN_FOR is the whitelist; an unknown event simply has no column.
     */
    if (column === 'inTransitAt') {
      await sql`UPDATE "DirectMailSend" SET "inTransitAt" = COALESCE("inTransitAt", ${when}) WHERE "id" = ${send.id}`;
    } else if (column === 'inLocalAreaAt') {
      await sql`UPDATE "DirectMailSend" SET "inLocalAreaAt" = COALESCE("inLocalAreaAt", ${when}) WHERE "id" = ${send.id}`;
    } else if (column === 'processedAt') {
      await sql`UPDATE "DirectMailSend" SET "processedAt" = COALESCE("processedAt", ${when}) WHERE "id" = ${send.id}`;
    } else if (column === 'deliveredAt') {
      await sql`UPDATE "DirectMailSend" SET "deliveredAt" = COALESCE("deliveredAt", ${when}) WHERE "id" = ${send.id}`;
    } else if (column === 'returnedAt') {
      await sql`UPDATE "DirectMailSend" SET "returnedAt" = COALESCE("returnedAt", ${when}) WHERE "id" = ${send.id}`;
    }

    // Two statements rather than a conditional expression: only a terminal event moves the
    // status, and an "in transit" must never overwrite a "delivered" that arrived first.
    if (status) {
      await sql`
        UPDATE "DirectMailSend"
           SET "lastEvent" = ${eventType}, "lastEventAt" = ${when},
               "status" = ${status}, "updatedAt" = NOW()
         WHERE "id" = ${send.id}`;
    } else {
      await sql`
        UPDATE "DirectMailSend"
           SET "lastEvent" = ${eventType}, "lastEventAt" = ${when}, "updatedAt" = NOW()
         WHERE "id" = ${send.id}`;
    }

    return NextResponse.json({ success: true, eventType, applied: !!(column || status) });
  } catch (err) {
    /**
     * A 200 even on our own error.
     *
     * The signature already proved this came from the vendor, so the event is genuine and
     * retrying it will hit the same bug. Answering 500 would put us in a retry loop that
     * fixes nothing and buries the real exception under hundreds of copies.
     */
    console.error('POST /api/webhooks/lob error:', err);
    return NextResponse.json({ success: false, logged: true });
  }
}
