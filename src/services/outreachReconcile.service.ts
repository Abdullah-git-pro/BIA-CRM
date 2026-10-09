import { sql } from '@/lib/neon';
import { listLeadsInCampaign, deleteLead, listCampaigns, type VendorLead } from '@/lib/integrations/leadCampaign';
import { loadActiveSuppressions } from './suppression.service';
import { householdScopeKey } from './household.service';
import { isRunFatal, VendorError } from './vendorErrors';

/**
 * Make the sending platform agree with the CRM (directive Sec. 11.5, question 4).
 *
 * ── The gap this closes ─────────────────────────────────────────────────────
 * When a homeowner engages, stopHousehold() marks the siblings stopped in our own
 * database inside a transaction — that part is atomic and reliable — and then calls the
 * platform to remove each one. Removal is the only mechanism that provably halts sends:
 * the vendor has no pause-one-lead endpoint (verified live, /leads/{id}/pause is "Route
 * not found" and PATCH silently discards `status`).
 *
 * If that removal call fails, it is recorded in `failedOnPlatform` and returned to the
 * caller — and then nothing ever happens again. The CRM shows the address as stopped.
 * The platform keeps sending to it. Nobody finds out until the homeowner complains
 * about being chased after they already replied.
 *
 * That is not a bug in stopHousehold; recording first and removing second is the right
 * way round. It is a missing second half. This is the second half.
 *
 * ── What "converged" means here ─────────────────────────────────────────────
 * The honest promise is not "instantly". It is: whatever the platform thinks right now,
 * within one sweep it will agree with us about who must stop. A weaker claim that is
 * actually true beats a stronger one that is true most of the time — the failure mode of
 * the stronger claim is a customer receiving mail we told them we had stopped.
 *
 * ── What this will NOT do ───────────────────────────────────────────────────
 * Removal is destructive and irreversible on the vendor's side. So this only ever removes
 * a recipient the CRM can point at a reason for: an OutreachEvent already marked stopped,
 * or an active Suppression covering that address or its household.
 *
 * A live recipient the CRM has never heard of is REPORTED and left alone. It could be a
 * manual add, another team's test, or our own row that failed to write — and deleting
 * somebody else's campaign members because our database looks empty is a far worse
 * outcome than a stale recipient. `unknown` exists to be looked at, not acted on.
 */

export type ReconcileFindingKind =
  /** Marked stopped here; the platform still has them. The failed-removal case. */
  | 'stopped_here_live_there'
  /** Under an active suppression here; the platform still has them. */
  | 'suppressed_here_live_there'
  /** Live on the platform, no OutreachEvent row. Reported only, never removed. */
  | 'live_there_unknown_here';

export type ReconcileFinding = {
  kind: ReconcileFindingKind;
  campaignId: string;
  email: string;
  vendorLeadId: string;
  leadId: string | null;
  /** Why it should have stopped, in words — shown in the report. */
  reason: string;
  /** Only set once an apply run has acted on it. */
  removed?: boolean;
  error?: string;
};

export type ReconcileResult = {
  dryRun: boolean;
  /** Campaigns inspected. */
  campaigns: string[];
  /** Live recipients seen across those campaigns. */
  vendorRecipients: number;
  findings: ReconcileFinding[];
  /** Actually removed from the platform this run. */
  removed: number;
  /** Should have been removed and could not be — the next sweep tries again. */
  failed: number;
  /** Live there, and matching no CRM lead at all. Reported, never touched. */
  unknown: number;
  /**
   * Live there with no CRM send record, but matching a lead — a row was written so replies
   * from that address reach the CRM. However a contact got into the campaign.
   */
  registered: number;
  /** Set when the run ended itself: bad key, or the vendor refusing. */
  stopped: { reason: 'auth' | 'no_credits' | 'vendor_error'; vendor: string; detail: string } | null;
  ranAt: string;
};

/** Every campaign the CRM has actually pushed to. */
/**
 * Every campaign worth sweeping — ours AND the platform's.
 *
 * This asked the CRM alone: "which campaign ids appear in OutreachEvent". That makes a
 * campaign the CRM has never seen completely invisible, which is exactly the campaign that
 * needs looking at. A list uploaded by hand into a fresh campaign produces no OutreachEvent
 * rows, so the sweep did not know the campaign existed, so it never noticed the rows were
 * missing — the gap hid itself.
 *
 * The platform's own list is the truth about what campaigns exist. If it cannot be read, the
 * CRM's ids are still swept rather than sweeping nothing.
 */
