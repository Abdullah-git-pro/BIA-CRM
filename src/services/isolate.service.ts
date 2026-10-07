import { sql } from '@/lib/neon';
import { updateLead, addActivity } from '@/services/storage.service';
import { insuredEmails } from './recipients.service';

/**
 * Isolating the unreachable (register A41).
 *
 * ── What "isolated" means ───────────────────────────────────────────────────
 * Grade A with no insured email: a lead we would quote and cannot email. It is not lost,
 * not out of appetite, and not a producer's mistake — it is waiting on a contact detail.
 * Left at 'rated' it reads as part of the send list, and the first anyone learns otherwise
 * is when a cohort under-delivers against its own forecast.
 *
 * ── Isolation is its own field, NOT a status ────────────────────────────────
 * It used to overwrite status with 'isolated', keeping the old value in isolatedFromStatus
 * to put back later. That preserved the data and still broke every reader in between:
 * anything asking "is this lead rated" got "no" for as long as it was parked, which is how
 * the dashboard came to report 48 rated for a week holding 61.
 *
 * Frank, 23 Sep 2026: "A separate 'isolated' dropdown will be added, so pulling a lead for
 * skip trace never overwrites its 'rated' status."
 *
 * So isolatedAt is the marker and status is left alone. A lead that was rated stays rated
 * while it waits for an address, which is what it actually is — rated AND unreachable are
 * two different facts about the same lead and were never alternatives to each other.
 *
 * isolatedFromStatus is still written, and still read on the way out, because 46 leads were
 * isolated under the old rule and their real status is only recoverable from it.
 *
 * ── Why this is an action, not a rule ───────────────────────────────────────
 * It would be easy to have the report isolate leads as it renders them. That would make
 * running a report change the data, which is how a screen stops being a reliable place to
 * look. Somebody presses the button; it is recorded; it can be undone.
 */

const gradeOf = (l: any) => String(l.manualGrade || l.grade || '');

/**
 * The grade being isolated. Defaults to A, which is all this ever did.
 *
 * ── Why it is a parameter now ────────────────────────────────────────────────
 * It was hard-coded to Grade A, and the recovery pipeline grew a Grade B tab with its own
 * "Isolate 102" button pointing at the same endpoint. Clicking it isolated the Grade A
 * leads in range — of which there were none — so it reported success, changed nothing,
 * and gave no clue why. The button was offered on a tab the service could not serve.
 */
export type IsolateGrade = 'A' | 'B';

/**
 * No insured email, not already isolated, in the grade being worked.
 *
 * Both isolation tests key on isolatedAt, not on status. The legacy check is kept
 * alongside it only so the 46 leads isolated under the old rule are still recognised
 * before the backfill runs — after it, the status arm never matches anything.
 */
const isIsolated = (l: any) => l.isolatedAt != null || l.status === 'isolated';

function isTarget(l: any, grade: IsolateGrade): boolean {
  return gradeOf(l) === grade && insuredEmails(l).length === 0 && !isIsolated(l);
}

/** An isolated lead that can now be reached — isolation no longer applies. */
function isRestorable(l: any): boolean {
  return isIsolated(l) && insuredEmails(l).length > 0;
}

/**
 * Named columns, not SELECT *: this reads the whole book when no range is given, and the
 * star drags rawData — a large blob on every one of ~10,000 leads — for columns nothing
 * here touches. skipTraceData IS needed; it carries the per-person attribution that
 * decides whether an address belongs to the insured.
 */
async function scoped(effFrom?: string, effTo?: string): Promise<any[]> {
  const from = effFrom || null;
  const to = effTo || null;
  const rows = await sql`
    SELECT "id","propertyId","status","grade","manualGrade","effectiveDate",
           "email1","email2","owner2Email","phone1","phone2","owner2Phone",
           "owner1FirstName","owner1LastName","owner2FirstName","owner2LastName",
           "skipTraceData","emailsAll","isolatedAt","isolatedFromStatus","isolatedReason",
           -- REQUIRED, not cosmetic: the enrolment stage is decided on it. Unselected it
           -- reads undefined, every lead files as "never traced", and the pipeline queues
           -- 29 leads for the vendor that already failed on them.
           "deepSkipTracedAt"
      FROM "Lead"
     WHERE (${from}::text IS NULL OR "effectiveDate" >= ${from})
       AND (${to}::text   IS NULL OR "effectiveDate" <= ${to})`;
  return rows as any[];
}

