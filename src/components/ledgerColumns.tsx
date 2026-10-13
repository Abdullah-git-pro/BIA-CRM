'use client';

import React from 'react';
import { Chip, Tooltip, Typography } from '@mui/material';
import { cohortCode } from '@/services/cohort';
import type { CohortLedgerRow } from '@/services/cohortLedger.service';

/**
 * The cohort ledger's columns — one definition, shared.
 *
 * ── Why this left the QC page ───────────────────────────────────────────────
 * The ledger moved to its own screen and the new page re-declared a shortened version of
 * this list. It rendered 13 of 25 columns, which is not a smaller table — it is a different
 * report with the same headings, missing "Call queue", "Direct mail", "No insured contact",
 * "Unworked A", "Lost", "Workable lost %" and the rest. Nobody comparing the two would have
 * been able to say which was right.
 *
 * Every column here carries its own meaning and several carry a tooltip explaining a number
 * that has been argued about before. Copying a subset of them by hand is how those
 * explanations get lost.
 */
/**
 * The real row type, imported rather than restated.
 *
 * Type-only: the service reads @/lib/neon, and a value import would pull the database
 * client into this bundle. The import is erased at compile time.
 *
 * This matters beyond tidiness. The Cohorts page originally typed its own row shape by hand
 * and invented three field names — climbedIn, toCall, mailablePct — which compiled fine and
 * threw "Cannot read properties of undefined" on first render. Against the real type those
 * three are errors before the page is ever opened.
 */
export type LedgerRow = CohortLedgerRow;

export type LedgerColumn = {
  header: string;
  value: (d: LedgerRow) => string;
  cell?: (d: LedgerRow) => React.ReactNode;
  /** Right-aligned on screen; numbers read better that way. */
  numeric?: boolean;
};

