import { sql } from '@/lib/neon';
import { insuredEmails, coInsuredEmails, assertRecipientCols } from './recipients.service';
import { rankAddresses } from './addressRank.service';

/**
 * Addresses we hold, have paid for, and are not using.
 *
 * ── The gap this closes ─────────────────────────────────────────────────────
 * An address becomes the insured's when the VENDOR attributed it to a person whose name
 * matches ours. That rule is right and it stays: emailsAll is a property-level pool that
 * routinely carries relatives, prior owners and unrelated co-residents, and mailing it
 * would send a homeowner's premium to a stranger.
 *
 * But the pool also carries the insured's own address, under exactly the same roof, with
 * nothing to tell them apart except the name in the local part. Lead 251520882 is the
 * example: insured Waqas Ashraf, and the pool holds waqasashraf78@gmail.com,
 * waqas.ashraf@commvault.com and waqasashraf@fb.com alongside four strangers. Tracerfy
 * attributed none of them to a person, so the card reads "no address belongs to the
 * insured — this lead cannot be emailed" while his own address sits two lines above.
 *
 * 26 Grade A cards from C1 onward are in that state, 7 of them in C1.
 *
 * ── Why this proposes rather than claims ────────────────────────────────────
 * The same pool that holds waqasashraf78@gmail.com for Waqas Ashraf holds
 * floritababbiepabello@yahoo.com for Rachelle Aaronson and svobodajoan@gmail.com for
 * Charles Hulme. A name in a local part is evidence, not proof — and the awkward middle
 * is a shared surname, where michael.b.simone@gmail.com on Jennifer Simone's card is her
 * husband rather than the policyholder.
 *
 * So nothing here writes to a lead. Candidates go into the surname review queue that
 * already exists, where they are blocked from sending until a person says yes. The
 * judgement stays with Ruben; what changes is that the question now reaches him at all.
 */

/** The verdict these rows carry, so they can be told apart from the surname checks. */
export const POOL_VERDICT = 'pool_candidate';

export type PoolProposal = {
  leadId: string;
  propertyId: string | null;
  cohort: string | null;
  personRole: 'insured' | 'coInsured';
  email: string;
  /** Why the matcher thinks so, in the words the ranking already uses. */
  why: string;
  /** Rank within this person's candidates — 1 is the one to approve first. */
  rank: number;
};


/**
 * Candidates for one lead, best first.
 *
 * Reuses rankAddresses, which is what decides send order everywhere else — so a candidate
 * promoted here is ranked by the same rules that would have ranked it had the vendor
 * attributed it properly. That matters for a reason beyond tidiness: Waqas's pool holds a
 * personal Gmail and two work addresses, and the playbook is explicit that a work address
 * is the last thing to use for a personal insurance approach. The ranking already knows
 * that; a fresh comparison written here would not.
 */
export function poolCandidatesFor(lead: Record<string, any>): PoolProposal[] {
  // Only cards the campaign genuinely cannot reach. A lead with an attributed address
  // does not need a proposal, and offering one would put a second question in front of
  // somebody who already has an answer.
  if (insuredEmails(lead).length > 0) return [];

  const pool = (Array.isArray(lead.emailsAll) ? lead.emailsAll : []).map(String);
  if (!pool.length) return [];

  // Anything already attributed to the co-insured is theirs, not an orphan.
  const taken = new Set(coInsuredEmails(lead).map((e) => e.toLowerCase()));
  const candidates = pool.filter((e) => !taken.has(String(e).toLowerCase()));
  if (!candidates.length) return [];

  const ranked = rankAddresses(candidates, lead, lead.owner1FirstName, lead.owner1LastName);

  /**
   * A surname alone is not enough on its own to propose an address.
   *
   * "name match: last" fires on every member of a household, so proposing on it would put
   * a spouse's address up as the policyholder's on every card with a shared surname. The
   * two shapes worth a person's time are both names present, and an initial with the
   * surname — jsmith@, the commonest real form of somebody's own address.
   */
  const WORTH_ASKING = (r: string) =>
    r === 'name match: first + last' || r === 'name match: initial + last';

  return ranked
    .filter((r) => r.reasons.some(WORTH_ASKING))
    .map((r, i) => ({
      leadId: String(lead.id),
      propertyId: lead.propertyId ? String(lead.propertyId) : null,
      cohort: lead.cohort ? String(lead.cohort) : null,
      personRole: 'insured' as const,
      email: r.email,
      why: r.reasons.find(WORTH_ASKING) ?? 'name match',
      rank: i + 1,
    }));
}

export type PoolBuildResult = {
  leadsScanned: number;
  leadsWithCandidate: number;
  proposed: number;
  /** Already in the queue from an earlier run, or already decided. Left alone. */
  alreadyQueued: number;
  dryRun: boolean;
  sample: Array<{ owner: string; email: string; why: string }>;
};

/**
 * Put every unclaimed-but-name-matching address in front of a person.
 *
 * Idempotent. The queue's unique index on (leadId, personRole, email) means a second run
 * cannot duplicate a row, and a row somebody has already decided is never reopened — the
 * same guarantee buildReviewQueue gives, for the same reason: a decision is a person's
 * judgement and a job must not quietly undo one.
 */