export type IsolateResult = {
  dryRun: boolean;
  /** The grade that was isolated. */
  grade: IsolateGrade;
  /** In that grade: no insured email, not yet isolated. */
  candidates: number;
  isolated: number;
  /** Already isolated and now reachable — put back where they were. */
  restored: number;
  /** What the isolated leads were before, so the cadence split is not lost. */
  fromStatus: Record<string, number>;
};

export async function isolateUnreachable(opts: {
  effFrom?: string;
  effTo?: string;
  dryRun?: boolean;
  createdBy?: string | null;
  /** Which grade to isolate. Defaults to A — the only one this used to handle. */
  grade?: IsolateGrade;
} = {}): Promise<IsolateResult> {
  const { effFrom, effTo, dryRun = true, createdBy = null, grade = 'A' } = opts;

  const rows = await scoped(effFrom, effTo);
  const targets = rows.filter((l) => isTarget(l, grade));
  const restorable = rows.filter(isRestorable);

  const fromStatus: Record<string, number> = {};
  for (const l of targets) {
    const k = l.status ?? '(none)';
    fromStatus[k] = (fromStatus[k] ?? 0) + 1;
  }

  const out: IsolateResult = {
    dryRun,
    grade,
    candidates: targets.length,
    isolated: 0,
    restored: restorable.length,
    fromStatus,
  };
  if (dryRun) return out;

  const now = new Date();
  for (const l of targets) {
    await updateLead(l.propertyId ?? l.id, {
      // status is deliberately NOT written. See the note at the top of this file: a rated
      // lead stays rated while it waits for an address.
      isolatedAt: now,
      isolatedFromStatus: l.status ?? null,
      isolatedReason: `Grade ${grade} with no insured email — cannot be emailed`,
      /**
       * Enrol at the stage that reflects what has ALREADY been tried.
       *
       * A lead is usually isolated precisely because a deep trace ran and came back
       * without an address — 29 of the first 31 had already been through Tracerfy. Filing
       * those at the "not yet attempted" stage would queue them for the very vendor that
       * already failed on them, at 15 credits a match, and the blast rules elsewhere in
       * this codebase refuse that (skipTraceBlocker's skipIfTraced) for the same reason.
       *
       * So Tracerfy's stage means "never deep traced". Anything already traced starts
       * where it actually stands: Tracerfy has had its turn, BatchData is next. The
       * timestamp is the real one from that trace, not the moment of enrolment.
       */
      recoveryStage: l.deepSkipTracedAt ? 'tracerfy' : 'isolated',
      recoveryEnteredAt: now,
      ...(l.deepSkipTracedAt ? { recoveryTracerfyAt: l.deepSkipTracedAt } : {}),
    });
    await addActivity(
      l.id,
      'status_change',
      `Isolated — Grade ${grade}, no insured email. Status stays ${l.status ?? '—'}.`,
      {
        changes: [{ field: 'Isolated', from: 'no', to: 'yes' }],
        isolatedFromStatus: l.status ?? null,
      },
      createdBy ? `isolate · ${createdBy}` : 'isolate (system)',
    );
    out.isolated++;
  }

  /**
   * Put back anything that has since become reachable.
   *
   * Isolation describes a condition, not a verdict. A lead that gains an email through a
   * BatchData recovery is no longer unreachable, and leaving it parked would quietly
   * withhold a lead the campaign should have.
   */
  for (const l of restorable) {
    /**
     * Only put a status back if isolation took one away.
     *
     * Leads isolated under the new rule never lost theirs, so writing isolatedFromStatus
     * over the top would undo any work done while the lead was parked — a lead rated
     * during isolation would be reset to whatever it was before.
     */
    const legacy = l.status === 'isolated';
    const back = l.isolatedFromStatus || 'new';
    await updateLead(l.propertyId ?? l.id, {
      ...(legacy ? { status: back } : {}),
      isolatedAt: null,
      isolatedFromStatus: null,
      isolatedReason: null,
      // Reachable again by other means — it leaves the pipeline the same way it leaves
      // isolation, or the tabs would keep offering to trace a lead that no longer needs it.
      recoveryStage: 'recovered',
      recoveredAt: new Date(),
      recoveredEmail: true,
    });
    await addActivity(
      l.id,
      'status_change',
      legacy
        ? `No longer isolated — insured email found. Status restored to ${back}.`
        : `No longer isolated — insured email found. Status unchanged (${l.status ?? '—'}).`,
      { changes: [{ field: 'Isolated', from: 'yes', to: 'no' }] },
      createdBy ? `isolate · ${createdBy}` : 'isolate (system)',
    );
  }

  return out;
}
