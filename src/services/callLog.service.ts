import { notifyEngagement } from './engagementNotify.service';
import { sql, pool } from '@/lib/neon';
import { stopHousehold, type HouseholdStopResult } from './householdStop.service';
import { easternDay, utcStoredToDate, easternInputToUtc } from '@/lib/wallClock';
import { insuredPhones, coInsuredPhones } from './recipients.service';
import { suppress, suppressionFor } from './suppression.service';
import { addActivity } from './storage.service';
import { closeRemindersForCall } from './callReminder.service';
import {
  CALL_OUTCOMES, CALL_OUTCOME_LABEL, STATUS_FOR_OUTCOME,
  meetsUnreachableRule, isDeepTail,
  NOT_INTERESTED_RECONTACT_DAYS_BEFORE_RENEWAL,
  type CallOutcome, type CallStatus,
} from '@/lib/callOutcomes';

/**
 * Producer call activity (directive Sec. 10.5) — "the gap that closes first".
 *
 * Every attempt is a row. Status is derived from those rows and never stored as a fact
 * anyone types, because a typed status stops agreeing with the attempts underneath it the
 * first time someone forgets to change it, and then the call queue rests on a field nobody
 * trusts.
 *
 * ── What the outcome does ───────────────────────────────────────────────────
 * Logging is not filing. "Bad number" takes that number out of rotation so the next
 * attempt reaches a different line; "do not call" suppresses the household across every
 * channel, not just the phone. The action happens in the same transaction as the record,
 * so a card can never say a customer asked not to be called while the next cohort emails
 * them.
 */

export type CallAttempt = {
  id: string;
  leadId: string;
  numberDialled: string;
  numberRole: string | null;
  numberLabel: string | null;
  attemptedAt: string;
  durationSeconds: number | null;
  outcome: CallOutcome;
  callbackAt: string | null;
  notes: string | null;
  calledBy: string | null;
};

export type CallState = {
  status: CallStatus;
  attempts: CallAttempt[];
  attemptCount: number;
  /** Distinct numbers actually dialled — not how many are on the card. */
  numbersTried: string[];
  distinctDays: number;
  lastAttemptAt: string | null;
  nextCallbackAt: string | null;
  /** Numbers proven dead or wrong. Never offered again. */
  invalidNumbers: string[];
  /** Still worth dialling: on the card, not invalid, household not suppressed. */
  dialable: Array<{ number: string; role: 'insured' | 'co_insured'; label: string }>;
  /** Why the queue is not offering this lead, when it is not. */
  blockedReason: string | null;
};

/**
 * The EASTERN calendar day a call happened on.
 *
 * This was the first ten characters of the stored string, which is the UTC date. A call
 * placed at 11:42 PM in New Jersey stores as 04:42 the following day, so an evening's
 * calling was split across two days — and the unreachable rule turns on "3+ days".
 * Two calls one evening could satisfy it.
 */
const dayOf = (s: string) => easternDay(s);

/**
 * Every number on the card, with where it came from.
 *
 * Read through recipients.service rather than the phone columns, because a number the
 * trace returned lives inside the payload and a column read would miss it — the same
 * mismatch that had reach counts disagreeing across the CRM.
 */
/**
 * What the skip trace knows about each number.
 *
 * The payload carries far more than the digits — dnc, rank, type, tcpa, carrier — and none
 * of it was reaching the person dialling. Across C1–C3 that is 464 of 965 numbers flagged
 * DNC, on 155 of 184 accounts, invisible on the panel.
 *
 * Walked rather than read from a fixed path: the same shape appears under persons[].phones
 * and under persons[].relatives[].phones, and a fixed path finds one and silently misses
 * the other.
 */
export type NumberMeta = {
  dnc: boolean;
  tcpa: boolean;
  rank: number | null;
  type: string | null;
  carrier: string | null;
};

export function numberMetaFor(lead: Record<string, unknown>): Map<string, NumberMeta> {
  const out = new Map<string, NumberMeta>();
  const walk = (v: unknown): void => {
    if (!v || typeof v !== 'object') return;
    if (Array.isArray(v)) { v.forEach(walk); return; }
    const o = v as Record<string, unknown>;
    if (o.number && ('dnc' in o || 'rank' in o || 'type' in o)) {
      const key = String(o.number).replace(/\D/g, '');
      if (key && !out.has(key)) {
        out.set(key, {
          dnc: o.dnc === true,
          tcpa: o.tcpa === true,
          rank: typeof o.rank === 'number' ? o.rank : null,
          type: o.type == null ? null : String(o.type),
          carrier: o.carrier == null ? null : String(o.carrier),
        });
      }
    }
    Object.values(o).forEach(walk);
  };
  walk(lead.skipTraceData);
  return out;
}

/** "Jane Cagney", or null when that person has no name on the card. */
const personName = (first: unknown, last: unknown): string | null =>
  [String(first ?? '').trim(), String(last ?? '').trim()].filter(Boolean).join(' ') || null;

