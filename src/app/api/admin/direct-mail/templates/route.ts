import { NextRequest, NextResponse } from 'next/server';
import { sql } from '@/lib/neon';
import { getSessionUser, actorLabel } from '@/lib/auth';
import { randomUUID } from 'crypto';
import { templateVars, LETTER_VARS } from '@/services/directMail.service';

/**
 * The letter templates.
 *
 *   GET  /api/admin/direct-mail/templates
 *   POST /api/admin/direct-mail/templates          { id?, name, html, ... }
 *
 * ── Why a save can be refused ────────────────────────────────────────────────
 * A template referencing a variable this channel cannot supply is not a draft to fix later;
 * it is a letter that prints a gap in a sentence. Lob's merge-variable strictness decides
 * whether the request errors or the variable renders as an empty string, and "somewhere
 * between  and " reaching 50 letterboxes is not a thing to find out afterwards. So the
 * unknown-variable check happens here, at the point of typing, and the save is rejected.
 *
 * The per-recipient check — a real variable that some households lack — is a different
 * question, answered against an actual cohort list on the send screen. A template is not
 * wrong for using band_low; a cohort containing unpriced households is.
 *
 * ── Editing clears approval ──────────────────────────────────────────────────
 * Frank's compliance note is a one-time review of the template. "One-time" means of THAT
 * wording: an approved letter that is then edited is an unapproved letter, and carrying the
 * tick across an edit would let a reviewed piece become an unreviewed one silently.
 */
export const dynamic = 'force-dynamic';

export async function GET() {
  try {
    const rows = await sql`
      SELECT * FROM "DirectMailTemplate" ORDER BY "updatedAt" DESC`;
    return NextResponse.json({ success: true, templates: rows, letterVars: LETTER_VARS });
  } catch (err) {
    console.error('GET /api/admin/direct-mail/templates error:', err);
    return NextResponse.json({ success: false, error: 'Could not read the templates' }, { status: 500 });
  }
}

export async function POST(req: NextRequest) {
  try {
    const user = await getSessionUser(req);
    const by = actorLabel(user);
    const b = await req.json();

    const name = String(b.name ?? '').trim();
    const html = String(b.html ?? '');
    if (!name) {
      return NextResponse.json({ success: false, error: 'The template needs a name.' }, { status: 400 });
    }

    const used = templateVars(html);
    const known = new Set<string>(LETTER_VARS);
    const unknown = used.filter((v) => !known.has(v));
    if (unknown.length) {
      return NextResponse.json({
        success: false,
        error: `This letter uses ${unknown.map((u) => `{{${u}}}`).join(', ')}, which direct mail cannot supply. A letter has no subject line and no booking link — its call to action is the number printed on the page.`,
        unknown,
      }, { status: 400 });
    }

    const size = b.size === 'us_legal' ? 'us_legal' : 'us_letter';
    const color = !!b.color;
    const doubleSided = b.doubleSided !== false;

    /**
     * An absent field keeps what is there; it does not erase it.
     *
     * A save that omitted the return address used to write five nulls over it, and nothing
     * noticed until the vendor refused four letters with "from.address_line1 is required" —
     * by which point the envelope had been empty for however long. The return address is
     * printed on every letter and is edited far less often than the wording, so the common
     * case is a caller that simply did not mention it.
     */
    const keep = (incoming: unknown, existing: string | null | undefined) => {
      if (incoming === undefined || incoming === null) return existing ?? null;
      const v = String(incoming).trim();
      return v || null;
    };
    const [current] = b.id
      ? await sql`SELECT * FROM "DirectMailTemplate" WHERE "id" = ${String(b.id)}` as Array<Record<string, any>>
      : [undefined];
    const from = {
      name: keep(b.fromName, current?.fromName),
      street: keep(b.fromStreet, current?.fromStreet),
      city: keep(b.fromCity, current?.fromCity),
      state: keep(b.fromState, current?.fromState),
      zip: keep(b.fromZip, current?.fromZip),
    };

    if (b.id) {
      if (!current) {
        return NextResponse.json({ success: false, error: 'That template no longer exists.' }, { status: 404 });
      }
      const existing = current as { html: string };
      // Only a wording change revokes the review. Changing the paper size does not make an
      // approved sentence unapproved, and clearing it then would train people to re-approve
      // without rereading.
      const htmlChanged = existing.html !== html;
      const [row] = await sql`
        UPDATE "DirectMailTemplate"
           SET "name" = ${name}, "html" = ${html}, "size" = ${size}, "color" = ${color},
               "doubleSided" = ${doubleSided},
               "fromName" = ${from.name}, "fromStreet" = ${from.street},
               "fromCity" = ${from.city}, "fromState" = ${from.state}, "fromZip" = ${from.zip},
               "printedVars" = ${used},
               "approvedAt" = CASE WHEN ${htmlChanged} THEN NULL ELSE "approvedAt" END,
               "approvedBy" = CASE WHEN ${htmlChanged} THEN NULL ELSE "approvedBy" END,
               "updatedBy" = ${by}, "updatedAt" = NOW()
         WHERE "id" = ${String(b.id)}
       RETURNING *` as Array<Record<string, unknown>>;
      return NextResponse.json({ success: true, template: row, approvalCleared: htmlChanged });
    }

    const [row] = await sql`
      INSERT INTO "DirectMailTemplate"
        ("id","name","html","size","color","doubleSided",
         "fromName","fromStreet","fromCity","fromState","fromZip","printedVars","createdBy","updatedBy")
      VALUES (${randomUUID()}, ${name}, ${html}, ${size}, ${color}, ${doubleSided},
              ${from.name}, ${from.street}, ${from.city}, ${from.state}, ${from.zip},
              ${used}, ${by}, ${by})
      RETURNING *` as Array<Record<string, unknown>>;
    return NextResponse.json({ success: true, template: row });
  } catch (err) {
    console.error('POST /api/admin/direct-mail/templates error:', err);
    const msg = err instanceof Error && /duplicate key/i.test(err.message)
      ? 'A template with that name already exists.'
      : 'Could not save the template';
    return NextResponse.json({ success: false, error: msg }, { status: 500 });
  }
}
