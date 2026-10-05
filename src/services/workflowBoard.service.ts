import { sql } from '@/lib/neon';
import { cohortCode, cohortLabel, cohortEnd } from './cohort';
import { REACHING_OUTCOMES } from '@/lib/callOutcomes';

/**
 * The workflow board (Frank, 29 Sep 2026).
 *
 * "Anytime there's real engagement, whether it's on the phone or the email, it should both
 *  correlate into a workflow that has action items... broken out in boxes by cohort, and you
 *  can click into the box, you can see emails, anything responding to, follow-ups, callbacks,
 *  quote issued follow-up — if it was issued and no response in three days, that's a trigger
 *  flag. That's a real workflow dashboard. You don't miss anything."
 *
 * ── Why this is not another report ──────────────────────────────────────────
 * Every other screen in this CRM answers "what is true". This one answers "what is owed" —
 * the things a person said they would do and has not done yet. A lead sitting in five
 * reports and nobody's list is the failure mode Frank is describing, and it costs an account
 * rather than a number in a table.
 *
 * ── Every item is DERIVED, and every one can close itself ───────────────────
 * Nothing here is a task somebody ticks off. An item exists because a fact about the lead
 * says work is outstanding, and it disappears when the fact changes — a reply is owed until
 * somebody rings, a callback is owed until the next attempt, a quote is stale until it binds
 * or is lost. A stored to-do list would need closing by hand, and the first one nobody closed
 * would make the whole board untrustworthy.
 *
 * That also means the board cannot disagree with the cards it is built from, which is the
 * defect this project has spent a fortnight removing everywhere else.
 *
 * ── Ordered by renewal proximity, never by age ──────────────────────────────
 * Frank: "if it's closer to the effective date, that means it's more pressing than if it's
 * further." A three-day-old item on a renewal in November matters less than a same-day one
 * renewing on Monday, so the cohort is the first sort and the clock is shown inside it.
 */

export type ActionKind =
  /** A homeowner replied and nobody has spoken to them since. */
  | 'reply'
  /** A callback was agreed with the household and its time has passed. */
  | 'callback'
  /** A producer's own "try again shortly" reminder is due. */
  | 'reminder'
  /** They asked for a quote on a call and none has been issued. */
  | 'quote_requested'
  /** A quote went out and nothing has happened since — Frank's three-day flag. */
  | 'quote_stale';

export const ACTION_LABEL: Record<ActionKind, string> = {
  reply: 'Replied — needs an answer',
  callback: 'Callback due',
  reminder: 'Reminder due',
  quote_requested: 'Quote requested — not issued',
  quote_stale: 'Quote issued — no response',
};

/**
 * How old an item has to be before it is behind.
 *
 * Frank: "anything less than or equal to two days, greater than or equal to two days, you
 * need to follow up on." Two days on everything except a quote, which he gave its own
 * number: "if it was issued and no response in three days, that's a trigger flag."
 */
export const OVERDUE_AFTER_DAYS = 2;
export const QUOTE_STALE_AFTER_DAYS = 3;

export type ActionItem = {
  leadId: string;
  propertyId: string | null;
  cohort: string | null;
  kind: ActionKind;
  /** What happened, in the producer's words rather than a column name. */
  detail: string | null;
  owner: string | null;
  address: string | null;
  phone: string | null;
  effectiveDate: string | null;
  /** When this became somebody's job. */
  since: string | null;
  ageDays: number;
  overdue: boolean;
};

export type CohortBox = {
  cohort: string;
  code: string | null;
  label: string;
  endsOn: string | null;
  total: number;
  overdue: number;
  byKind: Record<ActionKind, number>;
  /** The longest anything in this box has been waiting. */
  oldestDays: number;
};

export type WorkflowBoard = {
  boxes: CohortBox[];
  items: ActionItem[];
  totals: { total: number; overdue: number; byKind: Record<ActionKind, number> };
};

const emptyByKind = (): Record<ActionKind, number> => ({
  reply: 0, callback: 0, reminder: 0, quote_requested: 0, quote_stale: 0,
});