export function numbersOnCard(lead: Record<string, unknown>): Array<{
  number: string; role: 'insured' | 'co_insured'; label: string;
  dnc: boolean; tcpa: boolean; rank: number | null; type: string | null;
  /**
   * Whose number this is, by name.
   *
   * The role alone says "co-insured", which is a category. On a call what Ruben needs is
   * a name to ask for — dialling the co-insured's mobile and opening with the insured's
   * name is how a good number gets wasted. 698 of 998 Grade A cards carry a co-insured
   * number and 40 of them have no insured number at all, so this is the only person
   * reachable on those.
   */
  person: string | null;
}> {
  const meta = numberMetaFor(lead);
  const out: Array<{
    number: string; role: 'insured' | 'co_insured'; label: string;
    dnc: boolean; tcpa: boolean; rank: number | null; type: string | null;
    person: string | null;
  }> = [];
  const seen = new Set<string>();
  const add = (n: string, role: 'insured' | 'co_insured', label: string) => {
    const clean = String(n ?? '').replace(/\D/g, '');
    if (!clean || seen.has(clean)) return;
    seen.add(clean);
    const m = meta.get(clean);
    out.push({
      number: clean, role, label,
      dnc: m?.dnc ?? false,
      tcpa: m?.tcpa ?? false,
      rank: m?.rank ?? null,
      type: m?.type ?? null,
      person: role === 'insured'
        ? personName(lead.owner1FirstName, lead.owner1LastName)
        : personName(lead.owner2FirstName, lead.owner2LastName),
    });
  };
  for (const n of insuredPhones(lead)) {
    add(n, 'insured',
      String(lead.phone1 ?? '').replace(/\D/g, '') === String(n).replace(/\D/g, '') ? 'phone1'
        : String(lead.phone2 ?? '').replace(/\D/g, '') === String(n).replace(/\D/g, '') ? 'phone2'
          : 'trace');
  }
  for (const n of coInsuredPhones(lead)) {
    add(n, 'co_insured',
      String(lead.owner2Phone ?? '').replace(/\D/g, '') === String(n).replace(/\D/g, '') ? 'owner2Phone' : 'trace');
  }

  /**
   * ── The order Ruben should dial in (Frank, 25 Sep 2026 · item 9) ─────────
   *
   * "A dialing order for leads with many numbers (up to 19 on file)."
   *
   * Twenty-two C1–C3 accounts carry ten or more, one carries twenty, and the order was
   * simply the order they came out of the payload. On that twenty-number card the
   * co-insured's OWN number sat twentieth, behind seventeen speculative trace hits — so the
   * best number on the card was the last one anybody would reach.
   *
   * Sorted by what actually predicts a useful call:
   *
   *   1. Not DNC. A flagged number goes last, never removed — see dialable below for why
   *      it is still shown at all.
   *   2. Insured before co-insured. §1.5 makes the insured the person we want.
   *   3. The vendor's own rank — 88% of these numbers carry one.
   *   4. Mobile before landline. A mobile reaches a person; a landline reaches a house.
   *
   * ── Why rank now outranks "came with the policy" ─────────────────────────
   * The card-before-trace test used to sit above rank, on the reasoning that phone1 and
   * phone2 were supplied with the policy while a trace number is a guess. Measured across
   * the 752 Grade A cards from C1 onward that hold more than one number, it changes which
   * number comes first on exactly ONE of them. It was costing rank its say for no
   * practical gain, so rank is above it now and it survives only as the tiebreak below.
   *
   * ── Why rank is NOT the first thing sorted on ────────────────────────────
   * Asked for on 6 Oct 2026, and measured before changing: sorting purely by rank moves
   * the first number on 266 of those 752 cards, and on 160 of them the new first number is
   * DNC-FLAGGED. 464 of the 965 numbers on C1-C3 cards carry that flag, so leading with one
   * is not an edge case — it is the normal outcome. Whether a flagged number may be called
   * at all is Frank and Adnan's decision, so DNC stays last until they make it.
   *
   * ── Why rank cannot outrank insured-before-co-insured either ─────────────
   * The vendor ranks each PERSON's numbers separately. The insured's "rank 1" and the
   * co-insured's "rank 1" are two different scales, so a global sort by rank silently
   * compares numbers that were never ranked against each other — and in practice promotes
   * the co-insured over the insured on cards where both were traced.
   *
   * A card number the vendor never ranked sorts as if it were rank 0 rather than last: it
   * came with the policy, so "the vendor did not rank it" is not evidence against it, and
   * treating a missing rank as the worst rank buried the policy's own number beneath
   * speculative trace hits.
   */
  const CARD_LABELS = new Set(['phone1', 'phone2', 'owner2Phone']);
  const isMobile = (t: string | null) => /mobile|cell|wireless/i.test(String(t ?? ''));
  const rankOf = (n: { rank: number | null; label: string }) =>
    (n.rank ?? (CARD_LABELS.has(n.label) ? 0 : 99));
  /*
   * ── Landlines go last, above only the do-not-call ones ──────────────────
   *
   * Line type used to be the fourth tiebreak, below the vendor's rank. On its own that
   * ordering is nearly right — rank and mobile correlate so closely that promoting type
   * above rank changes the first number on only 4 of 563 cards. But it left landlines
   * interleaved through the list rather than at the end of it, and a landline is 87%
   * dead against a mobile's 44%.
   *
   * So it is a demotion rather than a reshuffle: everything else keeps its order, and
   * fixed lines sink beneath it. Untyped numbers stay where rank puts them, because a
   * missing type is not evidence of anything.
   */
  out.sort((x, y) =>
    Number(x.dnc) - Number(y.dnc)
    || Number(isLandline(x.type)) - Number(isLandline(y.type))
    || (x.role === y.role ? 0 : x.role === 'insured' ? -1 : 1)
    || rankOf(x) - rankOf(y)
    || Number(!isMobile(x.type)) - Number(!isMobile(y.type))
    || Number(!CARD_LABELS.has(x.label)) - Number(!CARD_LABELS.has(y.label)));

  return out;
}

/** The numbers a "bad number" or "wrong person" outcome has retired, as plain digits. */
export function invalidPhonesOf(lead: Record<string, unknown>): string[] {
  return Array.isArray(lead.invalidPhones)
    ? (lead.invalidPhones as unknown[]).map((n) => String(n ?? '').replace(/\D/g, '')).filter(Boolean)
    : [];
}

