/**
 * Call outcomes and what each one triggers (directive Sec. 10.5).
 *
 * The outcome list is short on purpose. Ruben is logging this on a phone between calls,
 * and the directive gives him fifteen seconds — a long list with fine distinctions gets
 * mis-tapped, and a mis-tapped outcome is worse than a coarse one because the follow-up
 * rules act on it.
 *
 * No imports: the panel needs these labels, and a value import from the service would drag
 * its server-only graph into the browser bundle.
 */

export type CallOutcome =
  | 'no_answer'
  | 'voicemail'
  | 'bad_number'
  | 'wrong_person'
  | 'callback_scheduled'
  | 'quote_requested'
  | 'not_interested'
  | 'do_not_call';

export type CallOutcomeSpec = {
  key: CallOutcome;
  label: string;
  /** What Sec. 10.5 says follows. Shown on the control, so no consequence is a surprise. */
  follows: string;
  /** A person was actually spoken to. Decides `contacted` and stops the retry cadence. */
  reached: boolean;
  /** The number is dead or belongs to someone else — never dial it again. */
  invalidatesNumber: boolean;
  /** Suppress the whole household, at the reason suppression.service derives. */
  suppresses?: 'not_interested' | 'dnc';
  /** Needs a date, so the reminder has something to fire at. */
  needsCallbackAt?: boolean;
  /**
   * ── Stopping the email sequence is decided by `reached`, not by a flag ────
   *
   * This used to be an opt-in `pausesEmail?: boolean`, and it was set on exactly one
   * outcome. Everything else that reached a human kept the cold sequence running:
   *
   *   callback scheduled  spoke to them, agreed a time — and the intro email still went
   *   not interested      they said no — and the sequence went on asking
   *   do not call         they said stop — and the sequence went on sending
   *
   * The last one is not an annoyance. suppress() writes a Suppression row, which stops the
   * NEXT push; it does not touch the platform, so a sequence already running keeps running.
   * Only stopHousehold() removes the contact. A household that asked us to stop went on
   * being mailed until the sequence ran out.
   *
   * Frank and Ruben settled the rule on 29 Sep 2026. Ruben: "they confirmed their email,
   * they seem interested — for that card we should just not be automated outreach to them
   * since they're already engaged." Frank: "cease all automation outreach via email."
   *
   * That rule is "we reached a person", which this file already records as `reached`. So
   * the sequence stop is derived from it rather than carried beside it, and a new outcome
   * cannot be added that reaches somebody and forgets to stop the email — which is the only
   * way the three lines above could have happened.
   */
  /**
   * The suppression ends, rather than standing forever.
   *
   * "Not interested" is about THIS renewal. Without this flag it landed in exactly the same
   * permanent state as a do-not-call, quietly retiring a customer who said no to one year's
   * quote.
   */
  recontactBeforeNextRenewal?: boolean;
  tone: 'good' | 'neutral' | 'bad';
};

export const CALL_OUTCOMES: CallOutcomeSpec[] = [
  {
    key: 'no_answer',
    label: 'No answer',
    follows: 'Retry per cadence.',
    reached: false, invalidatesNumber: false, tone: 'neutral',
  },
  {
    key: 'voicemail',
    label: 'Voicemail left',
    follows: 'Retry per cadence.',
    reached: false, invalidatesNumber: false, tone: 'neutral',
  },
  {
    key: 'bad_number',
    label: 'Bad number / disconnected',
    follows: 'That number is marked invalid. The next number on the card is used.',
    reached: false, invalidatesNumber: true, tone: 'bad',
  },
  {
    key: 'wrong_person',
    label: 'Wrong person',
    follows: 'That number is marked invalid and never retried.',
    reached: false, invalidatesNumber: true, tone: 'bad',
  },
  {
    key: 'callback_scheduled',
    label: 'Reached — callback scheduled',
    follows: 'A reminder is set for the date and time you give. The email sequence stops — you have spoken to them.',
    reached: true, invalidatesNumber: false, needsCallbackAt: true, tone: 'good',
  },
  {
    key: 'quote_requested',
    label: 'Reached — quote requested',
    follows: 'Handed to quoting. The email sequence stops — they are talking to us now.',
    reached: true, invalidatesNumber: false, tone: 'good',
  },
  {
    key: 'not_interested',
    label: 'Reached — not interested',
    follows: 'The email sequence stops. Household left alone this cycle, and approached again 60 days before the next renewal.',
    reached: true, invalidatesNumber: false, suppresses: 'not_interested',
    recontactBeforeNextRenewal: true, tone: 'bad',
  },
  {
    key: 'do_not_call',
    label: 'Reached — do not call',
    follows: 'DNC flag, household suppressed on every channel, and the running email sequence stops now.',
    reached: true, invalidatesNumber: false, suppresses: 'dnc', tone: 'bad',
  },
];

