import crypto from 'crypto';
import { pool } from '@/lib/neon';
import { pauseCampaign } from '@/lib/integrations/leadCampaign';

/**
 * The four protective metrics — playbook §08.
 *
 * "These four can destroy the sending infrastructure in a single day. They are monitored
 * daily and enforced by the system, not by anyone's judgment. A breach pauses sending
 * automatically; restarting requires Frank's sign-off."
 *
 * The point of automatic enforcement is that the decision is made BEFORE the numbers are
 * known. A person looking at a 0.4% complaint rate on a campaign that is finally producing
 * replies will find a reason to let it run one more day, and Gmail will not care.
 */

export type MetricKey = 'bounce_rate' | 'complaint_rate' | 'unsubscribe_rate' | 'inbox_placement';

type Spec = {
  key: MetricKey;
  label: string;
  target: number;
  pauseAt: number;
  /** true when a HIGHER number is worse (rates); false for placement. */
  higherIsWorse: boolean;
  note: string;
};

export const SPECS: Spec[] = [
  {
    key: 'bounce_rate', label: 'Bounce rate', target: 2, pauseAt: 5, higherIsWorse: true,
    note: 'Should be near zero once addresses are verified. Higher means the list is worse than we think.',
  },
  {
    key: 'complaint_rate', label: 'Spam complaint rate', target: 0.1, pauseAt: 0.3, higherIsWorse: true,
    note: "Gmail's enforcement threshold. Crossing it compromises every mailbox at once, not just the one that sent.",
  },
  {
    key: 'unsubscribe_rate', label: 'Unsubscribe rate', target: 0.5, pauseAt: 1, higherIsWorse: true,
    note: 'A message-market signal, not a compliance stat. Rising means the argument is wrong, not that the list is bad.',
  },
  {
    key: 'inbox_placement', label: 'Inbox placement', target: 80, pauseAt: 75, higherIsWorse: false,
    note: 'Seed-list test, weekly minimum, per domain and mailbox. An aggregate hides which mailbox is burning.',
  },
];

/**
 * The smallest denominator at which a rate may be ENFORCED.
 *
 * Set so a single event cannot on its own breach the threshold: ceil(100 / pauseAt). At
 * 0.3%, that is 334 sends — which matches §07's instruction not to compute a complaint
 * rate at n≈250. Below this the rate is still reported, but as indicative, and a breach
 * does not pause.
 *
 * This is NOT permission to ignore a complaint at low volume. §07: "Treat any complaint as
 * serious. Do not compute a rate at this n." Those are two different instructions and the
 * result carries both — `needsAttention` fires on any complaint at all.
 */
export const minVolumeFor = (pauseAt: number) => Math.ceil(100 / pauseAt);

export type MetricReading = {
  key: MetricKey;
  label: string;
  value: number | null;
  /** How many sends the rate was computed over; null for placement. */
  sampleSize: number | null;
  numerator: number | null;
  target: number;
  pauseAt: number;
  /** Past the pause threshold AND over the minimum volume. */
  breached: boolean;
  /** Past the threshold but under the minimum volume — report, do not enforce. */
  indicative: boolean;
  /** Something a human should look at even though no rule fired. */
  needsAttention: string | null;
  note: string;
};

export type MetricsReport = {
  windowDays: number;
  sent: number;
  readings: MetricReading[];
  /** Per sending mailbox — "an aggregate number hides which mailbox is burning". */
  byMailbox: Array<{ mailbox: string; sent: number; bounces: number; complaints: number; unsubscribes: number }>;
  breaches: MetricReading[];
};

/**
 * Compute the three rates from our own send log, plus the latest placement reading.
 *
 * Window-based rather than all-time: a campaign that sent badly in October and well since
 * should not be permanently paused by history, and §08 calls these DAILY metrics.
 */