/**
 * The numbers actually worth ringing: on the card, not proven dead, not do-not-call.
 *
 * ── Why this exists rather than each screen filtering for itself ─────────────
 * There were two definitions of "numbers we can call" and neither was this one.
 *
 *   the lead card   excluded numbers proven dead, and KEPT do-not-call ones — deliberately,
 *                   because they are shown last and marked rather than hidden.
 *   the Phone list  excluded do-not-call ones, and kept the dead ones.
 *
 * So the Phone screen's "4/7" counted numbers Ruben had already discovered do not work.
 * On 16 Grade A cards from C1 onward it overstated what was left, and on two of them —
 * Christopher Chinni at "2/4" and Yvonne Hernandez at "4/6" — there was nothing dialable
 * at all. Worse than a wrong count: that screen SORTS by it, "most live numbers first", so
 * the cards with nothing to ring sorted to the top of the call list.
 *
 * The card keeps its own, wider list for DISPLAY. This is the one for COUNTING.
 */
export function liveNumbersOnCard(lead: Record<string, unknown>): ReturnType<typeof numbersOnCard> {
  const dead = new Set(invalidPhonesOf(lead));
  const live = numbersOnCard(lead).filter((n) => !n.dnc && !dead.has(n.number));

  /**
   * ── The tail of a person's number history is not "worth ringing" ─────────
   *
   * The vendor returns every number it has ever associated with a person, best first.
   * That is 21 numbers for one co-insured on Tyisha Bennett's card, against a median of
   * one. Measured against every call logged so far, how dead a number turns out to be
   * tracks its rank almost perfectly:
   *
   *     rank 1     34 calls   53% bad number or wrong person
   *     rank 2-3   37 calls   68%
   *     rank 4-6   26 calls   85%
   *     rank 7-10  12 calls   92%
   *     rank 11+    2 calls  100%
   *
   * Nobody has ever reached a person on a number ranked 7 or deeper — 0 of 14.
   *
   * This matters beyond the count, because the Phone screen SORTS by it. Carrying a
   * stale history put Tyisha Bennett at 25 "worth ringing" and sorted her above an
   * account with three good numbers, which is the opposite of what the ordering is for.
   * Demoting the tail reorders 6 of the top 10 cards in Ruben's queue.
   *
   * DEMOTED, NOT REMOVED. numbersOnCard still returns them and the card still shows
   * them, so they remain there to dial once the rest are exhausted — the same treatment
   * do-not-call numbers get, and for the same reason. A number we merely doubt is not a
   * number we may hide.
   *
   * The last-resort guard is the point of the `.length ? :` rather than a measurement
   * that happened to come out at zero: an account whose every number is ranked deep is
   * still an account with numbers, and it must never read as nothing left to ring.
   */
  /**
   * ── Landlines are held back too (Tracerfy, 12 Oct 2026) ─────────────────
   *
   * Their data team reviewed our call log and found landlines failing far worse than
   * mobiles. Checked against our own record rather than taken on trust, and they are
   * right almost to the point:
   *
   *     mobile      111 calls   44% bad number or wrong person   7 people reached
   *     landline    147 calls   87%                              1 person reached
   *     unknown      56 calls   54%                              5 people reached
   *
   * They predicted 42% and 87%. One person reached in 147 landline calls is the number
   * that decides it — a mobile is roughly ten times likelier to put Ruben in front of
   * somebody.
   *
   * An untyped number is NOT treated as a landline. 63 cards carry no line type at all,
   * and 54% dead puts the untyped group nearer the mobiles than the landlines; guessing
   * against them would bury numbers on the evidence of a missing field.
   *
   * ── The ladder, rather than one filter ──────────────────────────────────
   * Both tests at once would empty the 53 cards whose every live number is a landline.
   * So it steps down: the good numbers, then allow landlines, then everything live. A
   * card can lose quality but never lose its last number.
   */
  const best = live.filter((n) => !isDeepTail(n.rank) && !isLandline(n.type));
  if (best.length) return best;
  const allowLandlines = live.filter((n) => !isDeepTail(n.rank));
  return allowLandlines.length ? allowLandlines : live;
}

/** The first rank at which a number stops counting towards "worth ringing". */
export const DEEP_TAIL_RANK = 7;

/**
 * A number the vendor says is fixed-line.
 *
 * Deliberately not "anything that is not a mobile": `type` is absent on a good many
 * numbers, and absent is not the same as landline.
 */
const isLandline = (type: string | null): boolean => /land|fixed/i.test(String(type ?? ''));

/** Live numbers held back as a reserve because they sit deep in the vendor's ranking. */
export function reserveNumbersOnCard(lead: Record<string, unknown>): ReturnType<typeof numbersOnCard> {
  const dead = new Set(invalidPhonesOf(lead));
  const live = numbersOnCard(lead).filter((n) => !n.dnc && !dead.has(n.number));
  const counted = new Set(liveNumbersOnCard(lead).map((n) => n.number));
  return live.filter((n) => !counted.has(n.number));
}

/**
 * Derive the state for one lead.
 *
 * `blockedReason` exists so the panel can say WHY it is not offering a number. A disabled
 * control with no explanation gets worked around — somebody dials from the card instead,
 * and the attempt never gets logged, which is the failure this whole table exists to
 * prevent.
 */
