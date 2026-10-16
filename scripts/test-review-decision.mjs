/**
 * End-to-end test for a person settling a name the roll could not.
 *
 *   node --import ./scripts/lib/register-ts.mjs scripts/test-review-decision.mjs
 *
 * ── What it proves ──────────────────────────────────────────────────────────
 * Abdullah, 16 Oct 2026: "there is no functionality to set that lead that yes now human eye
 * check it and now it is confirmed. Also keep record who confirm it."
 *
 * The feature is only real if all four of these hold at once, so all four are asserted
 * against the live route handler and the live services — not re-implementations:
 *
 *   1. the decision is recorded with WHO took it and when;
 *   2. the card leaves the review queue, for both answers;
 *   3. direct mail's Gate 0 accepts a confirmation and never accepts a rejection;
 *   4. the township's own verdict is NOT overwritten, so "the deed confirms this" stays
 *      distinguishable from "a colleague was satisfied".
 *
 * ── It runs against the real database ───────────────────────────────────────
 * Dev and production share one Neon instance, so this picks ONE existing lead, snapshots
 * every column it is about to touch, and restores it in a finally block — including the
 * Activity rows it caused and the session it minted. It spends no vendor credit: nothing here
 * calls Lob, Trestle or a township.
 */
import './lib/env.mjs';
import { neon } from '@neondatabase/serverless';
import { SignJWT } from 'jose';
import crypto from 'node:crypto';
import { NextRequest } from 'next/server';
import { POST as decide } from '@/app/api/admin/review-queue/decide/route.ts';
import { getReviewQueue, getDecided } from '@/services/reviewQueue.service.ts';
import { mailStateOf, letterVarsFor } from '@/services/directMail.service.ts';
import { getLeadByPropertyId } from '@/services/storage.service.ts';

const sql = neon(process.env.DATABASE_URL);
const SECRET = new TextEncoder().encode(
  process.env.JWT_SECRET || 'bia-crm-secret-change-in-production-2026',
);

let pass = 0;
const failures = [];
const ok = (label, cond, got) => {
  if (cond) { pass++; console.log(`  ok   ${label}`); }
  else { failures.push(`${label}${got === undefined ? '' : ` — got ${JSON.stringify(got)}`}`); console.log(`  FAIL ${label} → ${JSON.stringify(got)}`); }
};
const eq = (label, got, want) => ok(label, got === want, got);

const leadRow = async (id) => (await sql`SELECT * FROM "Lead" WHERE "id" = ${id}`)[0];

/** The real handler, called the way the browser calls it: a cookie and a JSON body. */
const call = async (cookie, body) => {
  const req = new NextRequest('http://localhost:3000/api/admin/review-queue/decide', {
    method: 'POST',
    headers: { 'content-type': 'application/json', cookie },
    body: JSON.stringify(body),
  });
  const res = await decide(req);
  return { status: res.status, json: await res.json() };
};

let snapshot = null;
let sessionId = null;
let startedAt = null;