/**
 * Everything outstanding in a date window.
 *
 * ── The clock runs in SQL, never in the browser ─────────────────────────────
 * Ages are computed as NOW() - the timestamp, inside Postgres. Every date column here is
 * `timestamp without time zone`, which the driver hands back as server-local — comparing one
 * against a browser clock is the bug that hid a callback due today and the one that stopped a
 * stalled-run check ever firing. A number of days computed by the database needs no timezone
 * at either end.
 */
export async function getWorkflowBoard(params: {
  effFrom?: string; effTo?: string;
} = {}): Promise<WorkflowBoard> {
  const from = params.effFrom || null;
  const to = params.effTo || null;

  /**
   * One query per kind rather than a union.
   *
   * They have genuinely different shapes — a reply lives on OutreachEvent, a reminder on
   * CallReminder, a stale quote on the Lead itself — and a union would need each one padded
   * out to a common column list. The cost is five round trips on a screen somebody opens a
   * few times a day.
   */

  /**
   * A reply nobody has answered.
   *
   * "Answered" means somebody got back to them — spoke to them on the phone, or wrote back.
   * A reply classified as not interested or as a stop is not owed an answer — the class
   * already said what happens — so only the ones that want a human are counted, plus the
   * unclassified, which want a human to decide.
   *
   * It closes itself when that answer is recorded, so nothing has to be ticked off.
   */
  const replies = await sql`
    SELECT o."leadId", l."propertyId", l."cohort", l."effectiveDate",
           l."owner1FirstName", l."owner1LastName", l."addressStreet", l."addressCity",
           l."phone1", o."repliedAt"::text AS since,
           EXTRACT(EPOCH FROM (NOW() - o."repliedAt")) / 86400 AS age_days,
           COALESCE(o."replyExcerpt", o."replyClass") AS detail
      FROM "OutreachEvent" o
      JOIN "Lead" l ON l."id" = o."leadId"
     WHERE o."repliedAt" IS NOT NULL
       AND (o."replyClass" IS NULL
            OR o."replyClass" IN ('interested','question','wrong_timing'))
       AND l."boundDate" IS NULL AND l."lostAt" IS NULL
       /*
        * Answered on ANY channel — not merely dialled.
        *
        * This closed on any call attempt after the reply, which is not the same thing as
        * answering somebody. Michael Odrobinak replied on 5 Oct saying he would ring us;
        * four calls were logged three hours later — three "bad number" and one "no answer",
        * so nobody spoke to him and his number does not work — and the board took him off
        * as handled. A homeowner who raised his hand, cannot be reached by phone, and is
        * now invisible on the one screen that tracks what is owed.
        *
        * So a call closes it only when the outcome says somebody was REACHED, and an email
        * closes it too: replying from the Replies tab writes that activity row, and an
        * emailed answer is an answer even though no call was made.
        */
       AND NOT EXISTS (
         SELECT 1 FROM "CallAttempt" a
          WHERE a."leadId" = o."leadId"
            AND a."attemptedAt" > o."repliedAt"
            AND a."outcome" = ANY(${[...REACHING_OUTCOMES]}::text[]))
       AND NOT EXISTS (
         SELECT 1 FROM "Activity" act
          WHERE act."leadId" = o."leadId"
            AND act."type" = 'email'
            AND act."createdAt" > o."repliedAt")
       AND (${from}::text IS NULL OR l."effectiveDate" >= ${from})
       AND (${to}::text   IS NULL OR l."effectiveDate" <= ${to})` as Array<Record<string, any>>;

  /**
   * A callback the household agreed to, whose time has passed.
   *
   * revisitDate is written by the call log when an outcome needs one. Closes when any attempt
   * is logged after the agreed time — which is exactly what honouring it looks like.
   */
  const callbacks = await sql`
    SELECT l."id" AS "leadId", l."propertyId", l."cohort", l."effectiveDate",
           l."owner1FirstName", l."owner1LastName", l."addressStreet", l."addressCity",
           l."phone1", l."revisitDate"::text AS since,
           EXTRACT(EPOCH FROM (NOW() - l."revisitDate")) / 86400 AS age_days,
           l."revisitNote" AS detail
      FROM "Lead" l
     WHERE l."revisitFlag" = TRUE AND l."revisitDate" IS NOT NULL
       AND l."revisitDate" <= NOW()
       AND l."boundDate" IS NULL AND l."lostAt" IS NULL
       AND NOT EXISTS (
         SELECT 1 FROM "CallAttempt" a
          WHERE a."leadId" = l."id" AND a."attemptedAt" > l."revisitDate")
       AND (${from}::text IS NULL OR l."effectiveDate" >= ${from})
       AND (${to}::text   IS NULL OR l."effectiveDate" <= ${to})` as Array<Record<string, any>>;

  /** A producer's own reminder, still open and now due. */
  const reminders = await sql`
    SELECT r."leadId", l."propertyId", l."cohort", l."effectiveDate",
           l."owner1FirstName", l."owner1LastName", l."addressStreet", l."addressCity",
           COALESCE(r."phone", l."phone1") AS "phone1", r."dueAt"::text AS since,
           EXTRACT(EPOCH FROM (NOW() - r."dueAt")) / 86400 AS age_days,
           r."note" AS detail
      FROM "CallReminder" r
      JOIN "Lead" l ON l."id" = r."leadId"
     WHERE r."doneAt" IS NULL AND r."dismissedAt" IS NULL AND r."dueAt" <= NOW()
       AND (${from}::text IS NULL OR l."effectiveDate" >= ${from})
       AND (${to}::text   IS NULL OR l."effectiveDate" <= ${to})` as Array<Record<string, any>>;

  /**
   * They asked for a quote and none has been issued.
   *
   * The status is what the producer set on the card when the call ended, so this is the
   * promise made on that call. Closes when quotedAt is written.
   */
  const requested = await sql`
    SELECT l."id" AS "leadId", l."propertyId", l."cohort", l."effectiveDate",
           l."owner1FirstName", l."owner1LastName", l."addressStreet", l."addressCity",
           l."phone1",
           /**
            * Aged from the CALL where they asked, not from the lead's updatedAt.
            *
            * updatedAt moves whenever anything on the card is edited — a note, a band price,
            * a phone number — so a quote somebody has been waiting a week for read as "0d"
            * the moment a producer touched the record. The clock on a promise has to start
            * when the promise was made, and that is the attempt whose outcome was
            * quote_requested. Falling back to firstRpcAt covers a status set by hand with no
            * call behind it; updatedAt is the last resort and never the usual answer.
            */
           COALESCE(q."asked_at", l."firstRpcAt", l."updatedAt")::text AS since,
           EXTRACT(EPOCH FROM (NOW() - COALESCE(q."asked_at", l."firstRpcAt", l."updatedAt"))) / 86400 AS age_days,
           q."notes" AS detail
      FROM "Lead" l
      -- Driven by the CALL, not by Lead.status.
      --
      -- This tested Lead.status = 'quoting' and would almost never have fired. Two different
      -- things in this CRM are called a status: the producer workflow status on the Lead --
      -- new, rated, quoted, bound -- and the CALL status that callState() derives from the
      -- attempt log. "Reached - quote requested" sets the second and leaves the first alone:
      -- lead 45515074 carries that outcome from 25 Sep and still reads 'rated'.
      --
      -- So the promise lives on the attempt, and that is what this reads. It closes when
      -- quotedAt is written, or the lead binds or is lost, none of which need anybody to
      -- remember to change a status.
      JOIN LATERAL (
        SELECT a."attemptedAt" AS asked_at, a."notes"
          FROM "CallAttempt" a
         WHERE a."leadId" = l."id" AND a."outcome" = 'quote_requested'
           AND ( l."callQueueReturnedAt" IS NULL
                 OR a."attemptedAt" > l."callQueueReturnedAt" )
         ORDER BY a."attemptedAt" DESC LIMIT 1
      ) q ON TRUE
     WHERE l."quotedAt" IS NULL
       AND l."boundDate" IS NULL AND l."lostAt" IS NULL
       AND (${from}::text IS NULL OR l."effectiveDate" >= ${from})
       AND (${to}::text   IS NULL OR l."effectiveDate" <= ${to})` as Array<Record<string, any>>;

  /**
   * Frank's three-day flag: a quote went out and nothing came back.
   *
   * Neither bound nor lost, and old enough to chase. This is the one he singled out, because
   * a quote nobody follows up is the most expensive thing on the board — the work is already
   * done and paid for.
   */
  const stale = await sql`
    SELECT l."id" AS "leadId", l."propertyId", l."cohort", l."effectiveDate",
           l."owner1FirstName", l."owner1LastName", l."addressStreet", l."addressCity",
           l."phone1", l."quotedAt"::text AS since,
           EXTRACT(EPOCH FROM (NOW() - l."quotedAt")) / 86400 AS age_days,
           CONCAT('Quoted ', COALESCE(l."quotedPremium"::text, '—'),
                  CASE WHEN l."quotedCarrier" IS NOT NULL THEN CONCAT(' with ', l."quotedCarrier") ELSE '' END) AS detail
      FROM "Lead" l
     WHERE l."quotedAt" IS NOT NULL
       AND l."boundDate" IS NULL AND l."lostAt" IS NULL
       AND l."quotedAt" < NOW() - (${QUOTE_STALE_AFTER_DAYS} || ' days')::interval
       AND (${from}::text IS NULL OR l."effectiveDate" >= ${from})
       AND (${to}::text   IS NULL OR l."effectiveDate" <= ${to})` as Array<Record<string, any>>;

  const toItem = (r: Record<string, any>, kind: ActionKind): ActionItem => {
    const ageDays = Math.max(0, Math.floor(Number(r.age_days ?? 0)));
    return {
      leadId: String(r.leadId),
      propertyId: r.propertyId ?? null,
      cohort: r.cohort ?? null,
      kind,
      detail: r.detail ? String(r.detail).slice(0, 240) : null,
      owner: [r.owner1FirstName, r.owner1LastName].filter(Boolean).join(' ') || null,
      address: [r.addressStreet, r.addressCity].filter(Boolean).join(', ') || null,
      phone: r.phone1 ? String(r.phone1) : null,
      effectiveDate: r.effectiveDate ? String(r.effectiveDate).slice(0, 10) : null,
      since: r.since ? String(r.since).slice(0, 16).replace('T', ' ') : null,
      ageDays,
      overdue: ageDays > OVERDUE_AFTER_DAYS,
    };
  };

  const items: ActionItem[] = [
    ...replies.map((r) => toItem(r, 'reply')),
    ...callbacks.map((r) => toItem(r, 'callback')),
    ...reminders.map((r) => toItem(r, 'reminder')),
    ...requested.map((r) => toItem(r, 'quote_requested')),
    ...stale.map((r) => toItem(r, 'quote_stale')),
  ];

  /**
   * Soonest renewal first, then the longest wait.
   *
   * The cohort decides the order and the clock breaks the tie, which is Frank's rule: a
   * fortnight-old item on a January renewal is not more urgent than this morning's on one
   * that renews on Monday.
   */
  items.sort((a, b) => {
    const ca = a.cohort ?? '9999-99-99';
    const cb = b.cohort ?? '9999-99-99';
    if (ca !== cb) return ca < cb ? -1 : 1;
    return b.ageDays - a.ageDays;
  });

  const by = new Map<string, CohortBox>();
  for (const it of items) {
    if (!it.cohort) continue;
    let box = by.get(it.cohort);
    if (!box) {
      box = {
        cohort: it.cohort,
        code: cohortCode(it.cohort),
        label: cohortLabel(it.cohort),
        endsOn: cohortEnd(it.cohort),
        total: 0, overdue: 0, byKind: emptyByKind(), oldestDays: 0,
      };
      by.set(it.cohort, box);
    }
    box.total++;
    box.byKind[it.kind]++;
    if (it.overdue) box.overdue++;
    if (it.ageDays > box.oldestDays) box.oldestDays = it.ageDays;
  }

  const totals = { total: items.length, overdue: items.filter((i) => i.overdue).length, byKind: emptyByKind() };
  for (const it of items) totals.byKind[it.kind]++;

  return {
    boxes: [...by.values()].sort((a, b) => (a.cohort < b.cohort ? -1 : 1)),
    items,
    totals,
  };
}
