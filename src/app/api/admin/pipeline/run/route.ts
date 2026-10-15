import { NextRequest, NextResponse } from 'next/server';
import { sql } from '@/lib/neon';
import { verifyOwnerName } from '@/services/taxRoll.service';
import { verifyCoInsured } from '@/services/coInsuredVerify.service';
import { getSessionUser } from '@/lib/auth';
import { randomUUID } from 'crypto';
import { numbersOnCard } from '@/services/callLog.service';
import { insuredEmails, coInsuredEmails } from '@/services/recipients.service';
import { realContact, normalisePhone } from '@/lib/integrations/trestle';
import { numberedCohorts } from '@/services/cohort';

/**
 * POST /api/admin/pipeline/run?cohort=2026-10-12&grade=A&stage=roll&chunk=3
 *
 * Runs one stage of the enrichment flow over one cohort, a few leads at a time.
 *
 * ── Why a chunk and not a job ───────────────────────────────────────────────
 * A tax-roll lookup makes several HTTP calls behind a 1.5s courtesy gap, so a lead costs
 * two to nine seconds and a cohort of 159 cannot finish inside any serverless budget. The
 * caller loops this endpoint and watches the remaining count fall — the same shape the
 * skip-trace blast already uses, for the same reason.
 *
 * ── Why the roll stage and not the others ───────────────────────────────────
 * This is the only step in the flow that spends no credits. Tracing is 15 credits a lead
 * and Trestle is charged per lookup, and the rule set on 13 Oct is that neither moves
 * without somebody deciding. So those stay a deliberate script run with a cost in front of
 * them; this one can be a button.
 *
 * It is still not unattended: a mass run against small municipal services is a business
 * decision BIA has not yet taken (see the header of taxRoll.service), and this is per
 * cohort by design — never the whole book.
 *
 * ── Grade A only, for now ───────────────────────────────────────────────────
 * Abdullah, 14 Oct: settle the flow on Grade A first. Grade B is 3,481 leads that have
 * barely been traced and would triple the load on the rolls before the shape is agreed.
 */
export const dynamic = 'force-dynamic';
export const maxDuration = 30;

const DEFAULT_CHUNK = 3;
const MAX_CHUNK = 5;
/**
 * The contact check gets its own ceiling because its unit of work is a different size.
 *
 * A roll lookup is several HTTP calls behind a 1.5s courtesy gap, so three of them already
 * fill the budget. An identity lookup is one call of about half a second. Holding contacts
 * to five would turn a 548-lookup cohort into 110 round trips of mostly idle time; fifteen
 * keeps a chunk near 12s and the whole cohort inside 37 calls.
 */
const DEFAULT_CHUNK_CONTACTS = 10;
const MAX_CHUNK_CONTACTS = 15;
/** Courtesy gap between vendor calls, matching the skip-trace route. */
const GAP_MS = 200;
/** Settled on Grade A first; widening this is a decision, not a parameter. */
const ALLOWED_GRADES = ['A'];