try {
  // ── A real signed-in person ──────────────────────────────────────────────
  const [user] = await sql`
    SELECT "id","email","role" FROM "User" WHERE "isActive" = true
     ORDER BY ("role" = 'superadmin') DESC LIMIT 1`;
  if (!user) throw new Error('No active user to act as');
  const token = await new SignJWT({ sub: user.id, email: user.email, role: user.role })
    .setProtectedHeader({ alg: 'HS256' }).setIssuedAt().setExpirationTime('1h').sign(SECRET);
  sessionId = crypto.randomUUID();
  await sql`INSERT INTO "Session" ("id","userId","token","expiresAt")
            VALUES (${sessionId}, ${user.id}, ${token}, ${new Date(Date.now() + 36e5).toISOString()})`;
  const cookie = `bia_session=${token}`;

  /*
   * The subject: a Grade A card the roll could not confirm, which already has somewhere to
   * post a letter. Chosen that way so the Gate 0 assertion is about the decision and not
   * about a missing address.
   *
   * One with a rated premium is preferred, because only those can reach 'ready' — the band is
   * derived from the carrier quotes rather than stored, so it cannot be asked for in SQL. If
   * none of the candidates is rated the test still runs and expects 'awaiting_rating': that
   * is Gate 0 passing and the RATING gate holding, which is the correct answer and a
   * different fact from "a person's decision was ignored".
   */
  const candidates = await sql`
    SELECT * FROM "Lead"
     WHERE COALESCE("manualGrade","grade") = 'A'
       AND "cohort" >= '2026-10-05' AND "cohort" <= '2026-11-23'
       AND "ownerReviewDecision" IS NULL
       AND "ownerVerifyStatus" IS NOT NULL
       AND "ownerVerifyStatus" NOT IN ('match','unsupported')
       AND COALESCE("mailStreet",'') <> '' AND COALESCE("mailZip",'') <> ''
       AND "propertyId" IS NOT NULL
     ORDER BY "cohort" DESC LIMIT 60`;
  const rated = candidates.find((l) => {
    const v = letterVarsFor(l);
    return !!v.band_low && !!v.band_high;
  });
  const subject = rated ?? candidates[0];
  if (!subject) throw new Error('No undecided non-match Grade A card with a mailing address');
  const expectAfterYes = rated ? 'ready' : 'awaiting_rating';

  snapshot = await leadRow(subject.id);
  startedAt = new Date().toISOString();
  console.log(`\nSubject: ${subject.propertyId} — roll says "${snapshot.ownerVerifyName ?? '—'}" (${subject.ownerVerifyStatus})`);
  console.log(`Acting as: ${user.email}\n`);

  // ── Before ───────────────────────────────────────────────────────────────
  console.log('Before anybody looks at it:');
  eq('Gate 0 holds it back', mailStateOf(snapshot), 'needs_person');
  const before = await getReviewQueue({ grade: 'A' });
  ok('it is on the waiting list', before.items.some((i) => i.propertyId === subject.propertyId));
  const histBefore = await getDecided({ grade: 'A' });
  ok('it is not in the decisions', !histBefore.items.some((i) => i.propertyId === subject.propertyId));

  // ── Authentication is not optional ───────────────────────────────────────
  console.log('\nA stranger cannot decide anything:');
  const anon = await call('', { propertyId: subject.propertyId, decision: 'confirmed' });
  eq('no cookie is refused', anon.status, 401);
  const stillNull = await leadRow(subject.id);
  eq('and nothing was written', stillNull.ownerReviewDecision, null);

  console.log('\nA nonsense decision is refused:');
  const bad = await call(cookie, { propertyId: subject.propertyId, decision: 'probably' });
  eq('unknown verb rejected', bad.status, 400);
  const bad2 = await call(cookie, { decision: 'confirmed' });
  eq('missing card rejected', bad2.status, 400);

  // ── Confirmed ────────────────────────────────────────────────────────────
  console.log('\nA person confirms the name:');
  const yes = await call(cookie, {
    propertyId: subject.propertyId, decision: 'confirmed', note: 'automated test — spoke to the insured',
  });
  eq('the handler accepts it', yes.status, 200);
  ok('and says who recorded it', yes.json.by === user.email, yes.json.by);

  const afterYes = await leadRow(subject.id);
  eq('the decision is stored', afterYes.ownerReviewDecision, 'confirmed');
  eq('with the person who took it', afterYes.ownerReviewBy, user.email);
  ok('and when', !!afterYes.ownerReviewAt, afterYes.ownerReviewAt);
  eq('the note is kept', afterYes.ownerReviewNote, 'automated test — spoke to the insured');
  eq('the roll name it was decided against is kept', afterYes.ownerReviewRollName, snapshot.ownerVerifyName ?? null);
  eq('and the verdict it overrode', afterYes.ownerReviewStatusAt, snapshot.ownerVerifyStatus);

  /*
   * The whole point of the separate column. If a decision wrote 'match' into the township's
   * own field, no screen could ever say which kind of evidence it was relying on.
   */
  eq("the township's verdict is untouched", afterYes.ownerVerifyStatus, snapshot.ownerVerifyStatus);
  eq("and the township's name is untouched", afterYes.ownerVerifyName, snapshot.ownerVerifyName);

  const [act] = await sql`
    SELECT "type","content","createdBy" FROM "Activity"
     WHERE "leadId" = ${subject.id} AND "createdAt" >= ${startedAt}
     ORDER BY "createdAt" DESC LIMIT 1`;
  eq('an activity entry is written', act?.type, 'owner_review_confirmed');
  eq('attributed in the column, not only the sentence', act?.createdBy, user.email);

  const queueYes = await getReviewQueue({ grade: 'A' });
  ok('the card leaves the waiting list', !queueYes.items.some((i) => i.propertyId === subject.propertyId));
  const stateYes = mailStateOf(afterYes);
  ok('Gate 0 no longer holds it for a person', stateYes !== 'needs_person', stateYes);
  eq(rated ? 'and it is mailable' : 'and only the carrier rating is left', stateYes, expectAfterYes);

  /*
   * The lead card reads through an explicit column list, not SELECT *. A column missing from
   * it reads back undefined, which is how a decision becomes invisible on the one screen a
   * reviewer actually opens — the trap that list has sprung before.
   */
  const card = await getLeadByPropertyId(subject.propertyId);
  eq('the lead card can see the decision', card?.ownerReviewDecision, 'confirmed');
  eq('and who took it', card?.ownerReviewBy, user.email);

  const histYes = await getDecided({ grade: 'A' });
  const mine = histYes.items.find((i) => i.propertyId === subject.propertyId);
  ok('it appears in the decisions', !!mine);
  eq('shown as confirmed', mine?.decision, 'confirmed');
  eq('with the decider named', mine?.by, user.email);
  ok('and not flagged as decided on changed evidence', mine?.stale === false, mine?.stale);

  // ── Rejected ─────────────────────────────────────────────────────────────
  console.log('\nThe same person changes their mind to "not ours":');
  const no = await call(cookie, { propertyId: subject.propertyId, decision: 'rejected' });
  eq('accepted', no.status, 200);
  const afterNo = await leadRow(subject.id);
  eq('stored as rejected', afterNo.ownerReviewDecision, 'rejected');
  eq('the earlier note is cleared with the decision', afterNo.ownerReviewNote, null);
  eq('a rejection NEVER becomes mailable', mailStateOf(afterNo), 'needs_person');
  const queueNo = await getReviewQueue({ grade: 'A' });
  ok('and it stays off the waiting list', !queueNo.items.some((i) => i.propertyId === subject.propertyId));

  // ── Reopened ─────────────────────────────────────────────────────────────
  console.log('\nSomebody reopens it:');
  const re = await call(cookie, { propertyId: subject.propertyId, decision: 'reopen' });
  eq('accepted', re.status, 200);
  const afterRe = await leadRow(subject.id);
  eq('the decision is cleared', afterRe.ownerReviewDecision, null);
  eq('the decider is cleared', afterRe.ownerReviewBy, null);
  eq('back to needing a person', mailStateOf(afterRe), 'needs_person');
  const queueRe = await getReviewQueue({ grade: 'A' });
  ok('and back on the waiting list', queueRe.items.some((i) => i.propertyId === subject.propertyId));
  const [reAct] = await sql`
    SELECT "type","createdBy" FROM "Activity"
     WHERE "leadId" = ${subject.id} AND "type" = 'owner_review_reopened' AND "createdAt" >= ${startedAt}
     ORDER BY "createdAt" DESC LIMIT 1`;
  eq('the reopening is itself recorded', reAct?.type, 'owner_review_reopened');

  // ── Drift ────────────────────────────────────────────────────────────────
  console.log('\nA decision taken against a roll answer that later changes:');
  await sql`
    UPDATE "Lead"
       SET "ownerReviewDecision" = 'confirmed', "ownerReviewBy" = ${user.email},
           "ownerReviewAt" = NOW(), "ownerReviewRollName" = 'SOMEBODY, ELSE',
           "ownerReviewStatusAt" = 'mismatch'
     WHERE "id" = ${subject.id}`;
  const histStale = await getDecided({ grade: 'A' });
  const staleRow = histStale.items.find((i) => i.propertyId === subject.propertyId);
  ok('is flagged as stale', staleRow?.stale === true, staleRow?.stale);
  ok('and counted', histStale.counts.stale >= 1, histStale.counts.stale);
} catch (err) {
  failures.push(`threw: ${err instanceof Error ? err.message : String(err)}`);
  console.error('\n', err);
} finally {
  // ── Put the record back exactly as it was ────────────────────────────────
  if (snapshot) {
    await sql`
      UPDATE "Lead"
         SET "ownerReviewDecision"  = ${snapshot.ownerReviewDecision ?? null},
             "ownerReviewBy"        = ${snapshot.ownerReviewBy ?? null},
             "ownerReviewAt"        = ${snapshot.ownerReviewAt ?? null},
             "ownerReviewNote"      = ${snapshot.ownerReviewNote ?? null},
             "ownerReviewRollName"  = ${snapshot.ownerReviewRollName ?? null},
             "ownerReviewStatusAt"  = ${snapshot.ownerReviewStatusAt ?? null},
             "ownerVerifyStatus"    = ${snapshot.ownerVerifyStatus ?? null},
             "ownerVerifyName"      = ${snapshot.ownerVerifyName ?? null}
       WHERE "id" = ${snapshot.id}`;
    if (startedAt) {
      await sql`
        DELETE FROM "Activity"
         WHERE "leadId" = ${snapshot.id} AND "createdAt" >= ${startedAt}
           AND "type" IN ('owner_review_confirmed','owner_review_rejected','owner_review_reopened')`;
    }
    const back = await leadRow(snapshot.id);
    const clean = back.ownerReviewDecision === (snapshot.ownerReviewDecision ?? null)
      && back.ownerVerifyStatus === (snapshot.ownerVerifyStatus ?? null);
    console.log(`\nRestored ${snapshot.propertyId}: ${clean ? 'clean' : 'CHECK THIS LEAD BY HAND'}`);
    if (!clean) failures.push('the subject lead was not restored');
  }
  if (sessionId) await sql`DELETE FROM "Session" WHERE "id" = ${sessionId}`;
}

console.log(`\n${pass} passed, ${failures.length} failed`);
if (failures.length) {
  for (const f of failures) console.log(`  · ${f}`);
  process.exit(1);
}
