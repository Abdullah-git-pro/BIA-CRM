import { sql } from '@/lib/neon';
import { wallClockIso } from '@/lib/wallClock';
import { checkEmailAgainstNames } from './emailNameMatch.service';
import { allInsuredAddresses, allCoInsuredAddresses } from './addressRank.service';
import { loadCandidates } from './sendCandidates.service';
import { blockedAddresses } from './emailVerification.service';

/**
 * The surname review list (Frank, 24 Sep 2026 · second email §7).
 *
 * "A surname match between every skip-trace-recovered address and the insured or
 *  co-insured. Failures go to a review list, not into a send."
 *
 * ── Why this cannot be left to email verification ───────────────────────────
 * Frank, in the same paragraph: "Email verification will not catch this. It confirms a
 * mailbox exists, not that it belongs to the person. It will pass this address and the send
 * will still be wrong."
 *
 * The account that prompted it has insured Claudia Garcia, co-insured Cesar Garcia, and one
 * address: dburnette19@gmail.com. A verifier says that mailbox is live, and it is — it
 * belongs to somebody else. Sending there discloses a stranger's property details and
 * estimated premium, from a domain with no sending history to absorb the complaint.
 *
 * ── Only the addresses that would actually be MAILED are checked ────────────
 * Not every address on a card: a queue padded with addresses nobody was going to use is a
 * queue nobody finishes. The test is "would this be sent to", and it is asked of the same
 * function the send list and the push ask.
 *
 * That used to mean ONE address per person, the top-ranked one. Frank changed it on 28 Sep
 * — "individual emails sent to each of the insured's verified emails, we are not sure which
 * will be primary so we must outreach all" — and this was not changed with it. The rule kept
 * being enforced, against the wrong population: every address gained by that change went out
 * unchecked, because the queue was still asking about the top-ranked one.
 *
 * Measured on 29 Sep before the fix: 1,583 trace-recovered addresses stood on the live send
 * list and NOT ONE had been name-checked. 359 of them failed the check once it was run.
 *
 * The lesson is not "remember to update both". It is that this must ask the same question
 * the send asks, in the same words — hence allInsuredAddresses / allCoInsuredAddresses, the
 * functions the send list and the push themselves call. When the sending rule changes again,
 * this changes with it.
 *
 * ── Held by default, released deliberately ──────────────────────────────────
 * An undecided row keeps its address out of every send. Approving is an act by a named
 * person. The failure this guards against is silent release, so absence of a decision means
 * hold rather than proceed.
 */

export type ReviewDecision = 'approved' | 'rejected';

export type ReviewRow = {
  id: string;
  leadId: string;
  propertyId: string | null;
  cohort: string | null;
  personRole: 'insured' | 'coInsured';
  email: string;
  verdict: string;
  checkedAt: string | null;
  decision: ReviewDecision | null;
  decidedBy: string | null;
  decidedAt: string | null;
  note: string | null;
  /** The named insured. */
  owner: string | null;
  /**
   * The co-insured, where there is one.
   *
   * Both names are returned because the check compares an address against BOTH — the
   * matcher pools the household's names deliberately, since "antcath2003" is two given
   * names run together and belongs to neither person alone.
   *
   * The screen showed only the insured, and labelled a co-insured row "(co-insured)" beside
   * the INSURED's name. So a reviewer was asked whether ajuliya09@gmail.com was Elena
   * Ashkinazi on a row that had never been compared against Elena Ashkinazi. Every answer
   * to that question is unsound, including the right ones.
   */
  coInsuredOwner: string | null;
  address: string | null;
  /**
   * Read from the lead, never stored on the row.
   *
   * A grade copied onto the review row at build time would be a second answer to a question
   * the Lead already answers, and it would go stale the moment somebody regrades a card —
   * leaving a reviewer told this was Grade A about a lead that is not.
   */
  grade: string | null;
};

const norm = (e: unknown) => String(e ?? '').trim().toLowerCase();