export async function buildPoolQueue(params: {
  effFrom?: string;
  effTo?: string;
  grade?: 'A' | 'B';
  dryRun?: boolean;
} = {}): Promise<PoolBuildResult> {
  const { effFrom, effTo, grade = 'A', dryRun = true } = params;

  /**
   * Named columns, and every one the recipient rules read.
   *
   * A missing column here does not throw — it silently changes the answer, which is how
   * two tabs of this CRM once reported 521 and 518 reachable for the same week. The
   * assertion below is the guard, and it is loud on purpose.
   */
  const leads = await sql`
    SELECT "id","propertyId","cohort",
           "email1","email2","owner2Email",
           "phone1","phone2","owner2Phone",
           "owner1FirstName","owner1LastName","owner2FirstName","owner2LastName",
           "skipTraceData","emailsAll"
      FROM "Lead"
     WHERE COALESCE("manualGrade","grade") = ${grade}
       AND (${effFrom ?? null}::text IS NULL OR "cohort" >= ${effFrom ?? null})
       AND (${effTo ?? null}::text   IS NULL OR "cohort" <= ${effTo ?? null})` as Array<Record<string, any>>;
  assertRecipientCols(leads[0], 'pool attribution');

  const out: PoolBuildResult = {
    leadsScanned: leads.length,
    leadsWithCandidate: 0,
    proposed: 0,
    alreadyQueued: 0,
    dryRun,
    sample: [],
  };

  for (const lead of leads) {
    const candidates = poolCandidatesFor(lead);
    if (!candidates.length) continue;
    out.leadsWithCandidate++;

    for (const c of candidates) {
      if (out.sample.length < 12) {
        out.sample.push({
          owner: [lead.owner1FirstName, lead.owner1LastName].filter(Boolean).join(' '),
          email: c.email,
          why: c.why,
        });
      }
      if (dryRun) { out.proposed++; continue; }

      const written = await sql`
        INSERT INTO "EmailNameReview"
          ("id","leadId","propertyId","cohort","personRole","email","verdict",
           "checkedAt","createdAt","updatedAt")
        VALUES (${globalThis.crypto.randomUUID()}, ${c.leadId}, ${c.propertyId}, ${c.cohort},
                ${c.personRole}, ${c.email}, ${POOL_VERDICT}, NOW(), NOW(), NOW())
        ON CONFLICT ("leadId","personRole","email") DO NOTHING
        RETURNING "id"` as Array<{ id: string }>;
      if (written.length) out.proposed++; else out.alreadyQueued++;
    }
  }

  return out;
}

/**
 * Make an approved address actually usable.
 *
 * ── Why approval alone was not enough ───────────────────────────────────────
 * The review queue is a BLOCKLIST: heldAddresses() returns everything undecided or
 * rejected, and the send list and the push refuse those. Approving a row removes the
 * block — which is the whole job for an address the vendor already attributed, because
 * insuredEmails() was returning it anyway and review was only gating it.
 *
 * A pool candidate is the opposite case. Nothing attributed it, so insuredEmails() does
 * not return it, and lifting a block on an address nobody offers sends exactly as many
 * emails as before: none. Approving would have looked like it worked and changed nothing,
 * which is the failure shape this project keeps paying for.
 *
 * So an approved pool candidate is written onto the lead, into the first empty insured
 * slot, where insuredEmails() reads it first. A producer's own entry is never displaced.
 */
export async function promoteApproved(ids: string[]): Promise<{
  promoted: number;
  skipped: Array<{ email: string; why: string }>;
}> {
  if (!ids.length) return { promoted: 0, skipped: [] };

  const rows = await sql`
    SELECT r."id", r."leadId", r."email", r."personRole",
           l."email1", l."email2", l."owner2Email"
      FROM "EmailNameReview" r
      JOIN "Lead" l ON l."id" = r."leadId"
     WHERE r."id" = ANY(${ids}::text[])
       AND r."verdict" = ${POOL_VERDICT}
       AND r."decision" = 'approved'` as Array<Record<string, any>>;

  let promoted = 0;
  const skipped: Array<{ email: string; why: string }> = [];

  for (const r of rows) {
    const email = String(r.email).trim().toLowerCase();
    const held = [r.email1, r.email2, r.owner2Email]
      .map((v) => String(v ?? '').trim().toLowerCase()).filter(Boolean);
    if (held.includes(email)) { skipped.push({ email, why: 'already on the card' }); continue; }

    // First empty insured slot. Never the co-insured's, and never over a producer entry.
    const column = !String(r.email1 ?? '').trim() ? 'email1'
      : !String(r.email2 ?? '').trim() ? 'email2'
        : null;
    if (!column) { skipped.push({ email, why: 'both insured slots are already filled' }); continue; }

    await sql`
      UPDATE "Lead"
         SET "email1" = CASE WHEN ${column} = 'email1' THEN ${email} ELSE "email1" END,
             "email2" = CASE WHEN ${column} = 'email2' THEN ${email} ELSE "email2" END,
             "updatedAt" = NOW()
       WHERE "id" = ${String(r.leadId)}`;
    promoted++;
  }

  return { promoted, skipped };
}