async function knownCampaignIds(
  listAll?: () => Promise<Array<{ id: string }>>,
): Promise<string[]> {
  const rows = await sql`
    SELECT DISTINCT "vendorCampaignId" AS id
      FROM "OutreachEvent"
     WHERE "vendorCampaignId" IS NOT NULL AND "vendorCampaignId" <> ''` as Array<{ id: string }>;
  const ids = new Set(rows.map((r) => r.id));
  try {
    for (const c of await (listAll ?? listCampaigns)()) if (c.id) ids.add(c.id);
  } catch {
    /* The platform is unreadable; sweep what we know rather than nothing. */
  }
  return [...ids];
}

type EventRow = {
  id: string;
  leadId: string;
  recipientEmail: string;
  vendorLeadId: string | null;
  vendorCampaignId: string;
  stoppedAt: Date | null;
  stoppedReason: string | null;
  /**
   * The stored household (migration 034), with the address-derived key as a fallback for
   * a lead a pull has just created and materialiseHouseholds has not reached yet.
   *
   * It used to be derived here, always. That was wrong twice: it disagreed with the key
   * a suppression was recorded under whenever a household spanned two properties, and the
   * derivation itself was not stable — the union-find dropped roughly half its unions
   * depending on row order, so the same lead could land in a different household between
   * two reads.
   */
  householdKey: string | null;
};

/** Our side of the picture for one campaign, keyed both ways a vendor row can be matched. */
async function eventsForCampaign(campaignId: string) {
  const raw = await sql`
    SELECT e."id", e."leadId", LOWER(e."recipientEmail") AS "recipientEmail",
           e."vendorLeadId", e."vendorCampaignId", e."stoppedAt", e."stoppedReason",
           l."householdId", l."addressStreet", l."addressZip"
      FROM "OutreachEvent" e
      LEFT JOIN "Lead" l ON l."id" = e."leadId"
     WHERE e."vendorCampaignId" = ${campaignId}` as Array<
       Omit<EventRow, 'householdKey'> & {
         householdId: string | null;
         addressStreet: string | null;
         addressZip: string | null;
       }
     >;

  // householdScopeKey, the same function the suppression writer calls, so the key looked
  // up here is the key that was stored. Computing it a second way is how a household stop
  // comes to cover some of a household and not the rest.
  const rows: EventRow[] = raw.map(({ householdId, addressStreet, addressZip, ...e }) => ({
    ...e,
    householdKey: householdId || (addressStreet && addressZip
      ? householdScopeKey({ id: e.leadId, addressStreet, addressZip })
      : null),
  }));

  const byVendorLeadId = new Map<string, EventRow>();
  const byEmail = new Map<string, EventRow>();
  for (const r of rows) {
    if (r.vendorLeadId) byVendorLeadId.set(r.vendorLeadId, r);
    // First row wins: a recipient with several events is the same person either way, and
    // the stopped flag is read from whichever row carries it (checked below).
    if (!byEmail.has(r.recipientEmail)) byEmail.set(r.recipientEmail, r);
  }
  // A recipient counts as stopped if ANY of their events is stopped — the stop is about
  // the person, not about one send.
  const stoppedEmails = new Set(rows.filter((r) => r.stoppedAt).map((r) => r.recipientEmail));
  return { rows, byVendorLeadId, byEmail, stoppedEmails };
}

/**
 * Compare the platform against the CRM and, unless `dryRun`, correct it.
 *
 * Safe to run repeatedly and safe to run concurrently with a send: removing a recipient
 * the CRM has already marked stopped is idempotent, and a second sweep over the same
 * campaign simply finds nothing to do.
 */