export async function callState(lead: Record<string, unknown>): Promise<CallState> {
  const leadId = String(lead.id);
  /**
   * ── Attempts from before a deliberate return to the queue do not count ───
   *
   * Frank, 29 Sep 2026, after testing a few cards: "I want it back in the regular queue...
   * I can't do undo." The undo is ten minutes by design and is for a mis-tap, not for
   * setting aside a call that really happened.
   *
   * So the rows stay and the LINE moves. Everything below derives exactly as it always did,
   * over the attempts that count — which means a returned lead that is then dialled four
   * more times goes unreachable again by the ordinary rule, with no special case.
   *
   * Compared in SQL rather than in JS. attemptedAt is `timestamp without time zone`, and a
   * date comparison done in the driver reads it as server-local; that is the bug that made a
   * callback due today never appear.
   */
  const returnedAt = lead.callQueueReturnedAt ?? null;
  const rows = await sql`
    SELECT "id","leadId","numberDialled","numberRole","numberLabel",
           "attemptedAt"::text AS "attemptedAt", "durationSeconds","outcome",
           "callbackAt"::text AS "callbackAt","notes","calledBy"
      FROM "CallAttempt" WHERE "leadId" = ${leadId}
       AND (${returnedAt}::timestamp IS NULL OR "attemptedAt" > ${returnedAt}::timestamp)
     ORDER BY "attemptedAt" DESC` as CallAttempt[];

  const invalidNumbers: string[] = Array.isArray(lead.invalidPhones)
    ? (lead.invalidPhones as string[])
    : [];

  const numbersTried = [...new Set(rows.map((r) => r.numberDialled))];
  const distinctDays = new Set(rows.map((r) => dayOf(r.attemptedAt))).size;
  const onCard = numbersOnCard(lead);
  const dialable = onCard.filter((n) => !invalidNumbers.includes(n.number));

  const reachedOutcomes = new Set(CALL_OUTCOMES.filter((o) => o.reached).map((o) => o.key));
  const contacted = rows.some((r) => reachedOutcomes.has(r.outcome));

  /**
   * All three conditions, from the shared rule in @/lib/callOutcomes.
   *
   * It used to be spelled out here, and the QC report spelled out a different two-thirds of
   * it. One function now, called from both.
   */
  const unreachable = !contacted && meetsUnreachableRule({
    attempts: rows.length,
    distinctDays,
    distinctNumbersTried: numbersTried.length,
    numbersOnCard: onCard.length,
  });

  /**
   * The status follows the LATEST outcome that reached somebody (Frank, 25 Sep 2026).
   *
   * Latest, not first and not "any": it is the most recent thing the customer actually
   * said. A household that asked for a callback in March and said "not interested" in
   * September is not still owed a callback.
   *
   * `rows` is ordered newest first by the query, so the first match is the latest call.
   * Anything that reached somebody and is not in the map — there is nothing today — would
   * fall through to 'attempting', which is wrong but visible, rather than being silently
   * treated as one of the four.
   */
  const latestReached = rows.find((r) => reachedOutcomes.has(r.outcome));
  const reachedStatus = latestReached
    ? STATUS_FOR_OUTCOME[latestReached.outcome]
    : undefined;

  const status: CallStatus = reachedStatus
    ?? (unreachable ? 'unreachable'
      : rows.length ? 'attempting' : 'not_attempted');

  // S3: the DNC scrub happens before anyone dials, not after. A suppressed household is
  // not a lead to call — and the exposure lands on the producer's follow-up call, not on
  // the email.
  let blockedReason: string | null = null;
  const firstDialable = dialable[0];
  if (firstDialable) {
    const hit = await suppressionFor(lead, String(lead.email1 ?? ''));
    if (hit?.scope === 'household') {
      blockedReason = `This household is suppressed (${hit.reason}). Do not call.`;
    }
  } else if (onCard.length) {
    blockedReason = 'Every number on this card has been marked invalid.';
  } else {
    blockedReason = 'No phone number on this card.';
  }
  if (!blockedReason && status === 'unreachable') {
    blockedReason = 'Unreachable by phone — this lead has moved to the direct-mail segment.';
  }

  /**
   * Callbacks still ahead of us.
   *
   * This compared the stored text against `new Date().toISOString()` — two different
   * shapes. The stored form is "2026-09-25 09:41:00" and the ISO form is
   * "2026-09-25T18:42:00.000Z", and a string comparison puts a space before 'T', so every
   * callback dated TODAY sorted as already past and vanished from the panel. Ruben would
   * have seen a callback due this afternoon reported as nothing scheduled.
   *
   * Compared as instants now, with the stored value read as the UTC it is.
   */
  const now = Date.now();
  const upcoming = rows
    .filter((r) => {
      const at = utcStoredToDate(r.callbackAt);
      return at != null && at.getTime() > now;
    })
    .map((r) => r.callbackAt!)
    .sort();

  return {
    status,
    attempts: rows,
    attemptCount: rows.length,
    numbersTried,
    distinctDays,
    lastAttemptAt: rows[0]?.attemptedAt ?? null,
    nextCallbackAt: upcoming[0] ?? null,
    invalidNumbers,
    dialable,
    blockedReason,
  };
}

/**
 * Take back a mis-tap.
 *
 * Frank, 25 Sep 2026: "An undo for a mis-tap: (917) 566-4036 shows 'Voicemail left' and
 * then 'Bad number' 5 seconds later."
 *
 * ── Why this is more than deleting a row ────────────────────────────────────
 * Logging is not filing — an outcome acts. "Bad number" takes a line out of rotation, "do
 * not call" suppresses the household on every channel, a callback writes a date onto the
 * lead. An undo that removed the attempt and left those behind would be worse than no undo:
 * the record would say the call never happened while its consequences quietly stood.
 *
 * So each effect is reversed, and only where THIS attempt caused it. A number invalidated
 * by an earlier attempt too stays invalidated; a suppression somebody else recorded stays.
 *
 * ── Why there is a time limit ───────────────────────────────────────────────
 * This is for the five seconds after a wrong tap, not for editing history. Past the window
 * an attempt is a record of what happened, and a producer who wants it changed should say
 * so where somebody can see the correction.
 */