export async function POST(req: NextRequest) {
  try {
    const p = req.nextUrl.searchParams;
    const cohort = (p.get('cohort') ?? '').trim();
    const grade = (p.get('grade') ?? 'A').trim();
    const stage = (p.get('stage') ?? 'roll').trim();
    const retryNotFound = p.get('retryNotFound') === '1';

    if (!/^\d{4}-\d{2}-\d{2}$/.test(cohort)) {
      return NextResponse.json({ success: false, error: 'A cohort is the Monday of a renewal week.' }, { status: 400 });
    }
    /**
     * Inside the numbered programme only — C1 through C8, nothing either side.
     *
     * The book holds renewal weeks from before the programme started and at least one far
     * beyond it, and they are not on the pipeline screen on purpose. Without this the
     * endpoint would still run them: 2026-09-28 answered a contact count of 26 on 14 Oct,
     * which is 26 paid lookups against a population nobody is tracking and nobody would see
     * the result of. The screen's scope and the endpoint's scope have to be the same thing.
     */
    if (!numberedCohorts().includes(cohort)) {
      return NextResponse.json(
        { success: false, error: `${cohort} is not one of the numbered waves (C1–C8).` },
        { status: 400 },
      );
    }
    if (!ALLOWED_GRADES.includes(grade)) {
      return NextResponse.json(
        { success: false, error: `Only grade ${ALLOWED_GRADES.join('/')} can be run from here for now.` },
        { status: 400 },
      );
    }
    if (stage !== 'roll' && stage !== 'contacts') {
      /**
       * Named explicitly so the refusal says what is wrong rather than 404ing.
       *
       * The skip trace is still not here on purpose. It is 15 credits a lead and it is the
       * one step that can be wrong in a way money cannot undo — a trace run on an unchecked
       * name buys the wrong person. It stays a deliberate script run.
       */
      return NextResponse.json(
        { success: false, error: 'Only the tax-roll and contact-check stages run from here. The skip trace stays a deliberate run.' },
        { status: 400 },
      );
    }

    /**
     * ── The contact check: counted before it is run ───────────────────────────
     *
     * This one costs money per lookup, so `dry` answers "how many would you ask?" without
     * asking any of them. The screen shows that number in front of the person clicking,
     * which is what turns a button into permission rather than a surprise.
     */
    const dflt = stage === 'contacts' ? DEFAULT_CHUNK_CONTACTS : DEFAULT_CHUNK;
    const cap = stage === 'contacts' ? MAX_CHUNK_CONTACTS : MAX_CHUNK;
    const chunkRaw = Number(p.get('chunk') ?? dflt);
    const chunk = Math.min(Math.max(Number.isFinite(chunkRaw) ? chunkRaw : dflt, 1), cap);
    const user = await getSessionUser(req);

    if (stage === 'contacts') {
      return runContacts(cohort, grade, chunk, p.get('dry') === '1');
    }

    /**
     * Never-checked leads first; already-failed ones only when asked.
     *
     * A card that came back not_found has usually been through every address variant and
     * every town we hold, so re-asking it on every pass would spend the whole chunk
     * re-learning the same no. retryNotFound is for after a town has been added.
     */
    const pending = await sql`
      SELECT "id", "propertyId"
        FROM "Lead"
       WHERE "cohort" = ${cohort}
         AND COALESCE("manualGrade","grade") = ${grade}
         AND ("ownerVerifyAt" IS NULL
              OR (${retryNotFound} AND "ownerVerifyStatus" IN ('not_found','unsupported','unavailable')))
       ORDER BY "propertyId"` as Array<{ id: string; propertyId: string }>;

    const batch = pending.slice(0, chunk);
    const results: Array<{ propertyId: string; status: string; rollName?: string | null }> = [];

    for (const row of batch) {
      /**
       * Re-read immediately before the lookup.
       *
       * Another admin's run, or the button on the card, may have checked this lead since
       * the list above was built. Without this, two people watching the same cohort would
       * both ask the roll about the same property.
       */
      const [lead] = await sql`
        SELECT "id","propertyId","addressStreet","addressZip","ownerVerifyAt",
               "owner1FirstName","owner1LastName","owner2FirstName","owner2LastName"
          FROM "Lead" WHERE "id" = ${row.id}` as Array<Record<string, any>>;
      if (!lead) continue;
      if (lead.ownerVerifyAt && !retryNotFound) continue;

      const r = await verifyOwnerName({
        addressStreet: lead.addressStreet,
        addressZip: lead.addressZip,
        owner1FirstName: lead.owner1FirstName,
        owner1LastName: lead.owner1LastName,
      });

      const hasRecord = 'recordName' in r;
      const rollName = hasRecord ? (r as any).recordName ?? null : null;

      /**
       * An outage is not a verdict.
       *
       * 'unavailable' means we could not reach the roll, and writing that as a fact about
       * the property is how an outage became "not on the tax roll" across every lead it
       * touched. It is recorded as its own status so the next pass retries it.
       */
      await sql`
        UPDATE "Lead"
           SET "ownerVerifyStatus" = ${r.status},
               "ownerVerifyName"   = COALESCE(${rollName}, "ownerVerifyName"),
               "ownerVerifySource" = ${hasRecord ? (r as any).source : `tax_roll_${r.status}`},
               "ownerVerifyAt"     = NOW(),
               "ownerVerifyDetail" = ${r.detail}
         WHERE "id" = ${lead.id}`;

      /**
       * The co-insured verdict is two readings of the same string, so it moves with it.
       *
       * When these drifted apart on 13 Oct, 14 cards ended up with a fresh insured verdict
       * and a co-insured one that had never been computed — including deeds that named a
       * second person nobody could see. It costs nothing: no call, no credit.
       */
      if (hasRecord) {
        const co = verifyCoInsured({ ...lead, ownerVerifyName: rollName });
        if (co) {
          await sql`
            UPDATE "Lead"
               SET "coInsuredVerifyStatus" = ${co.status},
                   "coInsuredVerifyName"   = ${co.rollName},
                   "coInsuredVerifyDetail" = ${co.detail},
                   "coInsuredVerifyAt"     = NOW()
             WHERE "id" = ${lead.id}`;
        }
      }

      results.push({ propertyId: String(lead.propertyId), status: r.status, rollName });
    }

    return NextResponse.json({
      success: true,
      cohort,
      grade,
      processed: results.length,
      // What is left AFTER this chunk, so the caller can stop without a second request.
      remaining: Math.max(0, pending.length - results.length),
      done: pending.length - results.length <= 0,
      results,
      by: user?.email ?? null,
    });
  } catch (err) {
    console.error('POST /api/admin/pipeline/run error:', err);
    return NextResponse.json(
      { success: false, error: err instanceof Error ? err.message : 'Could not run the stage' },
      { status: 500 },
    );
  }
}

