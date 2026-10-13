import { notifyEngagement } from '@/services/engagementNotify.service';
import { NextRequest, NextResponse } from 'next/server';
import { pool } from '@/lib/neon';
import {
  WEBHOOK_HEADER, WEBHOOK_QUERY_PARAM, verifyWebhookSecret, classifyEvent, readPayload,
  cleanReplyExcerpt, htmlToText,
} from '@/lib/integrations/campaignWebhook';
import { stopHousehold, setPrimaryContact, type HouseholdStopResult } from '@/services/householdStop.service';
import { versionLabel, type Segment } from '@/services/campaignSegment.service';
import { suppressWithClient, isExplicitStopReply } from '@/services/suppression.service';

/**
 * POST /api/webhooks/campaign — outcomes from the campaign platform.
 *
 * This is what makes the integration live instead of something a producer has to go
 * and check in the vendor's dashboard.
 *
 * Three policies worth stating, because each one is a deliberate choice:
 *
 *  1. AUTH — the vendor does not sign payloads, so a shared secret arrives on the
 *     `x-bia-campaign-key` header and is compared in constant time. Unconfigured in
 *     production means refuse, not allow.
 *
 *  2. NO MATCH IS NOT AN ERROR — a payload we cannot tie to a local row is
 *     acknowledged with 200 and `matched: false`. It usually means the lead was added
 *     directly in the vendor's dashboard and never touched this CRM. Returning an
 *     error there would make the vendor retry forever over something that is working
 *     as intended. Nothing is ever created speculatively: we only update outcomes for
 *     sends this CRM actually initiated.
 *
 *  3. REAL FAILURES RETURN 5xx — so the vendor's own retry re-delivers later. An
 *     unrecognised event type is acknowledged and ignored; a database error is not.
 *
 * This route is public by necessity (the vendor cannot authenticate as a CRM user),
 * so it must stay on the middleware's PUBLIC_PATHS list while the header check above
 * carries the whole security burden.
 */

/** Never let a webhook hang a vendor retry loop, and stay inside the smallest
 *  Vercel function limit so this cannot fail to build on a lower plan. */
export const maxDuration = 10;