export async function reconcileOutreach(opts?: {
  dryRun?: boolean;
  /** Restrict to one campaign; defaults to every campaign the CRM has pushed to. */
  campaignId?: string;
  /** Hard ceiling on removals in one sweep, so a bad diff cannot empty a campaign. */
  maxRemovals?: number;
  /**
   * The two vendor calls, injectable.
   *
   * Not a testing flourish: the decision table below is the part worth testing — who gets
   * removed and who is left alone — and the only way to construct "the platform still has
   * somebody we stopped" is to say what the platform has. ES module namespaces are frozen,
   * so a test cannot stub the import; without a seam here the branches that matter could
   * only be exercised against a live campaign, by deleting real recipients from it.
   */
  deps?: {
    listLive?: (campaignId: string) => Promise<VendorLead[]>;
    remove?: (vendorLeadId: string) => Promise<void>;
  };
}): Promise<ReconcileResult> {
  const dryRun = opts?.dryRun ?? true;
  const maxRemovals = opts?.maxRemovals ?? 200;
  const listLive = opts?.deps?.listLive ?? listLeadsInCampaign;
  const remove = opts?.deps?.remove ?? deleteLead;

  const campaigns = opts?.campaignId ? [opts.campaignId] : await knownCampaignIds();
  const out: ReconcileResult = {
    dryRun, campaigns, vendorRecipients: 0, findings: [],
    removed: 0, failed: 0, unknown: 0, registered: 0, stopped: null,
    ranAt: new Date().toISOString(),
  };
  if (!campaigns.length) return out;

  const sup = await loadActiveSuppressions();

  for (const campaignId of campaigns) {
    let live: VendorLead[];
    try {
      live = await listLive(campaignId);
    } catch (err: any) {
      // A campaign that cannot be read is not a campaign with nothing in it. Say so and
      // move on rather than reporting a clean sweep over a campaign we never saw.
      out.findings.push({
        kind: 'live_there_unknown_here', campaignId, email: '—', vendorLeadId: '—',
        leadId: null, reason: `could not read this campaign: ${err?.message ?? 'unknown error'}`,
      });
      if (isRunFatal(err)) {
        const e = err as VendorError;
        out.stopped = { reason: e.fault === 'auth' ? 'auth' : 'no_credits', vendor: e.vendor, detail: e.detail };
        break;
      }
      continue;
    }

    out.vendorRecipients += live.length;
    const ours = await eventsForCampaign(campaignId);

    for (const v of live) {
      const email = String(v.email ?? '').toLowerCase().trim();
      if (!email) continue;

      const ev = (v.id && ours.byVendorLeadId.get(v.id)) || ours.byEmail.get(email) || null;

      // 1. We stopped them. The platform did not get the message.
      if (ev && ours.stoppedEmails.has(email)) {
        out.findings.push({
          kind: 'stopped_here_live_there', campaignId, email, vendorLeadId: v.id,
          leadId: ev.leadId,
          reason: ev.stoppedReason || 'stopped in the CRM',
        });
        continue;
      }

      // 2. They are suppressed — by address, or by their household.
      const hk = ev?.householdKey ?? null;
      const hit = sup.byEmail.get(email) ?? (hk ? sup.byHousehold.get(hk) : undefined);
      if (hit) {
        out.findings.push({
          kind: 'suppressed_here_live_there', campaignId, email, vendorLeadId: v.id,
          leadId: ev?.leadId ?? null,
          reason: `suppressed (${hit.scope}): ${hit.reason}`,
        });
        continue;
      }

      /**
       * 3. Live there, nothing here — REGISTER it.
       *
       * This used to be counted and left alone, and the header explained why: the action
       * being considered was deleting a live recipient, which is not something a sweep
       * should decide.
       *
       * Registering is the opposite kind of act. It writes a CRM record so a reply from that
       * address has somewhere to land; it touches nothing on the platform and stops nothing.
       * Leaving it undone is what actually costs something — the platform reports a reply as
       * an address and an event, the CRM finds no row, and the reply is discarded with a 200
       * and no log. The homeowner is waiting for an answer nobody knows to give.
       *
       * So however a contact reaches a campaign — our push, a CSV upload, somebody typing it
       * in — it is recorded within one sweep. Nobody has to remember a step.
       *
       * An address that matches no CRM lead is still only reported. There is nothing to
       * attach it to, and inventing a lead to hold a stranger's address would be worse than
       * the gap.
       */
      if (!ev) {
        /*
         * The cohort and propertyId come back with the match, because the row written
         * below has to carry them.
         *
         * It did not, and nothing noticed for a fortnight: 1,918 of 2,104 outreach events
         * were written here with a null cohort and a null propertyId, which took them out
         * of the Outreach screen's by-week table entirely. It showed 47 leads loaded on C1
         * against a true 160, and no row at all for C4 onward. personRole carries
         * DEFAULT 'insured', so every one of them also claimed to be a send to the
         * insured — including the co-insured's addresses.
         */
        const [match] = await sql`
          SELECT "id", "propertyId", "cohort",
                 (lower("owner2Email") = ${email}
                  AND lower(COALESCE("email1", '')) <> ${email}
                  AND lower(COALESCE("email2", '')) <> ${email}) AS is_co_insured
            FROM "Lead"
           WHERE lower("email1") = ${email} OR lower("email2") = ${email}
              OR lower("owner2Email") = ${email}
           LIMIT 1` as Array<{ id: string; propertyId: string | null; cohort: string | null; is_co_insured: boolean }>;

        if (!match) {
          out.unknown++;
          out.findings.push({
            kind: 'live_there_unknown_here', campaignId, email, vendorLeadId: v.id,
            leadId: null,
            reason: 'on the platform and matches no CRM lead — nothing to attach a reply to',
          });
          continue;
        }

        if (!dryRun) {
          /**
           * sentAt stays NULL. The column carries DEFAULT now(), and a row claiming a send
           * would report an email this sweep has no evidence was ever posted.
           */
          await sql`
            INSERT INTO "OutreachEvent"
              ("id","leadId","propertyId","cohort","personRole","recipientEmail","channel",
               "vendorLeadId","vendorCampaignId","sentAt","createdAt","updatedAt")
            VALUES (${crypto.randomUUID()}, ${match.id}, ${match.propertyId ?? null},
                    ${match.cohort ?? null},
                    -- Written, not left to the column default, which is 'insured'.
                    ${match.is_co_insured ? 'coinsured' : 'insured'},
                    ${email}, 'campaign',
                    ${v.id ?? null}, ${campaignId}, NULL, NOW(), NOW())`;
        }
        out.registered++;
        out.findings.push({
          kind: 'live_there_unknown_here', campaignId, email, vendorLeadId: v.id,
          leadId: match.id,
          reason: dryRun
            ? 'on the platform with no send record — would be registered so replies route'
            : 'registered — replies from this address now reach the CRM',
        });
      }
    }
  }

  const actionable = out.findings.filter(
    (f) => f.kind === 'stopped_here_live_there' || f.kind === 'suppressed_here_live_there',
  );

  if (dryRun || out.stopped) return out;

  /**
   * A diff this large is far more likely to be a bug on our side — an empty
   * OutreachEvent table, a campaign id that changed — than a real backlog of stops. Stop
   * and report rather than deleting a campaign's worth of recipients on the strength of
   * it. The next sweep runs in fifteen minutes; nothing is lost by pausing to look.
   */
  if (actionable.length > maxRemovals) {
    out.stopped = {
      reason: 'vendor_error',
      vendor: 'reconcile',
      detail: `${actionable.length} recipients would be removed, over the ${maxRemovals} ceiling — `
        + 'refusing to act until someone confirms this is real.',
    };
    return out;
  }

  for (const f of actionable) {
    try {
      await remove(f.vendorLeadId);
      f.removed = true;
      out.removed++;

      // Stamp the stop for anything suppression caught, so the CRM stops re-finding it
      // every sweep and the reason lands on the row rather than only in a log.
      if (f.kind === 'suppressed_here_live_there' && f.leadId) {
        await sql`
          UPDATE "OutreachEvent"
             SET "stoppedAt" = COALESCE("stoppedAt", NOW()),
                 "stoppedReason" = COALESCE("stoppedReason", ${f.reason}),
                 "stoppedBy" = COALESCE("stoppedBy", 'reconcile'),
                 "updatedAt" = NOW()
           WHERE "vendorCampaignId" = ${f.campaignId}
             AND LOWER("recipientEmail") = ${f.email}
             AND "stoppedAt" IS NULL`;
      }
    } catch (err: any) {
      f.removed = false;
      f.error = err?.message ?? 'removal failed';
      out.failed++;
      if (isRunFatal(err)) {
        const e = err as VendorError;
        out.stopped = { reason: e.fault === 'auth' ? 'auth' : 'no_credits', vendor: e.vendor, detail: e.detail };
        break;
      }
    }
  }

  return out;
}

/** One line for a log or a Slack message. */
export function summarise(r: ReconcileResult): string {
  const a = r.findings.filter((f) => f.kind !== 'live_there_unknown_here').length;
  return [
    `${r.dryRun ? 'would correct' : 'corrected'} ${r.dryRun ? a : r.removed}`,
    `of ${r.vendorRecipients} live recipient(s)`,
    `across ${r.campaigns.length} campaign(s)`,
    r.failed ? `· ${r.failed} failed, retried next sweep` : '',
    r.unknown ? `· ${r.unknown} unknown to the CRM, not touched` : '',
    r.stopped ? `· STOPPED: ${r.stopped.detail}` : '',
  ].filter(Boolean).join(' ');
}