/**
 * Every address the trace payload carries, so a producer-typed address is not treated as
 * recovered.
 *
 * Frank's rule is about skip-trace-recovered addresses specifically. An address somebody at
 * the agency typed onto the card carries a different kind of evidence, and holding it would
 * be second-guessing a person who had the account in front of them.
 *
 * On the wave-one list this barely narrows anything — 1,250 of the 1,278 addresses that
 * would be mailed came from a trace — but the distinction is the instruction, and the 28
 * that did not should not be in a queue about trace quality.
 */
function tracedAddresses(lead: Record<string, any>): Set<string> {
  const out = new Set<string>();
  const walk = (v: unknown): void => {
    if (!v) return;
    if (typeof v === 'string') { if (v.includes('@')) out.add(norm(v)); return; }
    if (Array.isArray(v)) { v.forEach(walk); return; }
    if (typeof v === 'object') { Object.values(v as Record<string, unknown>).forEach(walk); }
  };
  walk(lead.skipTraceData);
  return out;
}

export type BuildResult = {
  checked: number;
  matched: number;
  queued: number;
  alreadyQueued: number;
  /** Addresses skipped because a producer typed them rather than a trace finding them. */
  notTraced: number;
  /** Addresses the verifier has already refused — they will never be sent to. */
  undeliverable: number;
  /** Undecided rows dropped because the address no longer fails the check. */
  released: number;
  /** Addresses the identity check confirms belong to this person, so never queued. */
  confirmedTheirs: number;
  byCohort: Array<{ cohort: string; n: number }>;
};

/**
 * Check the wave-one send list and queue every failure.
 *
 * Idempotent: a decision already made survives, because the unique index makes a re-run an
 * ON CONFLICT DO NOTHING. Re-running after a fresh trace picks up new addresses and leaves
 * settled ones alone.
 */
/**
 * What the identity check already decided about an address, keyed leadId|role|email.
 *
 * ── Why this queue has to know ──────────────────────────────────────────────
 * The matcher here is a string test: does the address contain a name from the policy.
 * Trestle answers the question the string test is a proxy FOR — whose mailbox is this —
 * by looking the address up against the person. When both have an opinion the paid lookup
 * is the better evidence, and asking a human to re-decide what we already know is how a
 * queue of 745 teaches the person working it to stop reading the rows.
 *
 * jerseyd2000@aol.com is Diane Clonts, confirmed, age score 100. The matcher calls it a
 * mismatch because her name is not in it. 24 open rows look like that one.
 *
 * ── Only the same person's verdict counts ───────────────────────────────────
 * Keyed by role as well as address. An address confirmed as the CO-INSURED's is not
 * evidence about the insured — that is the barb9280@aol.com case, where one household's
 * address was registered to a different member — and the send would mail it as the
 * insured. Three rows are in exactly that state and stay in the queue for a person.
 *
 * ── A null is not an answer ─────────────────────────────────────────────────
 * Trestle returning no opinion leaves the row where it was. An outage is not a verdict.
 */
async function identityVerdicts(): Promise<Map<string, boolean>> {
  const rows = await sql`
    SELECT "leadId", "personRole", LOWER("value") AS "email", "nameMatch"
      FROM "ContactVerification"
     WHERE "channel" = 'email' AND "nameMatch" IS NOT NULL` as Array<Record<string, any>>;
  const m = new Map<string, boolean>();
  for (const r of rows) {
    m.set(`${String(r.leadId)}|${String(r.personRole)}|${String(r.email)}`, r.nameMatch === true);
  }
  return m;
}

