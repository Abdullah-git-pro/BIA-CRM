import { sql } from '@/lib/neon';
import { randomUUID, createHash } from 'crypto';
import { createLetter, type LobMode } from '@/lib/integrations/lob';
import { wrapLetter, type MailRecipient } from './directMail.service';

/**
 * Sending a letter, and remembering that we did.
 *
 * ── The order of operations is the whole design ─────────────────────────────
 * The row is written BEFORE the vendor is called, not after.
 *
 * Writing afterwards is the obvious shape and it is wrong: if the process dies between the
 * vendor accepting a letter and our recording it, the letter is printed and we have no idea.
 * Re-running the batch then prints it again, and nobody can answer "who did we write to?"
 * The reverse failure — a row with no letter — is recoverable: it sits as 'queued' with an
 * error on it, visible, and nothing was spent.
 *
 * So: insert 'queued' → call Lob → update to 'sent' with the vendor's id, or to 'failed'
 * with the reason. Every state is on the row and none is inferred.
 *
 * ── The double-send lock is the database, not the code ──────────────────────
 * idempotencyKey is unique on DirectMailSend. A retry, a double-clicked button or a re-run
 * batch cannot insert a second row for the same household and template, so it cannot reach
 * Lob a second time. Lob replays its own response for a repeated key too, but we do not rely
 * on that: it returns the original letter without telling you it did, so the only honest
 * authority is our own index.
 */

export type SendOutcome = {
  propertyId: string;
  status: 'sent' | 'failed' | 'already_sent';
  letterId?: string;
  pdfUrl?: string | null;
  expectedAt?: string | null;
  error?: string;
};

/**
 * The identity of one printed letter: this wording, to this household, for this week.
 *
 * Deliberately NOT random and not time-based. A key that changes between attempts is not an
 * idempotency key at all; it is a unique id wearing the name, and a re-run would print the
 * whole cohort again. Hashed to stay inside Lob's 256-character limit, and prefixed with the
 * mode so a test run can never collide with a live one.
 *
 * ── Why the HTML is in the key ───────────────────────────────────────────────
 * It was cohort|template|lead, and that was wrong in a way only a proof could show. Lob
 * replays the original letter for a repeated key — so after the template was edited to
 * reserve space for the address block, re-sending returned the SAME ltr_ id and would have
 * printed the OLD wording, with the salutation under the barcode. Verified: identical id,
 * identical obsolete page. The template id does not change when its contents do.
 *
 * This key therefore answers "is this exact letter already printed?", which is the only
 * question idempotency can honestly answer. "Has this household already been written to
 * this week?" is a different question with a different answer — alreadySent() below — and
 * conflating the two meant an edited template could quietly mail somebody twice.
 */
export function idempotencyKeyFor(
  mode: LobMode, cohort: string, templateId: string, leadId: string, html: string,
): string {
  const h = createHash('sha256')
    .update(`${cohort}|${templateId}|${leadId}|${html}`)
    .digest('hex').slice(0, 40);
  return `${mode}-${h}`;
}

export type SendArgs = {
  mode: LobMode;
  cohort: string;
  batchId: string;
  template: {
    id: string; html: string; color: boolean; doubleSided: boolean; size: string;
    fromName: string | null; fromStreet: string | null; fromCity: string | null;
    fromState: string | null; fromZip: string | null;
  };
  recipient: MailRecipient;
  by: string | null;
};