export async function computeMetrics(
  opts: { windowDays?: number; campaignId?: string } = {},
): Promise<MetricsReport> {
  const windowDays = opts.windowDays ?? 7;
  const params: unknown[] = [windowDays];
  let scope = '';
  if (opts.campaignId) { params.push(opts.campaignId); scope = `AND "vendorCampaignId" = $2`; }

  const { rows } = await pool.query(
    `SELECT
       COUNT(*) FILTER (WHERE "sentAt" IS NOT NULL)::int                       AS sent,
       COUNT(*) FILTER (WHERE "bouncedAt" IS NOT NULL)::int                    AS bounces,
       COUNT(*) FILTER (WHERE "complainedAt" IS NOT NULL)::int                 AS complaints,
       COUNT(*) FILTER (WHERE "unsubscribedAt" IS NOT NULL)::int               AS unsubscribes
     FROM "OutreachEvent"
     WHERE "sentAt" >= NOW() - ($1 || ' days')::interval ${scope}`,
    params,
  );
  const t = rows[0] ?? { sent: 0, bounces: 0, complaints: 0, unsubscribes: 0 };
  const sent: number = t.sent ?? 0;

  const { rows: byMailbox } = await pool.query(
    `SELECT COALESCE("sendingMailbox", '(unknown)')                AS mailbox,
            COUNT(*) FILTER (WHERE "sentAt" IS NOT NULL)::int      AS sent,
            COUNT(*) FILTER (WHERE "bouncedAt" IS NOT NULL)::int   AS bounces,
            COUNT(*) FILTER (WHERE "complainedAt" IS NOT NULL)::int AS complaints,
            COUNT(*) FILTER (WHERE "unsubscribedAt" IS NOT NULL)::int AS unsubscribes
       FROM "OutreachEvent"
      WHERE "sentAt" >= NOW() - ($1 || ' days')::interval ${scope}
      GROUP BY 1 ORDER BY 2 DESC`,
    params,
  );

  // Latest placement reading, whatever its age. A stale reading is still the only one we
  // have; the caller is told how old it is rather than shown nothing.
  const { rows: placement } = await pool.query(
    `SELECT "primaryPct", "measuredAt", "tool" FROM "InboxPlacement"
      WHERE "domain" IS NULL AND "mailbox" IS NULL
      ORDER BY "measuredAt" DESC LIMIT 1`,
  );

  const rate = (n: number) => (sent > 0 ? (n / sent) * 100 : null);

  const readings: MetricReading[] = SPECS.map((spec) => {
    if (spec.key === 'inbox_placement') {
      const p = placement[0];
      const value = p ? Number(p.primaryPct) : null;
      const ageDays = p ? Math.floor((Date.now() - new Date(p.measuredAt).getTime()) / 86_400_000) : null;
      return {
        key: spec.key, label: spec.label, value, sampleSize: null, numerator: null,
        target: spec.target, pauseAt: spec.pauseAt,
        breached: value != null && value < spec.pauseAt,
        indicative: false,
        // No reading is NOT a pass. §02 makes placement a gate on sending at all, so the
        // absence of a measurement is itself the thing to escalate.
        /*
         * The message names the step that is actually missing.
         *
         * It used to say "no seed tool has been agreed (register A27)". A27 closed on
         * 6 Oct 2026 — the tool is chosen, connected and reading — so that sentence sent
         * whoever saw it to settle a question that was already settled, while the real
         * blocker went unnamed.
         */
        needsAttention: value == null
          ? 'No inbox-placement reading has been recorded yet. §02 makes this a gate on sending. '
            + "The seed tool is connected; add each project's autotest address to a campaign "
            + 'restricted to that domain’s mailboxes, then pull the readings.'
          : (ageDays != null && ageDays > 7 ? `Last reading is ${ageDays} days old; §08 requires a weekly minimum.` : null),
        note: spec.note,
      };
    }

    const numerator =
      spec.key === 'bounce_rate' ? (t.bounces ?? 0)
        : spec.key === 'complaint_rate' ? (t.complaints ?? 0)
          : (t.unsubscribes ?? 0);
    const value = rate(numerator);
    const minVolume = minVolumeFor(spec.pauseAt);
    const over = value != null && value >= spec.pauseAt;

    return {
      key: spec.key, label: spec.label, value, sampleSize: sent, numerator,
      target: spec.target, pauseAt: spec.pauseAt,
      breached: over && sent >= minVolume,
      indicative: over && sent < minVolume,
      needsAttention:
        spec.key === 'complaint_rate' && numerator > 0 && sent < minVolume
          // §07: "Treat any complaint as serious. Do not compute a rate at this n."
          ? `${numerator} complaint(s) on only ${sent} sends — too few to compute a rate, but every complaint matters at this stage.`
          : over && sent < minVolume
            ? `Over threshold but only ${sent} sends (need ${minVolume} to enforce).`
            : null,
      note: spec.note,
    };
  });

  return {
    windowDays,
    sent,
    readings,
    byMailbox: byMailbox as MetricsReport['byMailbox'],
    breaches: readings.filter((r) => r.breached),
  };
}