export async function buildReviewQueue(params: {
  effFrom: string; effTo: string;
  /**
   * Which book to check. Grade A by default — every existing caller.
   *
   * Grade B needs it just as much and had never had it: on 30 Sep the roof-age blast had
   * recovered 133 insured addresses across 64 leads, 53 of which failed the surname check,
   * and not one was in this queue. Grade B is mailed by email ONLY, so there is no producer
   * on a phone to notice that the address belongs to somebody else before the send.
   *
   * Untraced leads cost nothing to include: only addresses the trace payload carries are
   * ever queued, so a lead nobody has traced contributes none.
   */
  grade?: 'A' | 'B';
  dryRun?: boolean;
}): Promise<BuildResult> {
  const { effFrom, effTo, grade = 'A', dryRun = true } = params;

  /**
   * The same population the send list works from, asked with the same function.
   *
   * This used to run its own query: `sendListBuiltAt IS NOT NULL` and a window compared
   * against "cohort" — where the send list compares against "effectiveDate" and does not
   * consult that flag at all. sendListBuiltAt is stamped when a list was last EXPORTED, so
   * the queue covered whoever happened to be on the previous export and silently omitted
   * everyone who had joined since: 678 leads against the send list's 842 on 29 Sep.
   *
   * A review queue built over a narrower population than the send is worse than no queue,
   * because it reports all-clear about leads it never opened.
   */
  const leads = await loadCandidates(effFrom, effTo, grade) as Array<Record<string, any>>;

  /**
   * Addresses ZeroBounce has refused: invalid, abuse, spamtrap, do_not_mail.
   *
   * They are excluded from the queue because they are excluded from the send. Asking a
   * producer whether a dead mailbox belongs to the insured is a question with no
   * consequence attached, and a queue where a third of the rows do not matter teaches the
   * person working it that none of them do — which is how the one genuine stranger in it
   * gets waved through.
   *
   * Not folded in with the trace filter above: that one is about whose evidence an address
   * is, this one is about whether it is alive. A re-verification can overturn this and the
   * address comes back into the queue on the next build; nothing about it is a decision.
   */
  const undeliverable = await blockedAddresses();

  /** Verdicts from the paid identity check, which outrank the string matcher. */
  const identity = await identityVerdicts();

  const out: BuildResult = {
    checked: 0, matched: 0, queued: 0, alreadyQueued: 0, notTraced: 0, undeliverable: 0,
    released: 0, confirmedTheirs: 0, byCohort: [],
  };
  /**
   * Every address that still fails, as "leadId|role|email".
   *
   * Used after the loop to clear undecided rows that no longer belong here. Without it the
   * queue only ever grows: improve the matcher and the rows it now understands stay held
   * anyway, so a reviewer keeps being asked about addresses the rule would pass. Adding
   * "august -> augie" fixed August Sanseverino's address in the matcher and left it sitting
   * in the queue regardless.
   */
  const stillFailing = new Set<string>();
  /**
   * Candidate addresses this run did NOT put a verdict on, because the verifier has already
   * refused them.
   *
   * The deletion below has to tell "this address passed the check" from "this run never
   * asked". These were never asked. Dropping their held rows would mean that if the
   * verdict is ever overturned — a re-verification, a corrected import — the address
   * becomes sendable with nothing having checked whose it is. The verifier's job is whether
   * a mailbox is alive; it has never had an opinion on whose it is.
   */
  const uncheckedUndeliverable = new Set<string>();
  const perCohort = new Map<string, number>();

  for (const l of leads) {
    const people = [
      { first: l.owner1FirstName, last: l.owner1LastName, role: 'insured' as const },
      { first: l.owner2FirstName, last: l.owner2LastName, role: 'coInsured' as const },
    ].filter((p) => p.first || p.last);
    if (!people.length) continue;

    const traced = tracedAddresses(l);

    for (const [role, picked] of [
      ['insured', allInsuredAddresses(l)],
      ['coInsured', allCoInsuredAddresses(l)],
    ] as Array<['insured' | 'coInsured', Array<{ email: string }>]>) {
      for (const one of picked) {
        const email = norm(one?.email);
        if (!email) continue;

        const key = `${String(l.id)}|${role}|${email}`;

        /**
         * A producer typed this one rather than a trace finding it. Frank's rule is about
         * trace-recovered addresses, so it is not held — and if an older run queued it, the
         * deletion below is what lets it go.
         */
        if (!traced.has(email)) { out.notTraced++; continue; }
        if (undeliverable.has(email)) {
          out.undeliverable++;
          uncheckedUndeliverable.add(key);
          continue;
        }

        /**
         * Already settled by the identity check, in this person's favour.
         *
         * Deliberately before the matcher runs: there is no question left to ask. Not added
         * to stillFailing either, so an older held row for it is released by the cleanup
         * below and the address becomes sendable — which is the point. A confirmation we
         * paid for that leaves the address blocked anyway has bought nothing.
         */
        if (identity.get(`${String(l.id)}|${role}|${email}`) === true) {
          out.confirmedTheirs++;
          continue;
        }

        out.checked++;
        const raw = checkEmailAgainstNames(email, people);
        const verdict = typeof raw === 'string' ? raw : (raw as { verdict: string }).verdict;
        if (verdict === 'match') { out.matched++; continue; }
        stillFailing.add(key);

        perCohort.set(String(l.cohort), (perCohort.get(String(l.cohort)) ?? 0) + 1);
        if (dryRun) { out.queued++; continue; }

        const rows = await sql`
          INSERT INTO "EmailNameReview"
            ("id","leadId","propertyId","cohort","personRole","email","verdict","checkedAt",
             "createdAt","updatedAt")
          VALUES (${crypto.randomUUID()}, ${String(l.id)}, ${l.propertyId ?? null},
                  ${l.cohort ?? null}, ${role}, ${email}, ${verdict}, NOW(), NOW(), NOW())
          ON CONFLICT ("leadId","personRole","email") DO NOTHING
          RETURNING "id"` as Array<{ id: string }>;
        if (rows.length) out.queued++; else out.alreadyQueued++;
      }
    }
  }

  /**
   * Drop undecided rows this run did not re-raise.
   *
   * Only rows with NO decision on them: an approval or a rejection is a person's judgement
   * and outlives any change to the matcher. Scoped to the leads this run actually looked at,
   * so a narrow window cannot clear the whole table.
   *
   * A row disappears here because the address now passes, or because it is no longer one
   * this lead would be mailed at. Either way holding it achieves nothing, and a queue with
   * rows in it that do not matter is one nobody trusts.
   */
  if (!dryRun && leads.length) {
    const leadIds = leads.map((l) => String(l.id));
    const open = (await sql`
      SELECT "id","leadId","personRole","email" FROM "EmailNameReview"
       WHERE "decision" IS NULL AND "leadId" = ANY(${leadIds}::text[])`) as Array<Record<string, any>>;
    const stale = open
      .filter((r) => {
        const key = `${r.leadId}|${r.personRole}|${norm(r.email)}`;
        // Still fails the check: keep holding it.
        if (stillFailing.has(key)) return false;
        // Not judged this run because the mailbox is refused: keep holding it, in case that
        // verdict is ever lifted.
        if (uncheckedUndeliverable.has(key)) return false;
        // Either it passes now, or it is no longer an address this lead would be mailed at.
        return true;
      })
      .map((r) => String(r.id));
    if (stale.length) {
      await sql`DELETE FROM "EmailNameReview" WHERE "id" = ANY(${stale}::text[]) AND "decision" IS NULL`;
      out.released = stale.length;
    }
  }

  out.byCohort = [...perCohort].sort().map(([cohort, n]) => ({ cohort, n }));
  return out;
}