export const LEDGER_COLUMNS: LedgerColumn[] = [
  {
    header: 'Cohort',
    value: (d) => cohortCode(d.cohort) ?? '',
    cell: (d) => {
      const code = cohortCode(d.cohort);
      return code
        ? <Chip size="small" label={code} sx={{ height: 19, fontSize: 11, fontWeight: 700, bgcolor: '#e8eefc', color: '#1a3d7c' }} />
        : <span style={{ color: '#c2c7d0' }}>—</span>;
    },
  },
  { header: 'Renewal week', value: (d) => d.label },
  { header: 'Leads', value: (d) => String(d.total), numeric: true },
  { header: 'Grade A at pull', value: (d) => String(d.aAtPull), numeric: true },
  {
    header: 'Downgraded',
    value: (d) => String(d.downgraded),
    numeric: true,
    cell: (d) => (d.downgraded ? `−${d.downgraded}` : '—'),
  },
  { header: 'Low point', value: (d) => String(d.trough), numeric: true },
  {
    header: 'Regained A',
    value: (d) => String(d.recovered),
    numeric: true,
    cell: (d) => (
      <Tooltip arrow title={
        d.recovered
          ? `${d.recovered} lead${d.recovered === 1 ? '' : 's'} left Grade A and ${d.recovered === 1 ? 'is' : 'are'} Grade A again — a grade round trip. This is NOT the skip trace count; see "Email found".`
          : 'Nothing that left Grade A has come back to it. Contact recovery is counted under "Email found".'
      }>
        <span style={{ cursor: 'help' }}>{d.recovered ? `+${d.recovered}` : '—'}</span>
      </Tooltip>
    ),
  },
  {
    header: 'Grade A now',
    // The ↑ suffix is a screen affordance; the CSV gets the plain count and a separate
    // column below, because "141+18↑" is not a number a spreadsheet can total.
    value: (d) => String(d.aNow),
    numeric: true,
    cell: (d) => (
      <>
        {d.aNow.toLocaleString()}
        {d.gainedOther ? <Typography component="span" variant="caption" sx={{ color: '#166534', ml: 0.5 }}>+{d.gainedOther}↑</Typography> : null}
      </>
    ),
  },
  { header: 'Climbed in', value: (d) => String(d.gainedOther), numeric: true },
  {
    /* What the skip trace actually bought — the number that moves Mailable. */
    header: 'Email found',
    value: (d) => String(d.emailRecovered),
    numeric: true,
    cell: (d) => (
      <Tooltip arrow title={
        d.emailRecovered
          ? `Tracerfy or BatchData found an insured email for ${d.emailRecovered} isolated lead${d.emailRecovered === 1 ? '' : 's'} in this week. They were Grade A throughout — unmailable, not downgraded — so this shows up in Mailable rather than in the grade columns.`
          : 'No isolated lead in this week has had an insured email found for it yet.'
      }>
        <span style={{ cursor: 'help' }}>{d.emailRecovered ? `+${d.emailRecovered}` : '—'}</span>
      </Tooltip>
    ),
  },
  {
    /* Reach, not eligibility. Grade A says quote-ready; this says contactable. */
    header: 'Mailable',
    value: (d) => String(d.mailable),
    numeric: true,
    cell: (d) => {
      const share = d.aNow ? d.mailable / d.aNow : 1;
      return (
        <Tooltip arrow title={
          d.aNow
            ? `${d.mailable} of ${d.aNow} Grade A leads have an insured email — ${Math.round(share * 100)}%. The rest are quote-ready and unmailable.`
            : 'No Grade A leads in this week.'
        }>
          <span style={{ cursor: 'help' }}>
            {d.mailable.toLocaleString()}
            {d.aNow > 0 && d.mailable < d.aNow && (
              <Typography component="span" variant="caption" sx={{ color: '#8a5a00', ml: 0.75, fontWeight: 400 }}>
                {`· ${Math.round(share * 100)}%`}
              </Typography>
            )}
          </span>
        </Tooltip>
      );
    },
  },
  {
    /**
     * Verified — the column Frank asked for "right next to mailable" (25 Sep 2026).
     *
     * Mailable means the CRM holds an address for the insured. Verified means a third party
     * confirmed the mailbox exists. On C1–C3 those numbers were 132 and 106: twenty-six
     * accounts look reachable in every other report on this page and are not. Sending to
     * them is how a new domain earns a bounce rate before it has any reputation to spend.
     *
     * Blank rather than zero before a verification run: nothing checked is not the same as
     * nothing passed, and a column of zeroes would read as a cohort that had lost its
     * entire list to a verifier that has not run.
     */
    header: 'Verified',
    value: (d) => (d.verified + d.unverified > 0 ? String(d.verified) : ''),
    numeric: true,
    cell: (d) => {
      const checked = d.verified + d.unverified;
      if (!checked) {
        return (
          <Tooltip arrow title="No verification run has covered this week yet.">
            <span style={{ cursor: 'help', color: '#9aa4b2' }}>—</span>
          </Tooltip>
        );
      }
      const share = d.mailable ? d.verified / d.mailable : 1;
      return (
        <Tooltip arrow title={
          `${d.verified} of ${d.mailable} mailable accounts have an insured address a verifier confirmed. `
          + `The other ${d.unverified} hold an address that failed or has not been checked — those are the `
          + 'accounts to call rather than mail.'
        }>
          <span style={{ cursor: 'help' }}>
            {d.verified.toLocaleString()}
            {d.mailable > 0 && d.verified < d.mailable && (
              <Typography component="span" variant="caption" sx={{ color: '#8a5a00', ml: 0.75, fontWeight: 400 }}>
                {`· ${Math.round(share * 100)}%`}
              </Typography>
            )}
          </span>
        </Tooltip>
      );
    },
  },
  {
    /**
     * Did anyone read it — the question the ledger could not answer.
     *
     * Everything to the left of this says whether we CAN reach the week. This is the
     * first column that says whether reaching them did anything, and it is the number
     * Frank has asked for per cohort three times; until now it existed only on the
     * campaigns screen, broken down per campaign rather than per renewal week.
     *
     * ── What it does not cover ──────────────────────────────────────────────
     * Counted from our own send records, which hold 44 of the 70 opens the platform
     * knows about — the gap is addresses mailed with no send record on our side. And
     * five completed campaigns ran with open tracking switched off, so their weeks show
     * fewer opens than really happened. The tooltip says both, because a number that
     * undercounts silently is worse than one that admits it.
     */
    header: 'Opened',
    value: (d) => (d.emailed > 0 ? String(d.opened) : ''),
    numeric: true,
    cell: (d) => {
      if (!d.emailed) {
        return (
          <Tooltip arrow title="Nothing has been emailed for this week yet.">
            <span style={{ cursor: 'help', color: '#9aa4b2' }}>—</span>
          </Tooltip>
        );
      }
      const share = d.opened / d.emailed;
      return (
        <Tooltip
          arrow
          title={`${d.opened} of the ${d.emailed} addresses mailed in this week opened at least once. `
            + 'Counted per person, not per open. Undercounts: some sends have no record on our side, '
            + 'and the campaigns that ran before 7 Oct had open tracking switched off, so their opens '
            + 'were never recorded at all.'}
        >
          <span style={{ cursor: 'help' }}>
            <strong style={{ color: d.opened ? '#1b6b2f' : '#9aa4b2' }}>{d.opened}</strong>
            <Typography component="span" variant="caption" sx={{ color: '#8a94a6', ml: 0.5 }}>
              {`· ${Math.round(share * 100)}%`}
            </Typography>
          </span>
        </Tooltip>
      );
    },
  },
  {
    /**
     * The call-first list, as a number. Frank: "Non-verified = 72 ... We call these first
     * and as soon as ready."
     *
     * Held apart from "no email at all", which is a different population worked the same
     * way but for a different reason — one has nothing, the other has something that does
     * not work.
     */
    header: 'To call',
    value: (d) => (d.verified + d.unverified > 0 ? String(d.unverified) : ''),
    numeric: true,
    cell: (d) => {
      const checked = d.verified + d.unverified;
      if (!checked) return <span style={{ color: '#9aa4b2' }}>—</span>;
      return (
        <Tooltip arrow title={
          `${d.unverified} mailable account(s) whose insured address failed verification or has `
          + 'not been checked. Reachable by phone, not by email.'
        }>
          <span style={{ cursor: 'help', color: d.unverified ? '#8a5a00' : undefined, fontWeight: d.unverified ? 700 : 400 }}>
            {d.unverified.toLocaleString()}
          </span>
        </Tooltip>
      );
    },
  },
  {
    header: 'Mailable %',
    // Written out because a reader of the file cannot divide two columns in their head,
    // and this is the ratio the cohort is judged on.
    value: (d) => (d.aNow ? String(Math.round((d.mailable / d.aNow) * 100)) : ''),
    numeric: true,
  },
  {
    /* Phone but no email — the call queue, not a loss. */
    header: 'Call queue',
    value: (d) => String(d.phoneOnly),
    numeric: true,
    cell: (d) => (
      <Tooltip arrow title={
        d.phoneOnly
          ? `${d.phoneOnly} Grade A lead${d.phoneOnly === 1 ? '' : 's'} with a phone but no insured email. They go to the call queue, not the email campaign, and they are not downgraded for it.`
          : 'Every Grade A lead in this week with a phone also has an email.'
      }>
        <span style={{ cursor: 'help' }}>{d.phoneOnly || '—'}</span>
      </Tooltip>
    ),
  },
  {
    /* Nothing anywhere on the card — the post is the only channel left. */
    header: 'Direct mail',
    value: (d) => String(d.directMailOnly),
    numeric: true,
    cell: (d) => (
      <Tooltip arrow title={
        `${d.directMailOnly} lead${d.directMailOnly === 1 ? '' : 's'} have no phone and no email anywhere on the card — direct mail by property address.`
        + (d.noInsuredContact > d.directMailOnly
          ? ` A further ${d.noInsuredContact - d.directMailOnly} have nothing for the INSURED but a co-insured contact, so the household can still be called.`
          : '')
      }>
        <span style={{ cursor: 'help' }}>
          {d.directMailOnly || '—'}
          {d.noInsuredContact > d.directMailOnly && (
            <Typography component="span" variant="caption" sx={{ color: '#8a5a00', ml: 0.5, fontWeight: 400 }}>
              {`+${d.noInsuredContact - d.directMailOnly}`}
            </Typography>
          )}
        </span>
      </Tooltip>
    ),
  },
  {
    /*
     * The amber "+n" on screen, given its own column in the file.
     *
     * Grade A with nothing for the INSURED but a contact somewhere on the household. On
     * screen it is a superscript next to Direct mail; in a spreadsheet a superscript is
     * nothing at all, and this is the population the insured-only send rule cannot reach.
     */
    header: 'No insured contact',
    value: (d) => String(d.noInsuredContact),
    numeric: true,
  },
  {
    /* Grade A nobody has put in front of a producer. Not lost — unseen. */
    header: 'Unworked A',
    value: (d) => (d.rated === 0 ? '' : String(d.unworkedGradeA)),
    numeric: true,
    cell: (d) => (
      d.rated === 0
        ? <Tooltip arrow title="This week has not been worked yet"><span style={{ color: '#9098a6' }}>—</span></Tooltip>
        : d.unworkedGradeA
          ? <Tooltip arrow title={
              d.unworkedTopCounty
                ? `${d.unworkedGradeA} Grade A still unrated — ${d.unworkedTopCountyShare}% of them in ${d.unworkedTopCounty}. ${d.rated} leads in this week have been rated, so these were available and never surfaced.`
                : `${d.unworkedGradeA} Grade A still unrated, spread across counties. ${d.rated} leads in this week have been rated.`
            }>
              <span style={{ cursor: 'help' }}>{d.unworkedGradeA.toLocaleString()}</span>
            </Tooltip>
          : '0'
    ),
  },
  { header: 'Lost', value: (d) => String(d.lost), numeric: true },
  {
    /*
     * Of the losses, the ones that were never contactable on any channel.
     *
     * Split out because the loss target is about outreach, and these are a data outcome.
     * Averaging them together produced a 20-40% loss against a 5% target with nothing on
     * screen to say what it was made of.
     */
    header: 'Lost: no contact',
    value: (d) => String(d.downgradedUncontactable),
    numeric: true,
    cell: (d) => (
      <Tooltip arrow title={
        d.downgradedUncontactable
          ? `${d.downgradedUncontactable} of the ${d.lost} lost had no phone and no email after the skip trace — they were never contactable, so they are not outreach attrition.`
          : 'Every loss in this week is for some reason other than being uncontactable.'
      }>
        <span style={{ cursor: 'help' }}>{d.downgradedUncontactable || '—'}</span>
      </Tooltip>
    ),
  },
  {
    header: 'Lost %',
    value: (d) => (d.lostPct == null ? '' : String(d.lostPct)),
    numeric: true,
    cell: (d) => (d.lostPct == null ? '—' : `${d.lostPct}%`),
  },
  {
    /* The same loss with the never-contactable taken out. Both are shown, never one. */
    header: 'Workable lost %',
    value: (d) => (d.workableLostPct == null ? '' : String(d.workableLostPct)),
    numeric: true,
    cell: (d) => (
      <Tooltip arrow title={
        d.workableLostPct == null
          ? 'No workable Grade A leads at pull in this week.'
          : `Of the leads that could actually be contacted, ${d.workableLostPct}% left Grade A. The headline ${d.lostPct}% includes ${d.downgradedUncontactable} that never had a phone or an email.`
      }>
        <span style={{ cursor: 'help' }}>{d.workableLostPct == null ? '—' : `${d.workableLostPct}%`}</span>
      </Tooltip>
    ),
  },
  {
    /*
     * Carried into the file rather than left in the footnote under the table.
     *
     * A loss percentage quoted without saying how many leads it could not see is the kind
     * of number that gets argued about a month later. On screen these live in a caption;
     * an exported row has no caption to sit under.
     */
    header: 'No pull record',
    value: (d) => String(d.noPullRecord),
    numeric: true,
  },
  { header: 'Left A unexplained', value: (d) => String(d.unexplained), numeric: true },
  { header: 'Rated', value: (d) => String(d.rated), numeric: true },
];
