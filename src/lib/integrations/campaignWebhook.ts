import crypto from 'crypto';
import { htmlToPlainLines, splitQuotedReply } from '@/lib/replyBody';

/**
 * Inbound campaign-webhook verification and payload normalisation.
 *
 * The vendor does not sign its webhook payloads — there is no HMAC scheme to verify
 * against — so authentication is a shared static secret configured by hand in the
 * vendor's dashboard and sent back on every request as a custom header.
 */

export const WEBHOOK_HEADER = 'x-bia-campaign-key';

/**
 * The same secret, accepted from the query string.
 *
 * The campaign tool's webhook UI offers a URL and nothing else — no custom-header field. A header
 * we cannot send is a 401 on every delivery, and the dashboard would keep showing the
 * webhook as "Active" the whole time, because from its side the request left successfully.
 * That is a silent integration failure, which is the worst kind: replies would arrive,
 * be rejected, and nobody would know until a customer complained about being chased after
 * they had already answered.
 *
 * The header remains the preferred form and is tried first. A secret in a query string is
 * weaker — URLs end up in access logs and proxy traces in a way headers usually do not —
 * so it is a fallback for tools that cannot do better, not the default, and it is one more
 * reason this key should be rotated on a schedule.
 */
export const WEBHOOK_QUERY_PARAM = 'key';

/**
 * Constant-time comparison, never `===`: a plain string compare short-circuits on the
 * first differing byte and leaks the secret one character at a time to anyone who can
 * measure response time.
 *
 * Fails CLOSED in production when the secret is unset — an unconfigured deploy must
 * refuse traffic rather than accept anything that arrives. Fails open only in local
 * dev, loudly, so testing is not blocked by a missing env var.
 */