export async function sendOne(args: SendArgs): Promise<SendOutcome> {
  const { mode, cohort, batchId, template, recipient, by } = args;
  /**
   * The page as the vendor will receive it, not the body as it was typed — the reserved
   * area is part of what gets printed, so it is part of what the key identifies.
   */
  const page = wrapLetter(template.html);
  const key = idempotencyKeyFor(mode, cohort, template.id, recipient.leadId, page);

  /**
   * One letter per household per cohort, whatever the wording.
   *
   * The key above stops the same letter printing twice. This stops a DIFFERENT letter going
   * to somebody we have already written to this week — which an edit to the template would
   * otherwise allow, because an edited template is honestly a different letter and gets a
   * different key.
   */
  const [prior] = await sql`
    SELECT "id" FROM "DirectMailSend"
     WHERE "leadId" = ${recipient.leadId} AND "cohort" = ${cohort} AND "mode" = ${mode}
     LIMIT 1` as Array<{ id: string }>;
  if (prior) return { propertyId: recipient.propertyId, status: 'already_sent' };

  /**
   * The insert IS the check.
   *
   * Asking "has this been sent?" and then inserting leaves a gap two requests can both pass
   * through. ON CONFLICT DO NOTHING closes it: either this call owns the send or somebody
   * else already does, decided by the database rather than by timing.
   */
  const claimed = await sql`
    INSERT INTO "DirectMailSend"
      ("id","leadId","propertyId","cohort","templateId","batchId","mode",
       "toName","toStreet","toCity","toState","toZip","mailsElsewhere",
       "varsSnapshot","idempotencyKey","status","createdBy")
    VALUES (${randomUUID()}, ${recipient.leadId}, ${recipient.propertyId}, ${cohort},
            ${template.id}, ${batchId}, ${mode},
            ${recipient.name}, ${recipient.street}, ${recipient.city},
            ${recipient.state}, ${recipient.zip}, ${recipient.mailsElsewhere},
            ${JSON.stringify(recipient.vars)}, ${key}, 'queued', ${by})
    ON CONFLICT ("idempotencyKey") DO NOTHING
    RETURNING "id"` as Array<{ id: string }>;

  if (!claimed.length) {
    return { propertyId: recipient.propertyId, status: 'already_sent' };
  }
  const rowId = claimed[0].id;

  try {
    const letter = await createLetter({
      to: {
        name: recipient.name,
        street: recipient.street,
        city: recipient.city,
        state: recipient.state,
        zip: recipient.zip,
      },
      from: {
        name: template.fromName ?? '',
        street: template.fromStreet ?? '',
        city: template.fromCity ?? '',
        state: template.fromState ?? '',
        zip: template.fromZip ?? '',
      },
      html: page,
      mergeVariables: recipient.vars,
      color: template.color,
      doubleSided: template.doubleSided,
      idempotencyKey: key,
      description: `${cohort} ${recipient.propertyId}`,
    }, mode);

    await sql`
      UPDATE "DirectMailSend"
         SET "status" = 'sent', "vendorLetterId" = ${letter.id},
             "vendorPdfUrl" = ${letter.url}, "expectedAt" = ${letter.expectedDeliveryDate},
             "sentAt" = NOW(), "updatedAt" = NOW()
       WHERE "id" = ${rowId}`;

    return {
      propertyId: recipient.propertyId, status: 'sent',
      letterId: letter.id, pdfUrl: letter.url, expectedAt: letter.expectedDeliveryDate,
    };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    /**
     * The row stays. A failure is a fact about this household worth keeping — usually an
     * address the vendor would not accept — and deleting it would hide the one case somebody
     * needs to look at, while freeing the key for a retry that may fail the same way.
     */
    await sql`
      UPDATE "DirectMailSend"
         SET "status" = 'failed', "error" = ${msg.slice(0, 500)}, "updatedAt" = NOW()
       WHERE "id" = ${rowId}`;
    return { propertyId: recipient.propertyId, status: 'failed', error: msg };
  }
}

/**
 * Who this cohort has already been ATTEMPTED for — successes and failures alike.
 *
 * It excluded failures at first, on the reasonable-sounding theory that a failed letter
 * should be offered again. That produced a batch that never finished: the lead stayed in
 * the pending list, the unique key stopped it being re-inserted, and every chunk handed
 * back "already sent" for the same household forever. A 50-letter run processed 53.
 *
 * The deeper problem is that these failures do not heal. The one C2 letter that failed was
 * refused as undeliverable — "121d Muhlen Platz" — and retrying that tomorrow produces the
 * identical refusal. So an attempt is terminal for the batch, and a failure is surfaced as
 * something a person looks at rather than something the loop keeps poking.
 */
export async function attempted(cohort: string, mode: LobMode): Promise<Set<string>> {
  const rows = await sql`
    SELECT "leadId" FROM "DirectMailSend"
     WHERE "cohort" = ${cohort} AND "mode" = ${mode}` as Array<{ leadId: string }>;
  return new Set(rows.map((r) => String(r.leadId)));
}

/** The ones that could not be printed, with the vendor's reason, for the screen. */
export async function failures(cohort: string, mode: LobMode): Promise<Array<{
  propertyId: string; toStreet: string; toCity: string; toZip: string; error: string;
}>> {
  return await sql`
    SELECT "propertyId", "toStreet", "toCity", "toZip", COALESCE("error",'') AS "error"
      FROM "DirectMailSend"
     WHERE "cohort" = ${cohort} AND "mode" = ${mode} AND "status" = 'failed'
     ORDER BY "propertyId"` as Array<{
       propertyId: string; toStreet: string; toCity: string; toZip: string; error: string;
     }>;
}
