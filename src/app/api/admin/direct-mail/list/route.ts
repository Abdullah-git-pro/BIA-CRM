import { NextRequest, NextResponse } from 'next/server';
import { cohortMail, readiness, checkTemplate, renderLetter } from '@/services/directMail.service';
import { sql } from '@/lib/neon';
import { numberedCohorts } from '@/services/cohort';

/**
 * Who would get a letter from one cohort, and what their letter would say.
 *
 *   GET /api/admin/direct-mail/list?cohort=2026-10-12&grade=A&templateId=…
 *
 * Read-only. Nothing here prints anything — the send is a separate, deliberate POST that
 * does not exist yet, and will not until the template has been through Frank's review.
 *
 * With a templateId it also answers the question that matters before a batch: would EVERY
 * household on this list render that letter completely? Checked against the real recipients
 * rather than a list of variable names, because the only useful answer is about a specific
 * person's letter rather than about the template in the abstract.
 */
export const dynamic = 'force-dynamic';

export async function GET(req: NextRequest) {
  try {
    const p = req.nextUrl.searchParams;
    const cohort = (p.get('cohort') ?? '').trim();
    const grade = (p.get('grade') ?? 'A').trim();
    const templateId = (p.get('templateId') ?? '').trim();

    // Readiness across every numbered week, so the screen can show where the rest are stuck.
    if (!cohort) {
      return NextResponse.json({ success: true, grade, readiness: await readiness(grade) });
    }

    if (!numberedCohorts().includes(cohort)) {
      return NextResponse.json(
        { success: false, error: `${cohort} is not one of the numbered waves (C1–C8).` },
        { status: 400 },
      );
    }
    /**
     * Grade A only, and not as a default that can be overridden by a query string.
     *
     * Grade B has no band at all — 0 of 3,481 carry a carrier premium — so a Grade B letter
     * quoting a price is not a thing that can exist. Letting ?grade=B through would build a
     * list of 3,481 households whose letters are all missing the one number they are for.
     */
    if (grade !== 'A') {
      return NextResponse.json(
        { success: false, error: 'Direct mail is Grade A only for now. Grade B carries no band price.' },
        { status: 400 },
      );
    }

    const { recipients, readiness: forCohort } = await cohortMail(cohort, grade);

    let template = null;
    let check = null;
    let preview = null;
    if (templateId) {
      const [row] = await sql`
        SELECT * FROM "DirectMailTemplate" WHERE "id" = ${templateId}` as Array<Record<string, any>>;
      if (row) {
        template = row;
        check = checkTemplate(String(row.html ?? ''), recipients);
        // Previewed against a household that mails ELSEWHERE where the cohort has one: that
        // is the case most likely to read wrong, and the one a spot check would miss.
        const subject = recipients.find((r) => r.mailsElsewhere) ?? recipients[0] ?? null;
        if (subject) {
          preview = {
            propertyId: subject.propertyId,
            name: subject.name,
            mailsElsewhere: subject.mailsElsewhere,
            address: [subject.street, subject.city, subject.state, subject.zip].filter(Boolean).join(', '),
            html: renderLetter(String(row.html ?? ''), subject.vars),
          };
        }
      }
    }

    return NextResponse.json({
      success: true,
      cohort,
      grade,
      count: recipients.length,
      readiness: forCohort,
      recipients,
      template,
      check,
      preview,
    });
  } catch (err) {
    console.error('GET /api/admin/direct-mail/list error:', err);
    return NextResponse.json({ success: false, error: 'Could not build the mail list' }, { status: 500 });
  }
}