export function verifyWebhookSecret(headerValue: string | null, queryValue?: string | null): boolean {
  const expected = process.env.LEADS_CAMPAIGN_WEBHOOK_KEY;
  if (!expected) {
    if (process.env.NODE_ENV === 'production') return false;
    console.warn('[campaign-webhook] no secret configured — allowing through (dev only)');
    return true;
  }
  // Header first, query string only if the header is absent — a tool that can send the
  // header should never fall back to the weaker form just because it also set a param.
  const presented = headerValue ?? queryValue ?? null;
  if (!presented) return false;
  const a = Buffer.from(presented);
  const b = Buffer.from(expected);
  // timingSafeEqual throws on a length mismatch, so the length check has to come first.
  // Length is not secret; the bytes are.
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

export type OutcomeKind =
  | 'reply' | 'bounce' | 'open' | 'click' | 'unsubscribe' | 'complaint'
  | 'sent' | 'delivered' | null;

/**
 * Classify the event.
 *
 * Substring matching, not an exact enum: vendors label these inconsistently between
 * their docs, their dashboard and the payloads they actually send (`reply_received`,
 * `email_replied`, `lead_replied` all mean the same thing). An exact match silently
 * drops events when the vendor renames one, and a dropped reply means we keep mailing
 * somebody who already answered.
 */
export function classifyEvent(eventType: string | null | undefined): OutcomeKind {
  const e = String(eventType ?? '').toLowerCase();
  if (!e) return null;
  if (e.includes('unsubscrib')) return 'unsubscribe';   // before "sent"/"sub" confusion
  if (e.includes('complain') || e.includes('spam')) return 'complaint';
  if (e.includes('repl')) return 'reply';
  if (e.includes('bounc')) return 'bounce';
  if (e.includes('click')) return 'click';
  if (e.includes('open')) return 'open';
  /**
   * Delivered is NOT the same event as sent, and folding the two lost the only one that
   * matters most.
   *
   * They were classified together, so a delivery event was handled as a send and
   * "deliveredAt" was never written by anything, anywhere. Sec 10.7 measures engagement ON
   * DELIVERED — "Engagement measured on delivered" — so the engagement rate, its 27%
   * target and the 18% floor that triggers the Pivot Plan all rested on a column nothing
   * populated. The dashboard would have read zero delivered forever and nobody would have
   * had a reason to doubt it.
   *
   * Checked before 'sent' because vendors label these "email_delivered", which contains
   * both words.
   */
  if (e.includes('deliver')) return 'delivered';
  if (e.includes('sent')) return 'sent';
  return null;
}

/** Vendors differ on where the useful fields sit; read several shapes. */
export function readPayload(body: any) {
  const pick = (...keys: string[]): string | null => {
    for (const k of keys) {
      const v = k.split('.').reduce<any>((o, part) => (o == null ? o : o[part]), body);
      if (typeof v === 'string' && v.trim()) return v.trim();
      if (typeof v === 'number') return String(v);
    }
    return null;
  };
  const stepRaw = pick('step', 'email_step', 'sequence_step', 'lead.step');
  const step = stepRaw != null && /^\d+$/.test(stepRaw) ? Number(stepRaw) : null;
  return {
    eventType: pick('event_type', 'eventType', 'type', 'event'),
    email: (pick('lead_email', 'email', 'lead.email', 'to_address_email_list') ?? '').toLowerCase() || null,
    campaignId: pick('campaign_id', 'campaignId', 'campaign.id', 'campaign'),
    vendorLeadId: pick('lead_id', 'leadId', 'lead.id'),
    step,
    replyText: pick('reply_text', 'reply_text_snippet', 'body.text', 'text', 'message', 'reply_html'),
    bounceReason: pick('bounce_reason', 'reason', 'error', 'detail'),
    bounceType: pick('bounce_type', 'bounceType'),

    /**
     * Which mailbox actually sent it. Not our choice at push time — the platform picks
     * from the campaign's pool at send time — so this is the only moment it is knowable
     * from a webhook, and a per-mailbox report has no other source.
     *
     * Several spellings because the vendor is inconsistent about this field between its
     * docs and its payloads, and the cost of missing it is a silently empty column. If
     * none of these arrive the value is simply null and the /emails reconciliation fills
     * it in later — see campaignContent.service.ts.
     */
    sendingMailbox: (pick(
      'from_address_email', 'from_email', 'fromAddressEmail',
      'email_account', 'account_email', 'sending_account', 'from',
    ) ?? '').toLowerCase() || null,

    /** The copy as delivered. The campaign's sequence can be edited afterwards, so the
     *  live campaign is NOT a record of what this person received. */
    subject: pick('email_subject', 'subject', 'title'),
    bodyHtml: pick('email_body', 'body.html', 'body.text', 'html', 'content'),
  };
}

/**
 * HTML → readable plain text. Nothing is removed except markup.
 *
 * This is what OUTBOUND copy gets. It deliberately does not run the reply trimming
 * below: that cuts at a signature delimiter and at "From:" lines, which in an inbound
 * reply is quoted history but in our own campaign copy is the copy — trimming it would
 * silently store a truncated record of what the homeowner was sent.
 */
export function htmlToText(raw: string | null, max = 2000): string | null {
  if (!raw) return null;
  const text = htmlToPlainLines(raw).trim();
  if (!text) return null;
  return text.length > max ? `${text.slice(0, max - 1)}…` : text;
}

/**
 * Strip quoted history and signature blocks so the stored excerpt is what the person
 * actually wrote, not their reply plus our own email underneath it.
 */
export function cleanReplyExcerpt(raw: string | null, max = 500): string | null {
  if (!raw) return null;
  /*
   * The marker list used to live here, and it matched `^\s*On .+ wrote:` — which misses
   * the attribution line Apple Mail writes INSIDE the quote block, because `\s` does not
   * match ">". Both halves are shared with the reply inbox now, so the stored excerpt and
   * the screen cut at the same place. See src/lib/replyBody.ts.
   *
   * replyText prefers the payload's plain text and falls back to the HTML, so both shapes
   * arrive here; the strip is a no-op on text that carries no markup.
   */
  const text = splitQuotedReply(htmlToPlainLines(raw)).body.replace(/\s+/g, ' ').trim();
  if (!text) return null;
  return text.length > max ? `${text.slice(0, max - 1)}…` : text;
}