export type EnforceResult = {
  report: MetricsReport;
  paused: Array<{ campaignId: string; metric: MetricKey; vendorPaused: boolean; error?: string }>;
  alreadyPaused: number;
};

/**
 * Pause on breach.
 *
 * Recorded BEFORE the vendor call, and the vendor's success recorded separately: a breach
 * we detected but failed to enforce is the most dangerous state of all, and it must not be
 * possible for it to leave no trace. Nothing here releases a pause — §08 requires
 * sign-off, which is a separate, deliberate action.
 */
export async function enforceMetrics(
  opts: { windowDays?: number; campaignId: string },
): Promise<EnforceResult> {
  const report = await computeMetrics(opts);

  const { rows: open } = await pool.query(
    `SELECT "metric" FROM "CampaignPause" WHERE "campaignId" = $1 AND "releasedAt" IS NULL`,
    [opts.campaignId],
  );
  const alreadyOpen = new Set(open.map((r) => r.metric));

  const paused: EnforceResult['paused'] = [];
  for (const breach of report.breaches) {
    // One open pause per metric — re-running must not stack duplicates.
    if (alreadyOpen.has(breach.key)) continue;

    const id = crypto.randomUUID();
    await pool.query(
      `INSERT INTO "CampaignPause" ("id","campaignId","metric","value","threshold","sampleSize","detail")
       VALUES ($1,$2,$3,$4,$5,$6,$7)`,
      [
        id, opts.campaignId, breach.key, breach.value, breach.pauseAt, breach.sampleSize,
        `${breach.label} ${breach.value?.toFixed(2)}% vs pause threshold ${breach.pauseAt}% over ${breach.sampleSize ?? 0} sends`,
      ],
    );

    let vendorPaused = false;
    let error: string | undefined;
    try {
      await pauseCampaign(opts.campaignId);
      vendorPaused = true;
    } catch (err) {
      error = err instanceof Error ? err.message : 'pause failed';
    }
    await pool.query(
      `UPDATE "CampaignPause" SET "vendorPaused" = $2, "vendorError" = $3 WHERE "id" = $1`,
      [id, vendorPaused, error ?? null],
    );

    paused.push({ campaignId: opts.campaignId, metric: breach.key, vendorPaused, error });
  }

  return { report, paused, alreadyPaused: alreadyOpen.size };
}

/** Release a pause. Deliberately separate, and always attributed — §08 requires sign-off. */
export async function releasePause(
  pauseId: string,
  releasedBy: string,
  note?: string,
): Promise<boolean> {
  const { rowCount } = await pool.query(
    `UPDATE "CampaignPause"
        SET "releasedAt" = NOW(), "releasedBy" = $2, "releaseNote" = $3
      WHERE "id" = $1 AND "releasedAt" IS NULL`,
    [pauseId, releasedBy, note ?? null],
  );
  return (rowCount ?? 0) > 0;
}
