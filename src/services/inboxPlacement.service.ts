import { sql } from '@/lib/neon';
import {
  listProjects, listTests, isConfigured, type SeedTestResult,
} from '@/lib/integrations/seedTest';

/**
 * Inbox placement readings — pulling them from the seed tool into the guardrail.
 *
 * ── What this closes ─────────────────────────────────────────────────────────
 * §02 makes inbox placement a gate on sending and §08 asks for it weekly, and until today
 * the metric reported "no inbox-placement reading has ever been recorded… no seed tool has
 * been agreed (register A27)". The table, the 80% target and the pause-below-75% rule were
 * all built and had never been fed. This is the feed.
 *
 * ── Why the sync is idempotent and never updates ─────────────────────────────
 * A reading is a measurement taken at a moment. Re-reading the same finished test must not
 * produce a second row — the guardrail takes the LATEST reading, so a duplicate with a
 * fresh createdAt would present an old measurement as current, which is worse than an
 * obviously stale one. The unique index on (tool, externalTestId) enforces that, and the
 * insert does nothing on conflict rather than overwriting: a finished test does not change,
 * and if it ever did, a silent overwrite would rewrite history nobody could audit.
 *
 * ── Why unfinished tests are skipped entirely ────────────────────────────────
 * A test with seeds still arriving reports a real-looking inbox rate over a partial
 * denominator, and it climbs as the rest land. Recording it would feed the pause rule a
 * number that is low for a reason that has nothing to do with deliverability.
 */

export const TOOL = 'glockapps';

export type PlacementRow = {
  id: string;
  measuredAt: string;
  tool: string | null;
  domain: string | null;
  mailbox: string | null;
  primaryPct: number;
  promotionsPct: number | null;
  spamPct: number | null;
  notDeliveredPct: number | null;
  seedCount: number | null;
  note: string | null;
};

export type SyncResult = {
  configured: boolean;
  projects: number;
  testsSeen: number;
  unfinished: number;
  failed: number;
  recorded: number;
  alreadyHad: number;
  /** Problems worth a person's attention, in their own words. */
  warnings: string[];
};

/**
 * A short, readable summary of everything the test found beyond the four percentages.
 *
 * Kept as text in `note` on purpose: authentication results and blocklists are diagnostic
 * context for whoever reads a bad number, not series anybody charts. Giving each its own
 * column would be inventing a schema for data no rule acts on.
 */
function noteFor(t: SeedTestResult): string {
  const bits: string[] = [];
  if (t.senderIp) bits.push(`ip ${t.senderIp}`);
  const auth = [
    t.spf ? `SPF ${t.spf}` : null,
    t.dkim ? `DKIM ${t.dkim}` : null,
    t.dmarc ? `DMARC ${t.dmarc}` : null,
  ].filter(Boolean);
  if (auth.length) bits.push(auth.join(', '));
  if (t.senderScore != null) bits.push(`sender score ${t.senderScore}`);
  if (t.spamAssassinScore != null) bits.push(`SpamAssassin ${t.spamAssassinScore}`);
  if (t.blocklists.length) bits.push(`BLOCKLISTED on ${t.blocklists.join(', ')}`);
  if (t.note) bits.push(t.note);
  return bits.join(' · ');
}

/**
 * Anything in a reading that somebody should be told about regardless of the headline
 * percentage.
 *
 * A test can place 95% in the inbox while the sending IP sits on a blocklist or DMARC
 * fails — today's good number and next week's collapse. The placement rate alone would
 * not show it.
 */
function warningsFor(t: SeedTestResult, label: string): string[] {
  const out: string[] = [];
  if (t.blocklists.length) out.push(`${label}: sending IP or domain is on ${t.blocklists.join(', ')}`);
  for (const [name, value] of [['SPF', t.spf], ['DKIM', t.dkim], ['DMARC', t.dmarc]] as const) {
    if (value && !/pass/i.test(value)) out.push(`${label}: ${name} did not pass (${value})`);
  }
  if (t.stats && t.stats.notDeliveredRate > 0) {
    out.push(
      `${label}: ${t.stats.notDeliveredRate.toFixed(1)}% of seeds received nothing at all `
      + '— accepted and dropped, which produces no bounce and reads as delivered in our own figures',
    );
  }
  return out;
}

/**
 * Pull every finished test from the tool and record the ones not already held.
 *
 * Reads all projects rather than one: the intended setup is a project per sending domain,
 * and a sync that silently covered only the first would leave three domains unmeasured
 * while reporting success.
 */