export async function POST(request: NextRequest) {
  // ── auth ──────────────────────────────────────────────────────────────────
  if (!verifyWebhookSecret(
    request.headers.get(WEBHOOK_HEADER),
    request.nextUrl.searchParams.get(WEBHOOK_QUERY_PARAM),
  )) {
    // Deliberately terse: an attacker probing the endpoint learns nothing about
    // whether the header was missing, wrong length, or simply wrong.
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  let body: any;
  try {
    body = await request.json();
  } catch {
    // Malformed JSON will never become valid on a retry — acknowledge and drop.
    return NextResponse.json({ ok: true, matched: false, reason: 'unparseable body' });
  }

  const p = readPayload(body);
  const kind = classifyEvent(p.eventType);

  // Unrecognised event type: acknowledge, write nothing. The vendor sends types we
  // have no opinion on, and erroring on them would trigger pointless retries.
  //
  // 'sent' USED to be discarded here alongside them. It is now handled: it is the only
  // event that carries which mailbox the platform chose and what the copy said, and a
  // per-mailbox or per-content report has no other live source for either.
  if (!kind) {
    return NextResponse.json({ ok: true, matched: false, event: p.eventType ?? null, handled: false });
  }
  if (!p.email) {
    return NextResponse.json({ ok: true, matched: false, reason: 'no recipient in payload' });
  }

  const client = await pool.connect();
  try {
    // ── find the row this event is about ─────────────────────────────────────
    // Campaign id narrows it when present, but is not required: a payload missing it
    // should still land on the right row rather than be discarded.
    // The lead's address comes back too: the household key is derived from it, and a
    // suppression recorded without one would be scoped to a lead rather than a household.
    /**
     * ── The campaign id PREFERS a row, it does not require one ───────────────
     *
     * The comment above always said the id "is not required", but the SQL did require it the
     * moment a payload carried one: `e."vendorCampaignId" = $2` is false against a row whose
     * campaign id is null or different, so the event was dropped and the endpoint answered
     * `matched: false` — a 200, logged nowhere, with a real reply lost.
     *
     * That is exactly what happens to a contact list loaded into the platform by hand: the
     * CRM has a record of the person but not of the platform's campaign id for them. The row
     * is right there and the old query walked past it.
     *
     * So the match is now ordered, not filtered: same campaign first, then the most recent
     * send to that address. An address is a person either way — the campaign id only decides
     * WHICH of their sends this event belongs to.
     */
    const { rows: found } = await client.query(
      `SELECT e."id", e."leadId", e."openCount", e."personRole", e."vendorCampaignId",
              l."addressStreet", l."addressZip"
         FROM "OutreachEvent" e
         LEFT JOIN "Lead" l ON l."id" = e."leadId"
        WHERE lower(e."recipientEmail") = $1
        ORDER BY e."vendorCampaignId" IS NOT DISTINCT FROM $2 DESC,
                 e."sentAt" DESC NULLS LAST
        LIMIT 1`,
      [p.email, p.campaignId],
    );

    /**
     * Learn the campaign id from the first event that carries one.
     *
     * A row registered ahead of an upload has no campaign id — nobody knew it yet. Stamping
     * it here means every later event about that person matches on the campaign directly
     * rather than falling back, and the reconciliation sweep can find them.
     */
    if (found.length && p.campaignId && !found[0].vendorCampaignId) {
      await client.query(
        `UPDATE "OutreachEvent" SET "vendorCampaignId" = $2, "updatedAt" = NOW() WHERE "id" = $1`,
        [found[0].id, p.campaignId],
      );
    }

    if (!found.length) {
      return NextResponse.json({ ok: true, matched: false, event: p.eventType, email: p.email });
    }
    const row = found[0];
    const now = new Date();

    // Outcome row + parent lead move together: a reply recorded on one but not the
    // other is exactly how a suppressed lead gets mailed again.
    await client.query('BEGIN');

    let leadPatch: { sql: string; params: any[] } | null = null;

    if (kind === 'reply') {
      await client.query(
        `UPDATE "OutreachEvent"
            SET "repliedAt" = COALESCE("repliedAt", $2), "replyExcerpt" = COALESCE("replyExcerpt", $3), "updatedAt" = $2
          WHERE "id" = $1`,
        [row.id, now, cleanReplyExcerpt(p.replyText)],
      );
      // A reply is engagement: stop the sequence for this household.
      leadPatch = {
        sql: `UPDATE "Lead"
                 SET "campaignRepliedAt" = COALESCE("campaignRepliedAt", $2),
                     "campaignStatus" = 'engaged', "updatedAt" = $2
               WHERE "id" = $1`,
        params: [row.leadId, now],
      };
    } else if (kind === 'bounce') {
      /**
       * ── The SMTP code decides, when the platform sends one ───────────────
       *
       * The first real bounce arrived on 13 Oct: cmanuel@ascendlearning.org, which the
       * platform's own screen calls a HARD bounce, policy blocked, 5.7.0. We stored it as
       * SOFT, because neither `bounce_type` nor `bounce_reason` was in the payload under
       * any name this reads, so it fell through to the 'soft' default — and soft does not
       * suppress. We would have gone on mailing a dead address.
       *
       * An SMTP status is the authority and does not depend on the vendor's wording: 5.x.x
       * is a permanent failure, 4.x.x a transient one. That is the standard, so it is
       * checked first and the vendor's own label second.
       *
       * Defaulting to soft stays right. Suppressing on a bounce we could not classify
       * would write off addresses over a full mailbox or a momentary server fault, and
       * the whole point of the hard/soft split is that only one of them is permanent.
       */
      const smtp = String(p.bounceCode ?? p.bounceReason ?? '').match(/\b([45])\.\d{1,3}\.\d{1,3}\b/);
      const hard = smtp
        ? smtp[1] === '5'
        : String(p.bounceType ?? '').toLowerCase().includes('hard')
          || /(does not exist|no such user|unknown recipient|policy|blocked|550|5\.7)/i.test(String(p.bounceReason ?? ''));
      await client.query(
        `UPDATE "OutreachEvent"
            SET "bouncedAt" = COALESCE("bouncedAt", $2), "bounceType" = COALESCE("bounceType", $3),
                "bounceReason" = COALESCE("bounceReason", $4), "updatedAt" = $2
          WHERE "id" = $1`,
        [row.id, now, hard ? 'hard' : (p.bounceType ?? 'soft'), p.bounceReason ?? p.bounceCode ?? null],
      );
      // Only a HARD bounce suppresses. A soft bounce is a full mailbox or a transient
      // server problem, and writing the address off for that would be wrong.
      leadPatch = hard
        ? {
            sql: `UPDATE "Lead"
                     SET "campaignBouncedAt" = COALESCE("campaignBouncedAt", $2),
                         "hardBounced" = TRUE, "campaignStatus" = 'suppressed',
                         "suppressedReason" = COALESCE("suppressedReason", 'hard_bounce'), "updatedAt" = $2
                   WHERE "id" = $1`,
            params: [row.leadId, now],
          }
        : {
            sql: `UPDATE "Lead" SET "campaignBouncedAt" = COALESCE("campaignBouncedAt", $2), "updatedAt" = $2 WHERE "id" = $1`,
            params: [row.leadId, now],
          };
    } else if (kind === 'unsubscribe') {
      await client.query(
        `UPDATE "OutreachEvent" SET "unsubscribedAt" = COALESCE("unsubscribedAt", $2), "updatedAt" = $2 WHERE "id" = $1`,
        [row.id, now],
      );
      leadPatch = {
        sql: `UPDATE "Lead"
                 SET "campaignUnsubscribedAt" = COALESCE("campaignUnsubscribedAt", $2),
                     "campaignStatus" = 'suppressed',
                     "suppressedReason" = COALESCE("suppressedReason", 'unsubscribe'), "updatedAt" = $2
               WHERE "id" = $1`,
        params: [row.leadId, now],
      };
    } else if (kind === 'complaint') {
      await client.query(
        `UPDATE "OutreachEvent" SET "complainedAt" = COALESCE("complainedAt", $2), "updatedAt" = $2 WHERE "id" = $1`,
        [row.id, now],
      );
      leadPatch = {
        sql: `UPDATE "Lead"
                 SET "campaignStatus" = 'suppressed',
                     "suppressedReason" = COALESCE("suppressedReason", 'complaint'), "updatedAt" = $2
               WHERE "id" = $1`,
        params: [row.leadId, now],
      };
    } else if (kind === 'open') {
      // First open stamps the time; every open increments the counter.
      await client.query(
        `UPDATE "OutreachEvent"
            SET "openedAt" = COALESCE("openedAt", $2), "openCount" = "openCount" + 1, "updatedAt" = $2
          WHERE "id" = $1`,
        [row.id, now],
      );
    } else if (kind === 'delivered') {
      /**
       * The platform accepted it AND the receiving server took it.
       *
       * This is the denominator Sec 10.7 measures engagement against, and until now
       * nothing wrote it. sentAt is set too, because a delivery proves a send happened
       * even if we never saw the send event — vendors drop them, and a delivered message
       * that reads as never sent would put the funnel's own rungs out of order.
       */
      await client.query(
        `UPDATE "OutreachEvent"
            SET "deliveredAt" = COALESCE("deliveredAt", $2),
                "sentAt"      = COALESCE("sentAt", $2),
                "emailStep"   = COALESCE($3, "emailStep"),
                "updatedAt"   = $2
          WHERE "id" = $1`,
        [row.id, now, p.step],
      );
      leadPatch = {
        sql: `UPDATE "Lead"
                 SET "campaignLastSentAt" = COALESCE("campaignLastSentAt", $2),
                     "currentEmailStep" = COALESCE($3, "currentEmailStep"),
                     "updatedAt" = $2
               WHERE "id" = $1`,
        params: [row.leadId, now, p.step],
      };
    } else if (kind === 'sent') {
      // Nothing about the outcome — only the facts of the send itself. sentAt is already
      // stamped by the push, so this confirms rather than creates.
      await client.query(
        `UPDATE "OutreachEvent"
            SET "sentAt" = COALESCE("sentAt", $2), "emailStep" = COALESCE($3, "emailStep"), "updatedAt" = $2
          WHERE "id" = $1`,
        [row.id, now, p.step],
      );
      leadPatch = {
        sql: `UPDATE "Lead"
                 SET "campaignLastSentAt" = $2,
                     "currentEmailStep" = COALESCE($3, "currentEmailStep"),
                     "updatedAt" = $2
               WHERE "id" = $1`,
        params: [row.leadId, now, p.step],
      };
    } else if (kind === 'click') {
      await client.query(
        `UPDATE "OutreachEvent"
            SET "clickedAt" = COALESCE("clickedAt", $2), "ctaAction" = COALESCE("ctaAction", $3), "updatedAt" = $2
          WHERE "id" = $1`,
        [row.id, now, p.replyText ?? null],
      );
      // A click is engagement too — it is the hot signal the outreach plan is built on.
      leadPatch = {
        sql: `UPDATE "Lead" SET "campaignStatus" = COALESCE(NULLIF("campaignStatus",'suppressed'), 'engaged'), "updatedAt" = $2 WHERE "id" = $1`,
        params: [row.leadId, now],
      };
    }

    if (leadPatch) await client.query(leadPatch.sql, leadPatch.params);

    /**
     * ── What was sent, captured from whichever event happens to carry it ──────
     * Tried on EVERY matched event, not only 'sent'. The vendor is inconsistent about
     * which payloads include the sending mailbox and the copy, so taking it wherever it
     * appears is the difference between a populated column and an empty one.
     *
     * COALESCE throughout: first write wins. The campaign's sequence can be edited after
     * the fact, so a later event carrying today's copy must not overwrite the copy this
     * person actually received.
     */
    if (p.sendingMailbox || p.subject || p.bodyHtml) {
      /**
       * The sending DOMAIN, split out from the mailbox.
       *
       * §6.3: "Our thresholds are written per mailbox and per domain, but the sheet has no
       * mailbox or domain column, so the formula can only evaluate a whole day's total. One
       * domain burning inside a healthy average will never trip it — precisely the failure
       * the pause exists to catch."
       *
       * Derived here rather than at report time because that is where the mailbox arrives,
       * and a report that has to parse an address to group by domain will eventually be
       * written by someone who forgets to.
       */
      const domain = p.sendingMailbox?.includes('@')
        ? p.sendingMailbox.split('@')[1]?.toLowerCase() ?? null
        : null;
      await client.query(
        `UPDATE "OutreachEvent"
            SET "sendingMailbox"    = COALESCE("sendingMailbox", $2),
                "sendingDomain"     = COALESCE("sendingDomain", $6),
                "emailSubject"      = COALESCE("emailSubject", $3),
                "emailBody"         = COALESCE("emailBody", $4),
                "contentCapturedAt" = COALESCE("contentCapturedAt", $5),
                "updatedAt" = $5
          WHERE "id" = $1`,
        [row.id, p.sendingMailbox, p.subject, htmlToText(p.bodyHtml), now, domain],
      );
    }

    /**
     * ── The version label, once the step is known ────────────────────────────
     *
     * The segment and the person's arm were stamped at push time; the email step only
     * arrives with the vendor's own event. So the readable label is assembled here, from
     * parts already stored, and written once.
     *
     * §6: "a reply recorded without knowing which version produced it can never be traced
     * back to one. That information does not exist later." This is the moment it exists.
     */
    const [ev] = (await client.query(
      `SELECT "segment","cohort","emailStep","subjectVariant","ctaVariant","versionLabel"
         FROM "OutreachEvent" WHERE "id" = $1`,
      [row.id],
    )).rows;
    if (ev && !ev.versionLabel && ev.segment && ev.cohort && ev.emailStep
        && ev.subjectVariant && ev.ctaVariant) {
      await client.query(
        `UPDATE "OutreachEvent" SET "versionLabel" = $2, "updatedAt" = $3 WHERE "id" = $1`,
        [row.id, versionLabel({
          segment: ev.segment as Segment,
          cohort: String(ev.cohort),
          step: Number(ev.emailStep),
          subjectVariant: ev.subjectVariant as 'A' | 'B',
          ctaArm: Number(ev.ctaVariant) as 1 | 2,
        }), now],
      );
    }

    /**
     * ── Household stop ────────────────────────────────────────────────────────
     * One answer ends the conversation for the whole card. A reply, a click on a CTA
     * or an unsubscribe/complaint from ANY address means every other address on that
     * property stops receiving the sequence, in the same transaction as the event that
     * caused it.
     *
     * Whoever engaged becomes the primary contact — the rule runs both ways, so a
     * co-insured who replies owns the conversation and the insured's addresses go
     * quiet, exactly as it would in reverse.
     *
     * An open is deliberately NOT a stop. Opens fire from scanners and prefetchers and
     * are the least trustworthy signal there is; stopping a household on one would
     * silently kill live outreach on a false positive.
     */
    let household: HouseholdStopResult | null = null;
    if (kind === 'reply' || kind === 'click' || kind === 'unsubscribe' || kind === 'complaint') {
      household = await stopHousehold(client, row.leadId, row.id, kind, p.email);

      // Only a positive signal makes someone the contact. An unsubscribe or a complaint
      // stops the household but must never mark that address as who to talk to.
      if (kind === 'reply' || kind === 'click') {
        await setPrimaryContact(client, row.leadId, p.email, row.personRole ?? 'insured', now);
      }
    }

    /**
     * ── Durable suppression (directive S2) ────────────────────────────────────
     * Everything above stops THIS campaign. stopHousehold works by removing the sibling
     * leads from the vendor, which halts the sequence and nothing else: the next cohort,
     * next year's renewal cycle and Ruben's call queue have never heard of it. S2 is
     * exactly that gap — "suppression persisted in the CRM, not only the email tool.
     * Currently captured and never stored."
     *
     * So the same event also writes a record that outlives the campaign. Scope is decided
     * by suppression.service from the REASON, not here, so a vendor's vocabulary can
     * never widen a dead mailbox into a dead household or narrow an opt-out into one
     * address. Written on the open transaction, so it cannot survive a rollback of the
     * event that caused it.
     */
    const lead = { id: row.leadId, addressStreet: row.addressStreet, addressZip: row.addressZip };
    let suppression: { scope: string; reason: string } | null = null;

    if (kind === 'unsubscribe' || kind === 'complaint') {
      const r = await suppressWithClient(client, {
        leadId: row.leadId, email: p.email, reason: kind,
        source: 'campaign_tool',
        note: `${kind} via campaign ${p.campaignId ?? '(unknown)'}`,
      });
      suppression = { scope: r.scope, reason: kind };
    } else if (kind === 'bounce') {
      /**
       * ADDRESS scope, never household — Sec. 12: "address flagged invalid and
       * suppressed, kept on record; next valid address used". The lead-level
       * campaignStatus written above is the older, blunter behaviour: it takes the whole
       * card out over one dead mailbox, so a household whose insured address bounced
       * loses its co-insured address too. This record is what the send list actually
       * reads, and it only removes the address that bounced.
       */
      const hard = String(p.bounceType ?? '').toLowerCase().includes('hard')
        || /(does not exist|no such user|unknown recipient|550)/i.test(String(p.bounceReason ?? ''));
      if (hard) {
        const r = await suppressWithClient(client, {
          leadId: row.leadId, email: p.email, reason: 'hard_bounce', source: 'campaign_tool',
          note: p.bounceReason ?? null,
        });
        suppression = { scope: r.scope, reason: 'hard_bounce' };
      }
    } else if (kind === 'reply' && isExplicitStopReply(p.replyText)) {
      /**
       * Sec. 7.6: a stop reply suppresses the household immediately. Only unmistakable
       * wording fires this — everything else waits for Ruben to classify, because a
       * missed auto-suppression is caught within the hour while a false one deletes a
       * live prospect silently.
       */
      const r = await suppressWithClient(client, {
        leadId: row.leadId, email: p.email, reason: 'not_interested',
        source: 'campaign_tool',
        note: 'explicit stop in reply text',
      });
      suppression = { scope: r.scope, reason: 'not_interested' };
    }

    /**
     * ── Confirmed address (Sec. 7.1) ──────────────────────────────────────────
     * "Once an address is confirmed by engagement, only that address receives email."
     * setPrimaryContact above marks it within the campaign; this writes it onto the CARD,
     * where the send list reads it and where it survives into the next renewal cycle —
     * Sec. 11.2's "engagement promotes a contact point permanently".
     *
     * Never on an open. Apple and Gmail auto-open, and E1 carries no pixel anyway.
     */
    if (kind === 'reply' || kind === 'click') {
      await client.query(
        `UPDATE "Lead"
            SET "confirmedEmail" = COALESCE("confirmedEmail", $2),
                "confirmedAt"    = COALESCE("confirmedAt", $3),
                "confirmedVia"   = COALESCE("confirmedVia", $4),
                "confirmedRole"  = COALESCE("confirmedRole", $5)
          WHERE "id" = $1`,
        [row.leadId, p.email, now, kind, row.personRole ?? 'insured'],
      );
    }

    // Activity feed: vendor-sourced activity reads the same as anything else.
    //
    // A 'sent' gets no entry. Every recipient on every step fires one, so on a 300-lead
    // cohort with a four-step sequence that is 1,200 rows of "we emailed them" burying
    // the handful of entries a producer actually needs to see. The send is already
    // recorded on the OutreachEvent, which is where a report reads it from.
    if (kind !== 'sent') await client.query(
      `INSERT INTO "Activity" ("id","leadId","type","content","createdBy","createdAt")
       VALUES (gen_random_uuid()::text, $1, 'campaign_event', $2, 'campaign platform', $3)`,
      [
        row.leadId,
        kind === 'reply'
          ? `Replied to campaign email${p.step ? ` (step ${p.step})` : ''}`
          : kind === 'bounce'
            ? `Campaign email bounced${p.bounceReason ? ` — ${String(p.bounceReason).slice(0, 120)}` : ''}`
            : kind === 'unsubscribe'
              ? 'Unsubscribed from campaign'
              : kind === 'complaint'
                ? 'Marked a campaign email as spam'
                : kind === 'click'
                  ? `Clicked a campaign link${p.step ? ` (step ${p.step})` : ''}`
                  : `Opened a campaign email${p.step ? ` (step ${p.step})` : ''}`,
        now,
      ],
    );

    // A stop is a thing that happened to the household, so it gets its own entry
    // rather than being buried inside the reply's. Someone reading the card needs to
    // see that the other addresses were cut off, and why.
    if (household && household.stopped > 0) {
      await client.query(
        `INSERT INTO "Activity" ("id","leadId","type","content","metadata","createdBy","createdAt")
         VALUES (gen_random_uuid()::text, $1, 'campaign_event', $2, $3, 'campaign platform', $4)`,
        [
          row.leadId,
          `Outreach stopped to ${household.stopped} other address${household.stopped === 1 ? '' : 'es'} on this household`
            + ` after ${p.email} ${kind === 'reply' ? 'replied' : kind === 'click' ? 'clicked' : kind === 'unsubscribe' ? 'unsubscribed' : 'complained'}`
            + (household.failedOnPlatform.length
              ? ` — ${household.failedOnPlatform.length} could not be removed from the campaign and may still send`
              : ''),
          JSON.stringify(household),
          now,
        ],
      );
    }

    await client.query('COMMIT');

    /**
     * ── Tell Ruben and Frank, after the commit ───────────────────────────────
     *
     * Frank, 29 Sep 2026: "as soon as an engagement, an email is sent to Ruben, he knows how
     * to get into the card, and it's pretty instantaneous... I have a feeling these may get
     * buried, so a good fail-safety is having them directly emailed to us."
     *
     * AFTER the commit, and never inside it. The reply is the thing that must survive; a
     * notification is a convenience on top of it. Holding a database transaction open across
     * a call to someone else's mail service would put the record of a homeowner's reply at
     * the mercy of that service being up.
     *
     * Not awaited into the response either — notifyEngagement swallows its own failures, and
     * the vendor retries this webhook on a 5xx, so a slow mail relay must not turn a
     * delivered reply into a redelivery.
     */
    if (kind === 'reply' || kind === 'click') {
      void notifyEngagement({
        leadId: row.leadId,
        kind,
        who: p.email,
        detail: kind === 'reply' ? (p.replyText ?? null) : null,
      });
    }

    return NextResponse.json({
      ok: true, matched: true, event: p.eventType, kind, leadId: row.leadId,
      household: household ?? undefined,
      // Echoed so a delivery log shows whether the event became durable, and at which
      // scope — the difference between a dead mailbox and a household that said stop.
      suppression: suppression ?? undefined,
    });
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    console.error('POST /api/webhooks/campaign error:', err);
    // 5xx so the vendor retries — nothing was marked processed.
    return NextResponse.json({ error: 'Webhook processing failed' }, { status: 500 });
  } finally {
    client.release();
  }
}