/**
 * Addresses currently held out of sending.
 *
 * Returned as a Set of lower-cased addresses so the push can test membership per candidate
 * without a query per address.
 */
export async function heldAddresses(): Promise<Set<string>> {
  const rows = await sql`
    SELECT DISTINCT "email" FROM "EmailNameReview" WHERE "decision" IS NULL
       OR "decision" = 'rejected'` as Array<{ email: string }>;
  return new Set(rows.map((r) => norm(r.email)));
}

export async function getReviewList(params: {
  cohortFrom?: string; cohortTo?: string; openOnly?: boolean;
  /**
   * Only rows somebody has already settled — the "what have I decided" view.
   *
   * Distinct from the absence of openOnly, which returns everything. The screen offered a
   * button labelled "Showing decided" wired to openOnly:false, so it returned the decided
   * rows AND every outstanding one together. The label described a filter nobody had
   * written.
   */
  decidedOnly?: boolean;
  /** Narrow to one book, read live from the lead rather than from the row. */
  grade?: string;
  /** One lead only — what the lead card asks for. */
  leadId?: string;
  limit?: number;
} = {}): Promise<ReviewRow[]> {
  const rows = await sql`
    SELECT r.*, l."owner1FirstName", l."owner1LastName",
           l."owner2FirstName", l."owner2LastName",
           l."addressStreet", l."addressCity",
           COALESCE(l."manualGrade", l."grade") AS "leadGrade"
      FROM "EmailNameReview" r
      LEFT JOIN "Lead" l ON l."id" = r."leadId"
     WHERE (${params.leadId ?? null}::text IS NULL OR r."leadId" = ${params.leadId ?? null})
       AND (${params.cohortFrom ?? null}::text IS NULL OR r."cohort" >= ${params.cohortFrom ?? null})
       AND (${params.cohortTo ?? null}::text   IS NULL OR r."cohort" <= ${params.cohortTo ?? null})
       AND (${params.openOnly ?? false}::boolean = FALSE OR r."decision" IS NULL)
       /*
        * Already settled the other way, and still held.
        *
        * Trestle says this address is registered to somebody else. That is the answer this
        * queue exists to get, from better evidence than a string test, and the row stays
        * undecided so heldAddresses() keeps the address out of every send. What it must not
        * do is take up a reviewer's time: there is nothing for a person to add, and a queue
        * padded with settled rows is how the one genuine stranger in it gets waved through.
        *
        * Scoped to the open view. The decided view still shows everything.
        */
       AND (${params.openOnly ?? false}::boolean = FALSE OR NOT EXISTS (
             SELECT 1 FROM "ContactVerification" v
              WHERE v."leadId" = r."leadId" AND v."channel" = 'email'
                AND LOWER(v."value") = LOWER(r."email")
                AND v."personRole" = r."personRole"
                AND v."nameMatch" IS FALSE))
       AND (${params.decidedOnly ?? false}::boolean = FALSE OR r."decision" IS NOT NULL)
       AND (${params.grade ?? null}::text IS NULL
            OR COALESCE(l."manualGrade", l."grade") = ${params.grade ?? null})
     -- Mismatch first: "this belongs to a different name" is a decision somebody can
     -- actually make, where "we cannot tell" mostly is not.
     ORDER BY CASE r."verdict" WHEN 'mismatch' THEN 0 ELSE 1 END, r."cohort", r."email"
     LIMIT ${Math.min(Number(params.limit) || 1000, 5000)}` as Array<Record<string, any>>;

  return rows.map((r) => ({
    id: String(r.id),
    leadId: String(r.leadId),
    propertyId: r.propertyId ?? null,
    cohort: r.cohort ?? null,
    personRole: r.personRole as 'insured' | 'coInsured',
    email: String(r.email),
    verdict: String(r.verdict),
    checkedAt: wallClockIso(r.checkedAt),
    decision: (r.decision ?? null) as ReviewDecision | null,
    decidedBy: r.decidedBy ?? null,
    decidedAt: wallClockIso(r.decidedAt),
    note: r.note ?? null,
    owner: [r.owner1FirstName, r.owner1LastName].filter(Boolean).join(' ') || null,
    coInsuredOwner: [r.owner2FirstName, r.owner2LastName].filter(Boolean).join(' ') || null,
    address: [r.addressStreet, r.addressCity].filter(Boolean).join(', ') || null,
    grade: r.leadGrade ?? null,
  }));
}