export const UNDO_WINDOW_MINUTES = 10;

/**
 * Put a lead back in the calling queue.
 *
 * Frank, 29 Sep 2026: "what's the best thing to get it back in the queue? I want it back in
 * the regular queue... I can't do undo." And on why it is not just about his own test rows:
 * "what if something is done incorrectly or a mistake was made and you wanted to get it
 * back — things get stuck in here."
 *
 * ── Not an undo, and deliberately not one ───────────────────────────────────
 * The undo deletes an attempt and is limited to ten minutes, because past that an attempt
 * is a record of a call that really happened and the call log is what contactability is
 * computed from. This deletes nothing. It draws a line and says the calling story starts
 * again after it — so the card keeps both the calls and the fact that somebody set them
 * aside, which is precisely what a wider undo window would have destroyed.
 *
 * ── What it does reverse ────────────────────────────────────────────────────
 * "Back in the queue" has to mean actually callable, or it is a button that appears to work.
 * A number one of those attempts marked bad stays out of rotation unless this clears it —
 * the lead would return to the queue with nothing dialable on it. So invalidations caused by
 * the discounted attempts are lifted, by the same test the undo uses: only where no OTHER
 * attempt independently condemned that number.
 *
 * ── What it refuses to reverse ──────────────────────────────────────────────
 * A suppression. "Not interested" and "do not call" are a person's own words, and quietly
 * lifting one to tidy a queue is how a household that asked us to stop gets rung again. If
 * the calls being set aside produced a live suppression, this refuses and says so; releasing
 * it is a separate, deliberate act with its own record.
 */
export async function returnToQueue(input: {
  lead: Record<string, unknown>;
  by?: string | null;
  reason?: string | null;
}): Promise<{ returned: boolean; discounted?: number; restoredNumbers?: string[]; reason?: string }> {
  const leadId = String(input.lead.id);

  // Only the attempts that currently count — a lead can be returned to the queue twice.
  const priorLine = (input.lead.callQueueReturnedAt ?? null) as string | null;
  const attempts = (await sql`
    SELECT "id","outcome","numberDialled" FROM "CallAttempt"
     WHERE "leadId" = ${leadId}
       AND (${priorLine}::timestamp IS NULL OR "attemptedAt" > ${priorLine}::timestamp)`
  ) as Array<{ id: string; outcome: CallOutcome; numberDialled: string }>;

  if (!attempts.length) {
    return { returned: false, reason: 'This lead has no calls against it — it is already in the queue.' };
  }

  /**
   * A live suppression from one of these calls stops this outright.
   *
   * Checked before anything is written, so a refusal leaves the lead exactly as it was.
   */
  const suppressing = attempts
    .map((a) => CALL_OUTCOMES.find((o) => o.key === a.outcome)?.suppresses)
    .filter(Boolean) as string[];
  if (suppressing.length) {
    const [live] = await sql`
      SELECT COUNT(*)::int AS n FROM "Suppression"
       WHERE "leadId" = ${leadId} AND "releasedAt" IS NULL
         AND "reason" = ANY(${[...new Set(suppressing)]}::text[])` as Array<{ n: number }>;
    if (Number(live?.n ?? 0) > 0) {
      return {
        returned: false,
        reason: 'Someone on this household said not to contact them, and that is still in force. '
          + 'Release the suppression first if it was recorded in error — returning the lead to the '
          + 'queue will not undo what they asked for.',
      };
    }
  }

  /**
   * Numbers these attempts condemned, where nothing outside the discounted set condemns them
   * too. Same rule as the undo: an independent "bad number" on the same line stands.
   */
  const condemned = [...new Set(attempts
    .filter((a) => CALL_OUTCOMES.find((o) => o.key === a.outcome)?.invalidatesNumber)
    .map((a) => a.numberDialled))];
  const ids = attempts.map((a) => a.id);
  const restored: string[] = [];
  for (const number of condemned) {
    const [others] = await sql`
      SELECT COUNT(*)::int AS n FROM "CallAttempt"
       WHERE "leadId" = ${leadId} AND "numberDialled" = ${number}
         AND NOT ("id" = ANY(${ids}::text[]))
         AND "outcome" IN ('bad_number','wrong_person')` as Array<{ n: number }>;
    if (Number(others?.n ?? 0) === 0) restored.push(number);
  }

  const invalid: string[] = Array.isArray(input.lead.invalidPhones)
    ? (input.lead.invalidPhones as string[]) : [];
  const keptInvalid = invalid.filter((n) => !restored.includes(n));

  /**
   * The line, the restored numbers and the cleared callback move together.
   *
   * NOW() rather than a time from the caller: this is compared against attemptedAt, which is
   * `timestamp without time zone` written by the server. A browser clock reaching that
   * comparison is the bug that hid a callback that was due today.
   */
  await sql`
    UPDATE "Lead"
       SET "callQueueReturnedAt"     = NOW(),
           "callQueueReturnedBy"     = ${input.by ?? null},
           "callQueueReturnedReason" = ${input.reason ?? null},
           "invalidPhones"           = ${JSON.stringify(keptInvalid)}::jsonb,
           "revisitFlag"             = FALSE,
           "revisitDate"             = NULL,
           "revisitNote"             = NULL,
           "callUnreachableAt"       = NULL,
           "updatedAt"               = NOW()
     WHERE "id" = ${leadId}`;

  /**
   * Any reminder still pointing at the old story is closed, or Ruben gets a notification
   * about a callback for a lead whose calling has been reset.
   */
  await closeRemindersForCall(leadId, input.by ?? null).catch(() => {});

  /**
   * The return is the record. The attempts are still there and still readable; this is the
   * entry that explains why the card looks untouched despite having been called.
   */
  await addActivity(
    leadId,
    'note',
    `Returned to the calling queue — ${attempts.length} earlier attempt(s) set aside`
      + (input.reason ? `: ${input.reason}` : '')
      + (restored.length ? `. Back in rotation: ${restored.join(', ')}` : ''),
    { returnedToQueue: { discounted: attempts.length, restoredNumbers: restored, reason: input.reason ?? null } },
    input.by ?? undefined,
  ).catch(() => { /* the return matters more than the note about it */ });

  return { returned: true, discounted: attempts.length, restoredNumbers: restored };
}

