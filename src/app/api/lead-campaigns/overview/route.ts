import { NextRequest, NextResponse } from 'next/server';
import { listCampaigns, getCampaign, getAllCampaignAnalytics, getLeadCountsByCampaign, CAMPAIGN_STATUS } from '@/lib/integrations/leadCampaign';
import { requireCampaignAccess, vendorError } from '@/lib/integrations/campaignAccess';

/**
 * GET /api/lead-campaigns/overview — the dashboard view: every campaign with its
 * counters.
 *
 * Analytics for ALL campaigns comes back from one upstream call, so this is two
 * requests total regardless of how many campaigns exist — merged here by id rather
 * than fetched per campaign.
 */
export async function GET(request: NextRequest) {
  const gate = await requireCampaignAccess(request);
  if ('response' in gate) return gate.response;

  try {
    // Three calls, not N+1: the campaign list, one analytics call covering every
    // campaign, and one pass over the workspace's leads grouped by campaign.
    const [campaigns, analytics, leadCounts] = await Promise.all([
      listCampaigns(),
      getAllCampaignAnalytics(),
      getLeadCountsByCampaign(),
    ]);
    const byId = new Map(analytics.map((a) => [a.campaign_id, a]));

    /**
     * ── Whether the campaign was even counting opens ───────────────────────
     *
     * A campaign with open tracking off reports 0 opens and a 0% rate, which is
     * indistinguishable on this screen from a campaign nobody opened. Five completed
     * campaigns and 928 sends read as total failures for that reason, and the blended
     * figure quoted from this list understated the real open rate by a third.
     *
     * The list endpoint does not return the flag — it comes back only on the individual
     * campaign — so each one is fetched. Fifteen small calls against a 6,000/min budget,
     * and the alternative is a screen that cannot tell nought from unmeasured.
     */
    const tracking = new Map<string, boolean | null>();
    await Promise.all(campaigns.map(async (c) => {
      try {
        const full = await getCampaign(c.id);
        tracking.set(c.id, full.open_tracking ?? null);
      } catch {
        // One campaign failing to load its settings must not empty the whole list —
        // null renders as "unknown", which is what it is.
        tracking.set(c.id, null);
      }
    }));

    const data = campaigns.map((c) => {
      const a = byId.get(c.id);
      const sent = a?.emails_sent_count ?? 0;
      // Rates are computed here so every surface reports them the same way. Percentages
      // are of emails SENT, not of leads — a lead that never got mailed should not drag
      // an open rate down. Always fed a UNIQUE counter: see the note where they are read.
      const rate = (n: number | undefined) => (sent > 0 ? Math.round(((n ?? 0) / sent) * 1000) / 10 : null);
      // Lead count comes from the real lead list, NOT analytics. Analytics omits
      // campaigns with no send activity altogether, so a draft holding 300 leads
      // used to read "0 leads" — indistinguishable from a failed import. Analytics
      // still owns the engagement counters, which it is the only source for.
      const counted = leadCounts.counts.get(c.id) ?? 0;
      return {
        id: c.id,
        name: c.name,
        status: c.status,
        statusLabel: CAMPAIGN_STATUS[c.status] ?? `Status ${c.status}`,
        // When the campaign was made, not when it was switched on. The gap between the two
        // is what made the sequence fire both steps at once on 2 Oct, so it is worth seeing.
        createdAt: c.timestamp_created ?? null,
        leads: Math.max(counted, a?.leads_count ?? 0),
        leadsTruncated: leadCounts.truncated,
        contacted: a?.contacted_count ?? 0,
        /**
         * How far through the sequence the campaign is, matching the platform's own bar.
         *
         * completed_count is people who have reached the END of the sequence, not emails
         * sent — which is why it is the right number and `sent` is not. A two-step campaign
         * sends twice per person, so "sent" passes the lead count halfway through and reads
         * as over 100% done. On 2 Oct one campaign showed 53 leads against 93 sent, which is
         * the question this column exists to answer.
         *
         * Verified against the platform's own display: 40 completed of 53 leads shows there
         * as 75%, and completed/leads gives exactly that.
         */
        completed: a?.completed_count ?? 0,
        sent,
        /*
         * People, not events — and the rate is built on the same number shown beside it.
         *
         * These were the TOTAL counters while a campaign's own page used the UNIQUE ones,
         * so the same campaign read higher here than on its own page whenever one person
         * opened twice. Same label, two definitions: exactly the fault the handbook's
         * Part 7 is about. Unique is the honest answer to "how many people opened", and
         * it is what the rest of the CRM counts, so the list now agrees with the page.
         *
         * The totals are still published beside them for anyone who wants raw volume.
         */
        opens: a?.open_count_unique ?? 0,
        replies: a?.reply_count_unique ?? 0,
        clicks: a?.link_click_count_unique ?? 0,
        totalOpens: a?.open_count ?? 0,
        totalReplies: a?.reply_count ?? 0,
        totalClicks: a?.link_click_count ?? 0,
        bounced: a?.bounced_count ?? 0,
        unsubscribed: a?.unsubscribed_count ?? 0,
        /*
         * Null, not zero, when the campaign was not tracking.
         *
         * Zero is a measurement. A campaign with tracking off made no measurement, and
         * the screen has to be able to say so rather than publish a nought somebody will
         * average into a total.
         */
        openTracking: tracking.get(c.id) ?? null,
        openRate: tracking.get(c.id) === false ? null : rate(a?.open_count_unique),
        replyRate: rate(a?.reply_count_unique),
        // A bounce is already one per recipient, so there is no unique variant to prefer.
        bounceRate: rate(a?.bounced_count),
      };
    });

    return NextResponse.json({ success: true, count: data.length, data });
  } catch (err) {
    return vendorError(err, 'Could not load campaign analytics');
  }
}