/**
 * Record a person's decision on held addresses.
 *
 * ── Approving a POOL candidate also puts it on the lead ─────────────────────
 * For an address the vendor attributed, this queue is purely a blocklist: insuredEmails()
 * already returns it, and approving simply stops heldAddresses() withholding it.
 *
 * A pool candidate is the other way round. Nothing attributed it, so no send path offers
 * it, and lifting a block on an address nobody proposes changes nothing at all — the
 * screen would say approved and the lead would stay unmailable. So an approved pool
 * candidate is written into the first empty insured slot, which is where insuredEmails()
 * looks first.
 *
 * Promotion never fails a decision. The judgement is the thing worth keeping; a lead that
 * was approved and not promoted is visible and repairable, where an approval rolled back
 * because a write failed is a judgement somebody has to make twice.
 */
export async function decideReview(ids: string[], input: {
  decision: ReviewDecision; decidedBy: string; note?: string | null;
}): Promise<number> {
  if (!ids.length) return 0;
  const rows = await sql`
    UPDATE "EmailNameReview"
       SET "decision" = ${input.decision}, "decidedBy" = ${input.decidedBy},
           "decidedAt" = NOW(), "note" = ${input.note ?? null}, "updatedAt" = NOW()
     WHERE "id" = ANY(${ids}::text[]) AND "decision" IS NULL
    RETURNING "id"` as Array<{ id: string }>;

  if (input.decision === 'approved' && rows.length) {
    try {
      const { promoteApproved } = await import('./poolAttribution.service');
      await promoteApproved(rows.map((r) => r.id));
    } catch (err) {
      // Surfaced to the server log, never to the person deciding — see the note above.
      console.error('pool candidate approved but not promoted:', (err as Error)?.message);
    }
  }
  return rows.length;
}