export async function undoLastAttempt(input: {
  lead: Record<string, unknown>;
  by?: string | null;
}): Promise<{ undone: boolean; outcome?: CallOutcome; reason?: string }> {
  const leadId = String(input.lead.id);

  const [last] = await sql`
    SELECT "id","outcome","numberDialled","calledBy","attemptedAt"::text AS "attemptedAt"
      FROM "CallAttempt" WHERE "leadId" = ${leadId}
     ORDER BY "attemptedAt" DESC LIMIT 1` as Array<Record<string, any>>;

  if (!last) return { undone: false, reason: 'There is nothing to undo on this lead.' };

  const at = utcStoredToDate(last.attemptedAt);
  const ageMinutes = at ? (Date.now() - at.getTime()) / 60_000 : Infinity;
  if (ageMinutes > UNDO_WINDOW_MINUTES) {
    return {
      undone: false,
      reason: `That attempt is older than ${UNDO_WINDOW_MINUTES} minutes. It stays on the record —`
        + ' log a correcting attempt instead.',
    };
  }

  const spec = CALL_OUTCOMES.find((o) => o.key === last.outcome);

  /**
   * The number goes back into rotation only if nothing else invalidated it. Another
   * "bad number" on the same line is a second, independent reason to leave it out.
   */
  if (spec?.invalidatesNumber) {
    const [others] = await sql`
      SELECT COUNT(*)::int AS n FROM "CallAttempt"
       WHERE "leadId" = ${leadId} AND "id" <> ${String(last.id)}
         AND "numberDialled" = ${String(last.numberDialled)}
         AND "outcome" IN ('bad_number','wrong_person')` as Array<{ n: number }>;
    if (Number(others?.n ?? 0) === 0) {
      const existing: string[] = Array.isArray(input.lead.invalidPhones)
        ? (input.lead.invalidPhones as string[]) : [];
      await sql`
        UPDATE "Lead"
           SET "invalidPhones" = ${JSON.stringify(existing.filter((n) => n !== String(last.numberDialled)))}::jsonb
         WHERE "id" = ${leadId}`;
    }
  }

  /**
   * A suppression is released rather than deleted. It happened, somebody undid it, and both
   * of those are worth being able to see — a household that was suppressed and un-suppressed
   * within a minute is exactly the kind of thing worth noticing later.
   */
  if (spec?.suppresses) {
    await sql`
      UPDATE "Suppression"
         SET "releasedAt" = NOW(), "releasedBy" = ${input.by ?? null},
             "releaseNote" = 'Undone — the call outcome was a mis-tap'
       WHERE "leadId" = ${leadId} AND "reason" = ${spec.suppresses}
         AND "releasedAt" IS NULL`;
  }

  if (spec?.needsCallbackAt) {
    await sql`
      UPDATE "Lead" SET "revisitFlag" = FALSE, "revisitDate" = NULL, "revisitNote" = NULL
       WHERE "id" = ${leadId}`;
  }

  await sql`DELETE FROM "CallAttempt" WHERE "id" = ${String(last.id)}`;

  /**
   * The undo itself is recorded. The attempt is gone from the log — which is the point —
   * but a row vanishing with no explanation is how a call log stops being trusted.
   */
  await addActivity(
    leadId,
    'note',
    `Call outcome undone: "${spec?.label ?? last.outcome}" on ${last.numberDialled}`
      + ' — logged in error and taken back.',
    { undone: { outcome: last.outcome, number: last.numberDialled, at: last.attemptedAt } },
    input.by ?? undefined,
  ).catch(() => { /* the reversal matters more than the note about it */ });

  return { undone: true, outcome: last.outcome as CallOutcome };
}

/**
 * Record one attempt, and do what the outcome means.
 *
 * Deliberately takes the number that was DIALLED rather than reading it back from the
 * card: Ruben may have called a number a customer gave him on a previous call, and a log
 * that silently rewrites which number was tried is worse than no log.
 */