export const CALL_OUTCOME_LABEL: Record<CallOutcome, string> = Object.fromEntries(
  CALL_OUTCOMES.map((o) => [o.key, o.label]),
) as Record<CallOutcome, string>;

/**
 * The outcomes where somebody was actually spoken to.
 *
 * Derived from the table above rather than typed out again, so a new outcome cannot be
 * added that reaches a person and gets left off this list.
 *
 * The workflow board reads it to decide whether a reply has been answered. It used to
 * close a reply on ANY attempt, which meant three "bad number" results and one "no answer"
 * took a homeowner off the board without a word being exchanged — see the note on the
 * board's reply query.
 */
export const REACHING_OUTCOMES: readonly CallOutcome[] = CALL_OUTCOMES
  .filter((o) => o.reached)
  .map((o) => o.key);

/**
 * Derived from the attempts, never typed.
 *
 * ── Why "contacted" was split ───────────────────────────────────────────────
 * Frank, 25 Sep 2026: "'Contacted' is too broad. The status should follow the outcome."
 *
 * One word covered four situations that need four different things to happen next: a
 * callback in the diary, a quote being worked, a customer who said no this year, and a
 * customer who said never. Reading the queue told you somebody had been spoken to and
 * nothing about what was owed to them — so the follow-up lived in whoever remembered the
 * call, which is the infrastructure gap Frank names in the same message.
 */
export type CallStatus =
  | 'not_attempted'
  | 'attempting'
  | 'callback_due'
  | 'quoting'
  | 'not_interested'
  | 'do_not_call'
  | 'unreachable';

export const CALL_STATUS_LABEL: Record<CallStatus, string> = {
  not_attempted: 'Not attempted',
  attempting: 'Attempting',
  callback_due: 'Callback due',
  quoting: 'Quoting',
  not_interested: 'Not interested',
  do_not_call: 'Do not call',
  unreachable: 'Unreachable',
};

/**
 * The status each reaching outcome produces.
 *
 * Kept beside the outcomes rather than derived by a chain of ifs in the service: the
 * mapping IS the rule Frank wrote down, and a rule expressed as control flow is a rule
 * nobody can check against the message that asked for it.
 */
/**
 * The statuses that mean a person was actually spoken to.
 *
 * Splitting "contacted" into four left every place that counted contacts asking a question
 * the type no longer answered. Funnels still need "how many did we reach" — that is a real
 * number and it is the sum of the four, not one of them.
 */
export const REACHED_STATUSES: readonly CallStatus[] = [
  'callback_due', 'quoting', 'not_interested', 'do_not_call',
];

export const isReachedStatus = (s: CallStatus | null | undefined): boolean =>
  !!s && (REACHED_STATUSES as readonly string[]).includes(s);

export const STATUS_FOR_OUTCOME: Partial<Record<CallOutcome, CallStatus>> = {
  callback_scheduled: 'callback_due',
  quote_requested: 'quoting',
  not_interested: 'not_interested',
  do_not_call: 'do_not_call',
};

