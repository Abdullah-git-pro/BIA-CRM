import { pool } from '@/lib/neon';
import { listEmailsPage, type VendorEmail } from '@/lib/integrations/leadCampaign';
import { htmlToText } from '@/lib/integrations/campaignWebhook';

/**
 * Fill in what was actually sent: the mailbox that sent it and the copy it carried.
 *
 * ── Why this exists rather than relying on the webhook ───────────────────────
 * Two reasons, and either alone would justify it.
 *
 * First, the webhook is not wired in production yet — the vendor dashboard still has to
 * be pointed at /api/webhooks/campaign — so without this the sending-mailbox and content
 * columns would be empty for every send until that happens, including sends already
 * made.
 *
 * Second, even once it is wired, a webhook is a single delivery attempt against an
 * endpoint that can be down, redeployed mid-request, or simply never called for an event
 * type the vendor decides not to emit. The message feed is queryable after the fact, so
 * it is the thing that can be reconciled. The webhook makes the CRM live; this makes it
 * correct.
 *
 * ── Why the copy is stored rather than read from the campaign ────────────────
 * A campaign's sequence can be edited at any time. The copy the campaign holds today is
 * not necessarily the copy a homeowner received last week, so "which subject line did
 * this cohort get" is unanswerable from the campaign itself. Captured once per send,
 * never refreshed.
 */

/** Outbound. Inbound replies carry a different ue_type and must not overwrite our copy. */
const UE_TYPE_SENT = 1;

export type ReconcileResult = {
  scanned: number;
  /** Feed rows tied to a local send. */
  matched: number;
  /** Local rows that gained a mailbox or copy they did not have. */
  updated: number;
  /** Outbound rows with no local send — almost always added in the vendor dashboard. */
  unmatched: number;
  /** Pass back as `startingAfter` to continue; null when the feed is exhausted. */
  nextCursor: string | null;
  done: boolean;
};

function senderOf(e: VendorEmail): string | null {
  const v = String(e.from_address_email ?? e.eaccount ?? '').trim().toLowerCase();
  return v || null;
}

function bodyOf(e: VendorEmail): string | null {
  if (typeof e.body === 'string') return htmlToText(e.body);
  return htmlToText(e.body?.html ?? e.body?.text ?? null);
}

/**
 * Walk a bounded slice of the message feed and stamp what it says onto our sends.
 *
 * Bounded and resumable for the same reason as the push: this route has a 10s budget and
 * the feed is one HTTP call per page. Each page is written before the next is fetched, so
 * an interrupted run loses nothing and resuming from `nextCursor` cannot double-write —
 * every update is COALESCE, so a row that already has its content is left alone.
 */
export async function reconcileSentContent(opts: {
  campaignId?: string;
  startingAfter?: string;
  /** Feed pages per invocation. 5 × 100 rows sits comfortably inside the budget. */
  maxPages?: number;
  pageSize?: number;
} = {}): Promise<ReconcileResult> {
  const maxPages = Math.max(1, Math.min(opts.maxPages ?? 5, 20));
  const pageSize = Math.max(1, Math.min(opts.pageSize ?? 100, 100));

  let cursor: string | null = opts.startingAfter ?? null;
  let scanned = 0, matched = 0, updated = 0, unmatched = 0;
  let exhausted = false;

  const client = await pool.connect();
  try {
    for (let page = 0; page < maxPages; page++) {
      const { items, nextCursor } = await listEmailsPage({
        campaignId: opts.campaignId,
        limit: pageSize,
        startingAfter: cursor ?? undefined,
      });
      scanned += items.length;

      for (const e of items) {
        if (e.ue_type !== UE_TYPE_SENT) continue;

        const sender = senderOf(e);
        const subject = e.subject?.trim() || null;
        const body = bodyOf(e);
        if (!sender && !subject && !body) continue;

        // Matched on the vendor's lead id first — it is the key the push stored and is
        // exact. The recipient address is the fallback for a send whose lead id we never
        // captured, and is scoped to the campaign so the same homeowner in two campaigns
        // cannot cross-contaminate.
        const recipient = String(e.to_address_email_list ?? '').split(',')[0].trim().toLowerCase();
        const { rows } = await client.query(
          `UPDATE "OutreachEvent"
              SET "sendingMailbox"    = COALESCE("sendingMailbox", $1),
                  "emailSubject"      = COALESCE("emailSubject", $2),
                  "emailBody"         = COALESCE("emailBody", $3),
                  "contentCapturedAt" = COALESCE("contentCapturedAt", NOW()),
                  "updatedAt" = NOW()
            WHERE "id" = (
              SELECT "id" FROM "OutreachEvent"
               WHERE ($4::text IS NOT NULL AND "vendorLeadId" = $4)
                  OR ($5::text <> '' AND lower("recipientEmail") = $5
                      AND ($6::text IS NULL OR "vendorCampaignId" = $6))
               ORDER BY ("vendorLeadId" IS NOT DISTINCT FROM $4) DESC, "sentAt" DESC NULLS LAST
               LIMIT 1
            )
              AND ("sendingMailbox" IS NULL OR "emailSubject" IS NULL OR "emailBody" IS NULL)
            RETURNING "id"`,
          [sender, subject, body, e.lead_id ?? null, recipient, e.campaign_id ?? null],
        );

        // A row already carrying all three is a match, not a miss — it simply had
        // nothing left to learn. Counting it as unmatched would make a healthy
        // reconciliation look like it was failing to find anything.
        if (rows.length) { matched++; updated++; continue; }

        const { rows: exists } = await client.query(
          `SELECT 1 FROM "OutreachEvent"
            WHERE ($1::text IS NOT NULL AND "vendorLeadId" = $1)
               OR ($2::text <> '' AND lower("recipientEmail") = $2)
            LIMIT 1`,
          [e.lead_id ?? null, recipient],
        );
        if (exists.length) matched++; else unmatched++;
      }

      cursor = nextCursor;
      /*
       * A short page is the end of the list.
       *
       * The platform returns a cursor on every page including the last, so stopping only
       * on a missing cursor spent one extra request per run to be told there was nothing
       * left — and this runs against a budget of twenty requests a minute.
       */
      if (!nextCursor || items.length < pageSize) { exhausted = true; break; }
    }
  } finally {
    client.release();
  }

  return { scanned, matched, updated, unmatched, nextCursor: cursor, done: exhausted };
}

/**
 * Safety net: a send with no cohort is invisible to every per-cohort report.
 *
 * The push stamps the cohort at insert time, so this should find nothing. It exists
 * because "should find nothing" and "does find nothing" are different claims, and the
 * failure mode — a send quietly missing from a cohort's totals — is one nobody would
 * notice from looking at the report.
 */
export async function backfillEventCohorts(): Promise<number> {
  const { rowCount } = await pool.query(
    `UPDATE "OutreachEvent" e
        SET "cohort" = l."cohort", "updatedAt" = NOW()
       FROM "Lead" l
      WHERE l."id" = e."leadId"
        AND e."cohort" IS NULL
        AND l."cohort" IS NOT NULL`,
  );
  return rowCount ?? 0;
}