export async function logAttempt(input: {
  lead: Record<string, unknown>;
  numberDialled: string;
  outcome: CallOutcome;
  numberRole?: 'insured' | 'co_insured' | null;
  numberLabel?: string | null;
  durationSeconds?: number | null;
  callbackAt?: string | null;
  notes?: string | null;
  by?: string | null;
}): Promise<{ id: string; status: CallStatus; suppressed: boolean; numberInvalidated: boolean }> {
  const spec = CALL_OUTCOMES.find((o) => o.key === input.outcome);
  if (!spec) throw new Error(`Unknown call outcome: ${input.outcome}`);

  const leadId = String(input.lead.id);
  const number = String(input.numberDialled ?? '').replace(/\D/g, '');
  if (!number) throw new Error('An attempt needs the number that was dialled.');
  if (spec.needsCallbackAt && !input.callbackAt) {
    throw new Error('A scheduled callback needs a date and time.');
  }
  /**
   * ── The callback time, converted to UTC before it is stored ───────────────
   *
   * The picker hands back a bare wall clock with no zone. It used to go straight into the
   * column, so `callbackAt` held whatever clock the operator's laptop was set to while
   * `attemptedAt` — written by NOW() — held UTC. Two zones in one table, nothing marking
   * which was which, and a callback that moved if Ruben opened the card from a machine set
   * to another zone.
   *
   * Read as EASTERN, because that is what somebody scheduling a call into the agency's day
   * means. Stored as UTC, like everything else here.
   */
  const callbackUtc = spec.needsCallbackAt && input.callbackAt
    ? easternInputToUtc(String(input.callbackAt))
    : null;
  if (spec.needsCallbackAt && input.callbackAt && !callbackUtc) {
    throw new Error('That callback time could not be read. Pick a date and time.');
  }
  /**
   * And it has to be in the future. Only callbacks still ahead are surfaced, so one saved
   * in the past is recorded and then shown to nobody — indistinguishable from never having
   * set one, which is Frank's complaint from the other direction. Enforced here as well as
   * in the panel, because the panel is one caller and the rule belongs with the data.
   */
  if (callbackUtc) {
    const at = utcStoredToDate(callbackUtc);
    if (at && at.getTime() <= Date.now()) {
      throw new Error('That callback time has already passed. Pick a time in the future.');
    }
  }

  const id = globalThis.crypto.randomUUID();
  await sql`
    INSERT INTO "CallAttempt"
      ("id","leadId","propertyId","numberDialled","numberRole","numberLabel",
       "durationSeconds","outcome","callbackAt","notes","calledBy")
    VALUES (${id}, ${leadId}, ${String(input.lead.propertyId ?? '')}, ${number},
            ${input.numberRole ?? null}, ${input.numberLabel ?? null},
            ${input.durationSeconds ?? null}, ${input.outcome},
            ${callbackUtc}, ${input.notes ?? null}, ${input.by ?? null})`;

  // A dead or wrong number leaves rotation permanently. Kept on the lead rather than
  // erased — a disconnected line is worth remembering at next renewal.
  let numberInvalidated = false;
  if (spec.invalidatesNumber) {
    const existing: string[] = Array.isArray(input.lead.invalidPhones)
      ? (input.lead.invalidPhones as string[]) : [];
    if (!existing.includes(number)) {
      await sql`
        UPDATE "Lead" SET "invalidPhones" = ${JSON.stringify([...existing, number])}::jsonb
         WHERE "id" = ${leadId}`;
      numberInvalidated = true;
    }
  }

  let suppressed = false;
  let recontactAt: string | null = null;
  if (spec.suppresses) {
    /**
     * A "not interested" ends; a "do not call" does not.
     *
     * Frank: "Not interested → re-contact 60 days before next renewal." Sixty days before
     * the renewal AFTER the one being called about, so the household is left alone for this
     * cycle and reached in good time for the next. Do-not-call passes no date and stays
     * permanent, which is the whole difference between the two.
     */
    if (spec.recontactBeforeNextRenewal) {
      const eff = String((input.lead as Record<string, unknown>).effectiveDate ?? '').slice(0, 10);
      if (/^\d{4}-\d{2}-\d{2}$/.test(eff)) {
        const next = new Date(`${eff}T00:00:00`);
        next.setFullYear(next.getFullYear() + 1);
        next.setDate(next.getDate() - NOT_INTERESTED_RECONTACT_DAYS_BEFORE_RENEWAL);
        recontactAt = next.toISOString();
      }
      // No renewal date on the card means no date to compute from. The suppression is
      // still recorded — it stays permanent until somebody releases it, which is safer
      // than inventing a re-contact date from nothing.
    }
    await suppress({
      lead: input.lead, email: null, reason: spec.suppresses,
      source: 'producer', createdBy: input.by ?? null,
      note: `Call outcome: ${spec.label}`,
      reviewAt: recontactAt,
    });
    suppressed = true;
  }

  /**
   * ── The email sequence stops when a quote is requested ───────────────────
   *
   * Frank: "Quote requested → quoting, and the email sequence pauses."
   *
   * Somebody who has just asked for a quote on the phone must not keep receiving the cold
   * sequence that asked them to — it reads as nobody at the agency talking to anybody else,
   * and it is the same household the producer is now working.
   *
   * The platform has no pause for a single lead, so the recipient is removed from the
   * campaign (see householdStop.service). The OutreachEvent rows stay, so the history of
   * what was sent survives the removal.
   *
   * Failure here does NOT fail the call log. A call that happened is a fact; a sequence
   * that could not be stopped is a problem to fix, and losing the record of the call to
   * report it would be the worse of the two.
   */
  let emailPaused: HouseholdStopResult | null = null;
  /**
   * Any outcome that reached a person stops the sequence — see callOutcomes.ts.
   *
   * Notably this covers "not interested" and "do not call", which until 29 Sep 2026 only
   * wrote a Suppression row. That stops the next PUSH and does nothing to a sequence already
   * running on the platform, so a household that had asked us to stop kept receiving the
   * remaining steps.
   */
  if (spec.reached) {
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      /**
       * No recipient is spared — unlike a reply, which spares the address that replied.
       * The contact happened on the PHONE, so there is no email address to keep talking to,
       * and every live address on the household should stop.
       *
       * The reason carries the outcome rather than a fixed string. It is what the stop
       * record shows afterwards, and "quote requested on a call" printed against a household
       * that had actually said do-not-call would misdescribe the one event most worth being
       * able to look up.
       */
      emailPaused = await stopHousehold(
        client, leadId, '',
        `${CALL_OUTCOME_LABEL[input.outcome] ?? input.outcome} — on a call`,
        String(input.by ?? 'producer'),
      );
      await client.query('COMMIT');
    } catch (e) {
      await client.query('ROLLBACK').catch(() => {});
      console.error('[callLog] could not stop the email sequence for', leadId, e);
    } finally {
      client.release();
    }
  }

  if (callbackUtc) {
    // The same converted value the attempt row carries. Writing the raw picker string here
    // would leave the lead's revisit date and its own call log describing the same callback
    // in two different zones.
    await sql`
      UPDATE "Lead" SET "revisitFlag" = TRUE, "revisitDate" = ${callbackUtc}::timestamp,
             "revisitNote" = ${`Callback agreed on a call${input.notes ? `: ${input.notes}` : ''}`}
       WHERE "id" = ${leadId}`;
  }

  await sql`
    INSERT INTO "Activity" ("id","leadId","type","content","createdBy","createdAt")
    VALUES (${globalThis.crypto.randomUUID()}, ${leadId}, 'call',
            ${`${spec.label} — ${number}${input.notes ? ` · ${input.notes}` : ''}`},
            ${input.by ?? 'crm'}, NOW())`;

  /**
   * An outcome was logged, so any reminder to ring this lead back has been answered.
   *
   * Closed HERE rather than by a button on the reminder, because a button that says
   * "called" without a call behind it is a second version of events. Derived from the
   * attempt, the reminder log and the call history cannot disagree.
   *
   * Never blocks the call: an attempt that failed to close a reminder is a stale row in a
   * queue; an attempt rolled back because the queue update failed is a lost call.
   */
  await closeRemindersForCall(leadId, input.by ?? null)
    .catch(() => { /* the attempt is what matters */ });

  // Recompute and stamp, purely so reports can filter cheaply. The stamp is an echo of
  // the derived rule, never the thing the rule reads.
  const state = await callState({ ...input.lead, invalidPhones: undefined });
  if (state.status === 'unreachable') {
    await sql`
      UPDATE "Lead" SET "callUnreachableAt" = COALESCE("callUnreachableAt", NOW())
       WHERE "id" = ${leadId}`;
  }

  /**
   * ── Tell Frank when Ruben reaches somebody ───────────────────────────────
   *
   * Frank, 29 Sep 2026: "anytime there's real engagement, whether it's on the phone or the
   * email, it should both correlate into a workflow." The email half of that runs off the
   * reply webhook; this is the phone half, so both channels raise the same alert in the same
   * shape and neither depends on anyone watching a screen.
   *
   * Only where a person was actually reached. A no-answer is not an event anybody needs a
   * message about, and a notifier that fires on every dial is one people filter away —
   * taking the four that mattered with it.
   *
   * Not awaited: the call is recorded and a producer is mid-queue. A mail relay must never
   * be between Ruben and his next number.
   */
  if (spec.reached) {
    void notifyEngagement({
      leadId,
      kind: 'call',
      who: input.numberDialled ?? null,
      detail: `${CALL_OUTCOME_LABEL[input.outcome] ?? input.outcome}`
        + (input.notes ? ` — ${input.notes}` : ''),
    });
  }

  return { id, status: state.status, suppressed, numberInvalidated };
}