/**
 * How long a "not interested" stands.
 *
 * Frank: "Not interested → re-contact 60 days before next renewal." Sixty days before the
 * renewal after the one we were calling about — so the household is left alone for this
 * cycle and approached again in good time for the next.
 */
export const NOT_INTERESTED_RECONTACT_DAYS_BEFORE_RENEWAL = 60;

/**
 * The stop rule, verbatim from Sec. 10.5:
 *
 *   "four attempts, three or more different days, two or more numbers where they exist
 *    → unreachable, leaves the active queue, joins the direct-mail segment. Never
 *    deleted, never downgraded."
 *
 * All three conditions, not any of them. Four calls in one afternoon to one number is not
 * a lead that cannot be reached — it is a lead called badly, and retiring it would hide
 * the difference. The "where they exist" clause is why the number condition is waived for
 * a card that only ever had one.
 */
export const UNREACHABLE_RULE = {
  minAttempts: 4,
  minDistinctDays: 3,
  minDistinctNumbers: 2,
} as const;

/**
 * The stop rule itself, as a function, so there is exactly one of it.
 *
 * ── Why this was extracted ──────────────────────────────────────────────────
 * There were two implementations. The lead card applied all three conditions; the
 * call_outcome QC report applied only `attempts >= 4 && days >= 3` and never looked at how
 * many different numbers had been dialled. So the report could retire a lead the card still
 * considered live — four calls to one number, with a second number on the card never tried.
 *
 * Nothing had gone wrong yet: on 6 Oct 2026 only 29 leads had any attempt at all and none
 * met either version of the rule, so the two agreed by accident. That is the point at which
 * to fix it — the first lead to reach four attempts would have been reported two ways, and
 * the phone funnel's unreachable rate is built on the report.
 *
 * `numbersOnCard` is the count of DIALLABLE numbers the card holds, which has to be derived
 * from the trace payload and not from the phone columns alone — a card whose second number
 * exists only in the payload would otherwise look like a single-number card and be retired
 * early. That is the column-vs-payload fault, and it is why this takes a count rather than
 * digging the numbers out itself.
 */
export function meetsUnreachableRule(input: {
  attempts: number;
  distinctDays: number;
  distinctNumbersTried: number;
  numbersOnCard: number;
}): boolean {
  // "two or more numbers WHERE THEY EXIST" — waived for a card that only ever had one, or
  // a single-number lead could never retire and would be dialled for ever.
  const enoughNumbers = input.numbersOnCard < UNREACHABLE_RULE.minDistinctNumbers
    || input.distinctNumbersTried >= UNREACHABLE_RULE.minDistinctNumbers;

  return input.attempts >= UNREACHABLE_RULE.minAttempts
    && input.distinctDays >= UNREACHABLE_RULE.minDistinctDays
    && enoughNumbers;
}

/**
 * The first rank at which a traced number stops counting as "worth ringing".
 *
 * The vendor returns a person's whole number history, best first — a median of one
 * number, but 21 for the co-insured on one card. Measured against every call logged so
 * far, how dead a number turns out to be tracks its rank almost exactly:
 *
 *     rank 1     34 calls   53% bad number or wrong person
 *     rank 2-3   37 calls   68%
 *     rank 4-6   26 calls   85%
 *     rank 7-10  12 calls   92%
 *     rank 11+    2 calls  100%
 *
 * Nobody has ever reached a person at rank 7 or deeper — 0 of 14.
 *
 * It lives here, beside the stop rule, because two screens have to agree about it: the
 * Phone list stops counting these numbers and the call card has to say why, or Ruben is
 * shown 26 numbers on one screen and 10 on the other. Cutting at 4 instead would have
 * left 15 accounts reading as nothing-left-to-ring, which is why the line is at 7.
 *
 * A number the vendor never ranked came with the policy and is never in this tier.
 */
export const DEEP_TAIL_RANK = 7;

/** Is this number deep enough in the vendor's list to be held back as a reserve? */
export function isDeepTail(rank: number | null | undefined): boolean {
  return (rank ?? 0) >= DEEP_TAIL_RANK;
}