export async function syncPlacement(opts: { limitPerProject?: number } = {}): Promise<SyncResult> {
  const result: SyncResult = {
    configured: isConfigured(),
    projects: 0, testsSeen: 0, unfinished: 0, failed: 0, recorded: 0, alreadyHad: 0, warnings: [],
  };
  if (!result.configured) {
    result.warnings.push('No seed-tool API key is configured, so placement cannot be measured.');
    return result;
  }

  const projects = await listProjects();
  result.projects = projects.length;
  if (!projects.length) {
    result.warnings.push(
      'The seed tool holds no projects. Create one per sending domain, then add each '
      + "project's autotest address to a campaign restricted to that domain's mailboxes.",
    );
    return result;
  }

  for (const project of projects) {
    const tests = await listTests(project.id, { limit: opts.limitPerProject ?? 50 });
    result.testsSeen += tests.length;

    for (const t of tests) {
      if (!t.finished) { result.unfinished++; continue; }
      if (t.failed) {
        result.failed++;
        result.warnings.push(`${project.name}: a test failed to complete and has no reading.`);
        continue;
      }
      if (!t.stats) { result.failed++; continue; }

      /*
       * The project name is the fallback for which domain this measures.
       *
       * The tool reports the domain it observed in the message, which is the fact that
       * matters; but a test whose authentication never completed has none, and a reading
       * filed against no domain is a reading nobody can act on. The setup puts one domain
       * per project, so the project name is the honest second choice.
       */
      const domain = t.senderDomain ?? project.name ?? null;

      const inserted = await sql`
        INSERT INTO "InboxPlacement" (
          "id", "measuredAt", "tool", "domain", "mailbox",
          "primaryPct", "promotionsPct", "spamPct", "notDeliveredPct",
          "seedCount", "externalTestId", "note", "enteredBy", "createdAt")
        VALUES (
          ${globalThis.crypto.randomUUID()},
          ${t.created ?? new Date().toISOString()},
          ${TOOL}, ${domain}, ${null},
          ${t.stats.inboxRate}, ${t.stats.otherRate}, ${t.stats.spamRate}, ${t.stats.notDeliveredRate},
          ${t.seedCount}, ${t.testId}, ${noteFor(t)}, ${'seed tool'}, NOW())
        ON CONFLICT ("tool", "externalTestId") WHERE "externalTestId" IS NOT NULL
        DO NOTHING
        RETURNING "id"` as Array<{ id: string }>;

      if (inserted.length) {
        result.recorded++;
        result.warnings.push(...warningsFor(t, domain ?? project.name));
      } else {
        result.alreadyHad++;
      }
    }
  }

  await writeOverall();
  const worst = (await latestByDomain())
    .filter((r) => r.domain)
    .sort((a, b) => a.primaryPct - b.primaryPct)[0];
  if (worst) {
    result.warnings.push(
      `Weakest domain: ${worst.domain} at ${worst.primaryPct.toFixed(1)}% primary inbox. `
      + 'The sending gate reads the combined figure, which a single weak domain does not move far.',
    );
  }

  return result;
}

/**
 * Write the combined reading the sending gate actually reads.
 *
 * ── Why this row has to exist ────────────────────────────────────────────────
 * The gate in protectiveMetrics selects the latest row WHERE domain IS NULL — the
 * whole-account figure. Every row the sync writes names a domain, so without this the
 * table would fill with readings and the gate would go on reporting that none had ever
 * been taken.
 *
 * ── Why the mean, and why that is worth arguing about ────────────────────────
 * Combined as a mean weighted by how many seeds each test used, which is the honest
 * answer to "what share of our mail reaches the inbox".
 *
 * It is NOT the safest answer for a gate. Three domains at 90% and one at 60% average
 * about 82% — comfortably past the 75% pause line while a quarter of the sending estate
 * burns. The handbook's own rule is that an aggregate hides which mailbox is burning.
 * Making the gate fire on the WORST domain instead is a change to Frank's threshold rule,
 * so it is raised rather than taken: the weakest domain is reported on every sync, and
 * the per-domain rows are kept so the question can be settled with data.
 */
export async function writeOverall(): Promise<{ written: boolean; primaryPct: number | null }> {
  const rows = (await latestByDomain()).filter((r) => r.domain && r.seedCount);
  if (!rows.length) return { written: false, primaryPct: null };

  const seeds = rows.reduce((a, r) => a + (r.seedCount ?? 0), 0);
  if (seeds <= 0) return { written: false, primaryPct: null };
  const wmean = (pick: (r: PlacementRow) => number | null): number =>
    rows.reduce((a, r) => a + (pick(r) ?? 0) * (r.seedCount ?? 0), 0) / seeds;

  const measuredAt = rows.map((r) => r.measuredAt).sort().pop()!;

  /*
   * Keyed on the newest reading it combines, so a sync that brings nothing new rewrites
   * nothing. Without a key the combined row has no externalTestId, the partial unique
   * index does not apply to it, and every sync would append another copy — handing the
   * gate an old measurement wearing a new timestamp.
   */
  const written = await sql`
    INSERT INTO "InboxPlacement" (
      "id", "measuredAt", "tool", "domain", "mailbox",
      "primaryPct", "promotionsPct", "spamPct", "notDeliveredPct",
      "seedCount", "externalTestId", "note", "enteredBy", "createdAt")
    VALUES (
      ${globalThis.crypto.randomUUID()}, ${measuredAt}, ${TOOL}, ${null}, ${null},
      ${wmean((r) => r.primaryPct)}, ${wmean((r) => r.promotionsPct)},
      ${wmean((r) => r.spamPct)}, ${wmean((r) => r.notDeliveredPct)},
      ${seeds}, ${`overall:${measuredAt}`},
      ${`combined across ${rows.length} domain(s): ${rows.map((r) => `${r.domain} ${(r.primaryPct ?? 0).toFixed(0)}%`).join(', ')}`},
      ${'seed tool'}, NOW())
    ON CONFLICT ("tool", "externalTestId") WHERE "externalTestId" IS NOT NULL
    DO NOTHING
    RETURNING "id"` as Array<{ id: string }>;

  return { written: written.length > 0, primaryPct: wmean((r) => r.primaryPct) };
}

/**
 * The most recent reading per domain, plus the overall one the guardrail reads.
 *
 * Per domain because an aggregate hides which domain is burning — the same reason the
 * deliverability metrics are published per mailbox as well as in total.
 */
export async function latestByDomain(): Promise<PlacementRow[]> {
  return await sql`
    SELECT DISTINCT ON ("domain")
           "id", "measuredAt"::text AS "measuredAt", "tool", "domain", "mailbox",
           "primaryPct", "promotionsPct", "spamPct", "notDeliveredPct", "seedCount", "note"
      FROM "InboxPlacement"
     ORDER BY "domain", "measuredAt" DESC` as unknown as PlacementRow[];
}