/** Counts for the preflight and the tab. */
/**
 * Counts for the preflight and the tab.
 *
 * ── The per-week count follows the grade filter ─────────────────────────────
 * It did not, and the screen disagreed with itself: the week picker offered
 * "2026-10-12 (43)" while the headline beside it read 39 left to check. Both were right —
 * 43 open rows in that week, 39 of them on Grade A leads — and the only thing explaining
 * the gap was a filter two boxes away that the count ignored.
 *
 * Two numbers for one week on one screen is the fault this project keeps paying for, so
 * the count is now scoped the same way the list is. The grade lives on the LEAD rather
 * than on the review row, which is why this has to join rather than filter in place.
 */
export async function reviewSummary(params: { grade?: string } = {}): Promise<{
  open: number; approved: number; rejected: number;
  /**
   * Open rows the identity check has already answered against the household.
   *
   * Counted rather than hidden: the addresses are still held out of every send, and a
   * number that quietly vanishes from a queue is the kind of thing nobody can audit later.
   */
  settledByIdentity: number;
  byCohort: Array<{ cohort: string; open: number }>;
}> {
  const grade = params.grade?.trim() || null;
  /*
   * The headline must count exactly the rows the list returns.
   *
   * Two numbers for one thing on one screen is the fault this project keeps paying for —
   * the week picker said 43 while the headline said 39 — so the identity exclusion is
   * written into the count in the same words as into the list.
   */
  const [t] = await sql`
    SELECT COUNT(*) FILTER (WHERE r."decision" IS NULL AND NOT "notTheirs")::int AS open,
           COUNT(*) FILTER (WHERE r."decision" IS NULL AND "notTheirs")::int AS "settledByIdentity",
           COUNT(*) FILTER (WHERE r."decision" = 'approved')::int AS approved,
           COUNT(*) FILTER (WHERE r."decision" = 'rejected')::int AS rejected
      FROM (
        SELECT r."decision", EXISTS (
                 SELECT 1 FROM "ContactVerification" v
                  WHERE v."leadId" = r."leadId" AND v."channel" = 'email'
                    AND LOWER(v."value") = LOWER(r."email")
                    AND v."personRole" = r."personRole"
                    AND v."nameMatch" IS FALSE) AS "notTheirs"
          FROM "EmailNameReview" r
          JOIN "Lead" l ON l."id" = r."leadId"
         WHERE (${grade}::text IS NULL
                OR COALESCE(l."manualGrade", l."grade") = ${grade})
      ) r` as Array<Record<string, any>>;
  const byCohort = await sql`
    SELECT r."cohort", COUNT(*)::int AS open
      FROM "EmailNameReview" r
      JOIN "Lead" l ON l."id" = r."leadId"
     WHERE r."decision" IS NULL AND r."cohort" IS NOT NULL
       AND (${grade}::text IS NULL
            OR COALESCE(l."manualGrade", l."grade") = ${grade})
       AND NOT EXISTS (
             SELECT 1 FROM "ContactVerification" v
              WHERE v."leadId" = r."leadId" AND v."channel" = 'email'
                AND LOWER(v."value") = LOWER(r."email")
                AND v."personRole" = r."personRole"
                AND v."nameMatch" IS FALSE)
     GROUP BY 1 ORDER BY 1` as Array<Record<string, any>>;
  return {
    open: Number(t?.open ?? 0),
    approved: Number(t?.approved ?? 0),
    rejected: Number(t?.rejected ?? 0),
    settledByIdentity: Number(t?.settledByIdentity ?? 0),
    byCohort: byCohort.map((r) => ({ cohort: String(r.cohort), open: Number(r.open) })),
  };
}