/** The call queue: phone-reachable leads that are not finished and not suppressed. */
export async function callQueue(opts: { effFrom?: string; effTo?: string; limit?: number } = {}) {
  const rows = await sql`
    SELECT l."id", l."propertyId", l."owner1FirstName", l."owner1LastName",
           l."addressCity", l."addressZip", l."effectiveDate"::text AS "effectiveDate",
           l."cohort", COALESCE(l."manualGrade", l."grade") AS grade,
           l."phone1", l."phone2", l."owner2Phone", l."phonesAll", l."skipTraceData",
           l."email1","email2","owner2Email","emailsAll",
           l."owner1FirstName" AS f, l."owner1LastName" AS ln,
           l."owner2FirstName", l."owner2LastName",
           l."addressStreet", l."invalidPhones", l."callUnreachableAt",
           (SELECT COUNT(*)::int FROM "CallAttempt" a WHERE a."leadId" = l."id") AS "attemptCount",
           (SELECT MAX(a."attemptedAt") FROM "CallAttempt" a WHERE a."leadId" = l."id") AS "lastAttemptAt"
      FROM "Lead" l
     WHERE COALESCE(l."manualGrade", l."grade") = 'A'
       AND l."callUnreachableAt" IS NULL
       AND (${opts.effFrom ?? null}::text IS NULL OR l."effectiveDate" >= ${opts.effFrom ?? null})
       AND (${opts.effTo ?? null}::text   IS NULL OR l."effectiveDate" <= ${opts.effTo ?? null})
     ORDER BY l."effectiveDate", l."owner1LastName"
     LIMIT ${opts.limit ?? 500}` as Array<Record<string, unknown>>;

  // Only leads with a number worth dialling. Filtered here rather than in SQL because
  // "has a phone" means the recipient rules, not "phone1 IS NOT NULL".
  return rows.filter((l) => numbersOnCard(l).some(
    (n) => !(Array.isArray(l.invalidPhones) ? (l.invalidPhones as string[]) : []).includes(n.number),
  ));
}