/**
 * Grade a cohort's contact points through the identity check, a few at a time.
 *
 * ── Why the card's own lists and not the slot columns ───────────────────────
 * numbersOnCard and insuredEmails/coInsuredEmails are what the caller and the campaign
 * actually see. Grading phone1/phone2/owner2Phone instead covered 172 of C2's 473 numbers
 * and 134 of its 192 addresses, which left most of a card unmarked and the question "which
 * of these can I trust" unanswerable. If it is on the card, it gets a verdict.
 *
 * ── Why emailsAll and phonesAll are excluded ────────────────────────────────
 * Those are everything the trace returned for the PROPERTY, prior residents included — one
 * card holds 14 numbers of which 11 belong to people who moved out. Paying to learn that
 * is the Cifelli card again.
 */
async function runContacts(
  cohort: string,
  grade: string,
  chunk: number,
  dry: boolean,
) {
  const leads = await sql`
    SELECT * FROM "Lead"
     WHERE "cohort" = ${cohort} AND COALESCE("manualGrade","grade") = ${grade}
     ORDER BY "propertyId"` as Array<Record<string, any>>;

  const graded = new Set(
    (await sql`
      SELECT v."leadId", v."value", v."personRole"
        FROM "ContactVerification" v
        JOIN "Lead" l ON l."id" = v."leadId"
       WHERE l."cohort" = ${cohort}` as Array<Record<string, unknown>>)
      .map((r) => `${r.leadId}|${r.value}|${r.personRole}`),
  );

  const name = (f: unknown, l: unknown) => [f, l].filter(Boolean).join(' ').trim();
  type Job = { lead: Record<string, any>; channel: 'phone' | 'email'; value: string; role: string; who: string; phone: string };
  const jobs: Job[] = [];

  for (const l of leads) {
    const insured = name(l.owner1FirstName, l.owner1LastName);
    const co = name(l.owner2FirstName, l.owner2LastName);
    // A co-insured slot holding a copy of the insured's own name is not a second person.
    const coIsReal = !!co && co.toLowerCase() !== insured.toLowerCase();

    for (const n of numbersOnCard(l)) {
      const phone = normalisePhone(n.number);
      const role = n.role === 'co_insured' ? 'coInsured' : 'insured';
      const who = n.person ?? (role === 'insured' ? insured : co);
      if (!phone || !who) continue;
      if (graded.has(`${l.id}|${phone}|${role}`)) continue;
      jobs.push({ lead: l, channel: 'phone', value: phone, role, who, phone });
    }

    const addrs: Array<[string, string, string]> = [
      ...insuredEmails(l).map((e: string) => [e, 'insured', insured] as [string, string, string]),
      ...(coIsReal ? coInsuredEmails(l).map((e: string) => [e, 'coInsured', co] as [string, string, string]) : []),
    ];
    for (const [raw, role, who] of addrs) {
      const value = String(raw ?? '').trim().toLowerCase();
      if (!value || !who) continue;
      if (graded.has(`${l.id}|${value}|${role}`)) continue;
      /**
       * An address needs a phone to ride on — the provider requires one. Without a number
       * for THAT person we cannot ask, and borrowing somebody else's would score the answer
       * against a number that is not theirs.
       */
      const phone = normalisePhone(role === 'insured' ? (l.phone1 ?? l.phone2) : l.owner2Phone);
      if (!phone) continue;
      jobs.push({ lead: l, channel: 'email', value, role, who, phone });
    }
  }

  if (dry) {
    return NextResponse.json({
      success: true, cohort, grade, dry: true,
      pending: jobs.length,
      numbers: jobs.filter((j) => j.channel === 'phone').length,
      emails: jobs.filter((j) => j.channel === 'email').length,
    });
  }

  const batch = jobs.slice(0, chunk);
  const results: Array<{ value: string; channel: string; verdict: string }> = [];
  let quota = false;

  for (const j of batch) {
    let g: any = null; let err = '';
    try {
      g = await realContact({
        name: j.who,
        phone: j.phone,
        email: j.channel === 'email' ? j.value : null,
        street: j.lead.addressStreet, city: j.lead.addressCity,
        state: j.lead.addressState ?? 'NJ', zip: j.lead.addressZip,
      });
    } catch (e) {
      err = String((e as Error)?.message ?? e);
      /**
       * Quota ends the run rather than being written as a verdict.
       *
       * When the trial allowance ran out mid-batch, every remaining lookup returned 429. A
       * run that carried on would have recorded 201 numbers as unverifiable when the truth
       * was that we had stopped being allowed to ask.
       */
      if (err.startsWith('TRESTLE_QUOTA')) { quota = true; break; }
    }

    const nameMatch = j.channel === 'phone' ? g?.nameMatch ?? null : g?.emailNameMatch ?? null;
    const isValid = j.channel === 'phone' ? g?.isValid ?? null : g?.emailIsValid ?? null;

    const isPhone = j.channel === 'phone';
    await sql`
      INSERT INTO "ContactVerification"
        ("id","leadId","channel","value","personRole","nameSent","nameMatch","isValid",
         "activityScore","contactGrade","lineType","emailAgeScore","emailContactGrade",
         "provider","checkedAt","error")
      VALUES (${randomUUID()}, ${j.lead.id}, ${j.channel}, ${j.value}, ${j.role}, ${j.who},
              ${nameMatch}, ${isValid},
              ${isPhone ? g?.activityScore ?? null : null},
              ${isPhone ? g?.contactGrade ?? null : null},
              ${isPhone ? g?.lineType ?? null : null},
              ${isPhone ? null : g?.emailAgeScore ?? null},
              ${isPhone ? null : g?.emailContactGrade ?? null},
              'trestle', ${g ? new Date().toISOString() : null}, ${err || null})
      ON CONFLICT ("leadId","value","personRole") DO UPDATE SET
        "nameSent" = EXCLUDED."nameSent", "nameMatch" = EXCLUDED."nameMatch",
        "isValid" = EXCLUDED."isValid", "activityScore" = EXCLUDED."activityScore",
        "contactGrade" = EXCLUDED."contactGrade", "lineType" = EXCLUDED."lineType",
        "emailAgeScore" = EXCLUDED."emailAgeScore",
        "emailContactGrade" = EXCLUDED."emailContactGrade",
        "checkedAt" = EXCLUDED."checkedAt", "error" = EXCLUDED."error"`;

    results.push({
      value: j.value, channel: j.channel,
      verdict: !g ? 'error' : nameMatch === false ? 'not theirs' : nameMatch === true ? 'theirs' : 'no answer',
    });
    await new Promise((r) => setTimeout(r, GAP_MS));
  }

  return NextResponse.json({
    success: true, cohort, grade,
    processed: results.length,
    remaining: Math.max(0, jobs.length - results.length),
    done: !quota && jobs.length - results.length <= 0,
    quota,
    results,
  });
}
