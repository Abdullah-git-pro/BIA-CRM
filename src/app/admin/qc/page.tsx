'use client';

import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  Container, Box, Typography, Paper, ToggleButton, ToggleButtonGroup, TextField,
  FormControl, InputLabel, Select, MenuItem, Button, Chip, Table, TableHead, TableRow,
  TableCell, TableBody, CircularProgress, Alert, Stack, Tooltip,
  Divider,
} from '@mui/material';
import FactCheckIcon from '@mui/icons-material/FactCheck';
import SwapVertIcon from '@mui/icons-material/SwapVert';
import SearchIcon from '@mui/icons-material/Search';
import RoofingIcon from '@mui/icons-material/Roofing';
import ReportProblemIcon from '@mui/icons-material/ReportProblem';
import BoltIcon from '@mui/icons-material/Bolt';
import HistoryIcon from '@mui/icons-material/History';
import RunHistory, { type RunRow } from './RunHistory';
import CalendarMonthIcon from '@mui/icons-material/CalendarMonth';
// Type-only import: erased at build, so the server-side reports module never reaches
// the browser bundle. One definition of a report row, shared by producer and consumer.
import type { QcRow } from '@/services/reports.service';
/**
 * From @/lib, NOT from the service. These are values, and a value import pulls the whole
 * graph: contactability.service → recipients.service → skipTrace.service → @/lib/constants,
 * which reads NEXT_PUBLIC_REAL_ESTATE_API_KEY and would inline it into this bundle.
 */
import { CONTACTABILITY_LABEL, CHANNEL_LABEL } from '@/lib/contactability';
import { LOST_TARGET_PCT } from '@/lib/targets';
import { CATEGORY_LABEL, RECOVERABLE, type GradeChangeCategory } from '@/services/gradeChangeReason';
import PersonSearchIcon from '@mui/icons-material/PersonSearch';
import ContactPhoneIcon from '@mui/icons-material/ContactPhone';
import PhoneIcon from '@mui/icons-material/PhoneInTalk';
import DownloadIcon from '@mui/icons-material/Download';
import VerifiedUserIcon from '@mui/icons-material/VerifiedUserOutlined';
import Link from 'next/link';
import { useStickyState } from '@/hooks/useStickyState';
import { LEDGER_COLUMNS, type LedgerRow as SharedLedgerRow } from '@/components/ledgerColumns';
import { stickyFirstColumn, scrollableTable } from '@/lib/stickyColumn';

/** One renewal week in the Cohort Ledger — mirrors CohortLedgerRow on the server. */
/**
 * Re-exported from the shared column module rather than restated here.
 *
 * The local copy was missing `endsOn`, and would have gone on missing whatever the service
 * added next. Two hand-written descriptions of one row is how a page ends up reading a
 * field that does not exist — which is exactly what happened when the ledger moved to its
 * own screen.
 */
type LedgerRow = SharedLedgerRow;


type ReportType = 'co_insured_verify' | 'already_ours' | 'recapture_log' | 'cohort_ledger' | 'referral' | 'grade_overrides' | 'keyword' | 'roof_b' | 'type_mismatch' | 'owner_verify' | 'contact_coverage' | 'skiptrace_mismatch' | 'blast_skiptrace' | 'cohort' | 'reachability' | 'call_outcome' | 'emails_insured' | 'emails_all' | 'recapture_log';


const REPORTS: { key: ReportType; label: string; icon: React.ReactNode; blurb: string }[] = [

  { key: 'reachability', label: 'Reachability', icon: <ContactPhoneIcon />, blurb: 'Per renewal week: how many households we can reach at the named insured, how many only at the co-insured, and what the insured-only rule costs us in reach.' },
  { key: 'cohort', label: 'Renewal Week', icon: <CalendarMonthIcon />, blurb: 'Every lead whose renewal falls in the chosen effective-date range — the whole cohort, graded or not, with grade, status and how many are actually reachable.' },
  { key: 'referral', label: 'Referrals / Eligibility', icon: <FactCheckIcon />, blurb: 'Leads a carrier flagged Referral (or Non-eligible), with the reason entered.' },
  { key: 'grade_overrides', label: 'Grade Changes', icon: <SwapVertIcon />, blurb: 'Grade changes from both sides — a producer overriding with a reason, and the rules re-grading a lead. The system tab also flags leads whose stored grade no longer agrees with the rules.' },
  { key: 'keyword', label: 'Keyword Search', icon: <SearchIcon />, blurb: 'Search producer + variance notes and eligibility reasons for a keyword to spot trends.' },
  { key: 'roof_b', label: 'Grade-B: Roof Only', icon: <RoofingIcon />, blurb: 'Grade-B leads whose only knock is an unconfirmed roof. Set the home-age band — the roof year is unknown on every one of these, so age of the house is what separates them. Frank\'s criterion is homes 21 to 76 years old. Both boxes are inclusive.' },
  { key: 'type_mismatch', label: 'Type Mismatch', icon: <ReportProblemIcon />, blurb: 'Leads a producer flagged where the REAPI property type looks wrong (e.g. condo that’s really a home).' },
  { key: 'owner_verify', label: 'WIP Verify Fails', icon: <PersonSearchIcon />, blurb: 'Leads that failed tax-roll verification — not found on the roll, or the insured name disagrees with it. Review before outreach.' },
  { key: 'contact_coverage', label: 'Contact Coverage', icon: <ContactPhoneIcon />, blurb: 'Rated accounts by property type (Condo/SFH) and contact status (phone-only / email-only / both / neither) + DOB. The no-email rows drive the downgrade decision.' },
  { key: 'skiptrace_mismatch', label: 'Name Mismatch', icon: <ReportProblemIcon />, blurb: 'Leads where the skip-trace insured name disagrees with the name on file — override per-lead from the card, then fix the carrier portal.' },
  { key: 'call_outcome', label: 'Calls & Outcomes', icon: <PhoneIcon />, blurb: 'Where every workable lead stands on the two things a producer does to it: the call and the quote. Filter by call status, by what the last call returned, or by quote stage — the same states shown on the lead card.' },
  { key: 'emails_insured', label: 'Email list — insured', icon: <ContactPhoneIcon />, blurb: 'The go-live send list: every Grade A lead in the range with an email for the NAMED INSURED, which is who E1 mails. One row per lead, with the addresses themselves.' },
  { key: 'emails_all', label: 'Email list — insured or co-insured', icon: <ContactPhoneIcon />, blurb: 'The same list widened to leads reachable only at the co-insured. The difference between this and the insured list is what the insured-only rule costs in reach.' },
  /**
   * Named no grade, because the query has no grade filter — it returns every lead that a
   * blast has queued or traced, A and B together. Calling it "a Grade-A cohort blast" put
   * the wrong word above a screen showing 2,419 Grade B leads, and the sentence read as an
   * explanation rather than as a mistake.
   */
  { key: 'blast_skiptrace', label: 'Blast Skip Traces', icon: <BoltIcon />, blurb: 'Leads traced by a cohort blast rather than by hand, Grade A and Grade B alike — when it ran, who ran it, what each lead returned and what it cost. Grouped by run.' },
  {
    key: 'already_ours',
    label: 'Already with our carriers',
    icon: <VerifiedUserIcon />,
    blurb: 'Accounts a producer found were already placed with Travelers or Plymouth Rock. '
      + 'Frank, 1 Oct: "it literally shows the proof of our concept." Most are declined by '
      + 'the carrier that already holds them and still eligible with the other, so the row '
      + 'says which one can write it — these are rewrites, not dead ends.',
  },
  {
    key: 'co_insured_verify',
    label: 'Co-insured vs WIIP',
    icon: <PersonSearchIcon />,
    blurb: 'The co-insured on the card against the name the municipal roll holds — the same '
      + 'check the insured already gets. WIIP returns the whole deed line, so both people '
      + 'come from one record. Only rows needing a decision are listed: a different person, '
      + 'a second owner the card never named, or a near-miss worth a glance.',
  },
  { key: 'recapture_log', label: 'Recapture Log', icon: <HistoryIcon />, blurb: 'Every account that came back into play: when, which renewal week it belongs to, which process returned it, and whether its cohort had already been frozen. A held account is one that arrived after its send list was built, so it is NOT in this cycle — those are the rows that need a decision.' },
];

/**
 * The four stages of contact recovery, in the order a lead passes through them.
 *
 * "Recovered" is a stage rather than just an outcome because it is the number Frank and
 * Ruben actually want — how many came back — and a count nobody can click is a count
 * nobody trusts.
 */
/**
 * The blurbs take the grade rather than naming one.
 *
 * "Grade A, quote-ready, no insured email" sat under the Grade B tab describing a
 * population that was not on screen — and it read as an explanation rather than as a
 * mistake, so the natural conclusion was that the 2,419 below it were Grade A. Frank ran a
 * Grade B blast and then could not tell which book he was looking at.
 *
 * A function cannot go stale the way a sentence can: there is no version of this that
 * silently says the wrong grade.
 */
const PIPELINE_STAGES = [
  {
    key: 'isolated' as const, label: 'Not traced yet', color: '#b3261e',
    blurb: (g: 'A' | 'B') => (g === 'A'
      ? 'Grade A, quote-ready, no insured email, and no deep trace has ever run. Tracerfy goes first.'
      : 'Grade B in the roof-age band, no insured email, and no deep trace has ever run. Tracerfy goes first.'),
  },
  {
    key: 'tracerfy' as const, label: 'Tracerfy found none', color: '#8a5a00',
    blurb: () => 'Tracerfy has run and returned no insured email. BatchData is next.',
  },
  {
    key: 'batchdata' as const, label: 'BatchData found none', color: '#5a6675',
    blurb: () => 'Both vendors have now run and neither found an insured email. Exhausted — nothing further to try.',
  },
  {
    key: 'recovered' as const, label: 'Recovered', color: '#2e7d46',
    blurb: () => 'An address came back. The lead is re-graded and returned to the status it held before isolation.',
  },
];
/**
 * Most a single blast will call, whatever the pool.
 *
 * A ceiling exists so nobody can spend thousands of vendor calls with one click — not to
 * make ordinary work take several clicks. It was 25, which meant a pool of 29 had to be
 * run twice for the sake of four leads. Set where a normal week's backlog finishes in one
 * run and an accidental whole-book blast still does not.
 */
const MAX_PER_BLAST = 100;

type PipelineStage = (typeof PIPELINE_STAGES)[number]['key'];
type PipelineRow = {
  id: string; owner: string; address: string | null; city: string | null; zip: string | null;
  effectiveDate: string | null; grade: string | null; status: string | null;
  hasEmail: boolean; hasPhone: boolean; triedTracerfyAt: string | null; triedBatchDataAt: string | null;
  recoveredBy: string | null;
  /** Trust / company / municipality owned — never sent to a vendor. */
  entity: { label: string; matched: string } | null;
};

/**
 * How the twelve reports are grouped in the picker.
 *
 * Flat, twelve boxes wrapped onto two rows with an orphan on the end, every one the same
 * weight — there was nothing to tell you which report answered which question, so finding
 * the right one meant reading all of them. Grouped by the question they answer: how is a
 * cohort doing, are the grades right, is the data sound, can we reach anyone.
 *
 * Keys not listed here still render, under "Other" — a report added later must never
 * vanish from the page because someone forgot to file it.
 */
const REPORT_GROUPS: { label: string; keys: ReportType[] }[] = [
  { label: 'Cohort performance', keys: ['cohort', 'reachability'] },
  { label: 'Grading', keys: ['grade_overrides', 'roof_b'] },
  { label: 'Data quality', keys: ['type_mismatch', 'skiptrace_mismatch', 'owner_verify', 'co_insured_verify', 'contact_coverage'] },
  { label: 'Producer work', keys: ['call_outcome'] },
  { label: 'Outreach', keys: ['emails_insured', 'emails_all', 'referral', 'blast_skiptrace', 'recapture_log', 'keyword'] },
  { label: 'Opportunity', keys: ['already_ours'] },
];

const gradeColor = (g: string | null) =>
  g === 'A' ? '#2e7d46' : g === 'B' ? '#c77a17' : g === 'C' ? '#c0522a' : '#6b7280';
const eligLabel = (v: string | null) => (v === 'review' ? 'Referral' : v === 'ineligible' ? 'Non-eligible' : v === 'eligible' ? 'Eligible' : '—');

const yn = (v: unknown) => (v ? 'Yes' : 'No');

/** Stored as 10 raw digits; shown the way a person would read one back. */
const fmtPhone = (p: string) => {
  const d = String(p ?? '').replace(/\D/g, '');
  return d.length === 10 ? `(${d.slice(0, 3)}) ${d.slice(3, 6)}-${d.slice(6)}` : String(p ?? '');
};

/**
 * ONE column definition per report, used by BOTH the table and the CSV export.
 *
 * They used to be declared separately — eleven hardcoded <TableCell>s in the table and a
 * different hand-written list in exportCsv. The two had already drifted: the CSV split
 * City and ZIP, carried a "Manual" column the table showed only as a pencil icon, and on
 * the Reachability tab wrote an entirely different set of ten columns from the eleven on
 * screen. Anyone reconciling the file against the page would have found a different
 * shape and reasonably concluded one of them was wrong.
 *
 * `value` is the exported string and the fallback rendering; `cell` is the richer
 * on-screen version when one is wanted. The CSV therefore cannot say anything the table
 * does not, and a new column appears in both or neither.
 */
type QcColumn = {
  header: string;
  value: (r: QcRow) => string;
  cell?: (r: QcRow) => React.ReactNode;
  /** Right-aligned in the table; numbers read better that way. */
  numeric?: boolean;
};

/**
 * The merge fields the campaign email substitutes, as export columns.
 *
 * Named exactly as the sending tool must reference them — camelCase, no spaces, because a
 * header here becomes the variable name on import and the platform's own are {{firstName}}.
 *
 * band_low and band_high were held deliberately EMPTY until 1 Oct 2026, and that is worth
 * keeping on the record. The pair the CRM held then came from a machine-generated estimate
 * sitting a median 3.2x above what the producer actually rated — on 531 of 540 rated
 * accounts the producer's own figure fell below it — so shipping it would have put a price
 * in front of a homeowner that nobody produced. The columns existed so the mapping could be
 * set up, waiting on Frank to say where a real range comes from.
 *
 * He said. The band is now derived from the cheapest premium of a carrier that rated the
 * home ELIGIBLE — the producer's own figure, the one producerPremium shows beside it — at
 * 90% rounded down to $25 and 105% rounded up. So the number in these columns is the number
 * in the email, and the reason for the blank is gone. Leaving them hardcoded to '' after
 * that is what made a working formula look broken: the value was in campaignVars the whole
 * time, and the table printed nothing over it.
 */
const CAMPAIGN_VAR_COLUMNS: QcColumn[] = [
  'firstName', 'lastName', 'street_address', 'street_name', 'town',
  'renewal_date', 'month', 'meeting_link',
  'subject_1', 'subject_2', 'subject_3',
  'cta_1', 'cta_2', 'cta_3',
  'segment', 'cohort', 'subject_variant', 'cta_arm', 'version_label',
].map((k): QcColumn => ({
  header: k,
  value: (r: QcRow) => String(r.campaignVars?.[k] ?? ''),
})).concat([
  { header: 'band_low', value: (r: QcRow) => String(r.campaignVars?.band_low ?? ''), numeric: true },
  { header: 'band_high', value: (r: QcRow) => String(r.campaignVars?.band_high ?? ''), numeric: true },
  { header: 'producer_premium', value: (r: QcRow) => String(r.campaignVars?.producer_premium ?? ''), numeric: true },
  /** Which carrier the band was built from — the cheapest that rated the home eligible. */
  { header: 'band_carrier', value: (r: QcRow) => String(r.campaignVars?.band_carrier ?? '') },
]);

/**
 * One address per column, as many columns as the widest row needs.
 *
 * ── Why not one cell with commas in it ──────────────────────────────────────
 * The joined cell was unreadable on screen — three wrapped addresses in a 90px column — and
 * worse in the file: a spreadsheet cannot sort, filter or verify a cell holding three
 * values, and a verification tool handed that CSV sees one column of nonsense rather than
 * three addresses. Zoya runs exactly that tool over exactly this export.
 *
 * ── Why the count comes from the rows ───────────────────────────────────────
 * A fixed cap would silently drop the fourth address on the one card that has four, which is
 * the shape of bug this file keeps finding elsewhere: a hand-set limit nothing checks. The
 * widest row in the result set decides, so a card with five gets five columns and a result
 * set with none still shows one, so the header is never missing entirely.
 */
function listColumns(
  header: string,
  rows: QcRow[],
  pick: (r: QcRow) => string[] | null | undefined,
  format: (v: string) => string = (v) => v,
): QcColumn[] {
  const widest = rows.reduce((n, r) => Math.max(n, pick(r)?.length ?? 0), 0);
  return Array.from({ length: Math.max(1, widest) }, (_, i) => ({
    header: `${header} ${i + 1}`,
    value: (r: QcRow) => {
      const v = pick(r)?.[i];
      return v ? format(v) : '';
    },
  }));
}

function columnsFor(report: ReportType, rows: QcRow[] = []): QcColumn[] {

  const base: QcColumn[] = [
    /**
     * The key every export was missing.
     *
     * Frank, 17 Sep 2026: "How do I know which co-insured links to which card? … It can't
     * be in chronological order because the numbers aren't the same." Two exports taken
     * with different filters could not be joined — there was no column common to both that
     * identified a property, only an owner name, and names are neither unique nor stable.
     *
     * First column on purpose: it is the one a VLOOKUP needs to find.
     */
    {
      header: 'Lead ID',
      value: (r) => r.propertyId,
      cell: (r) => (
        <Link href={`/leads/${r.propertyId}?from=qc`} style={{ color: '#6b7280', textDecoration: 'none', fontSize: 11, fontFamily: 'monospace' }}>
          {r.propertyId}
        </Link>
      ),
    },
    {
      header: 'Owner',
      value: (r) => r.owner,
      cell: (r) => (
        <Link href={`/leads/${r.propertyId}?from=qc`} style={{ color: '#1565c0', textDecoration: 'none' }}>{r.owner}</Link>
      ),
    },
    {
      /**
       * The street line, next to the town rather than folded into it.
       *
       * City and ZIP were the only location on every export, and they identify a
       * neighbourhood, not a house. A producer working a list, or anyone reconciling two
       * exports, is looking for the property — and on a street where several cards share
       * an owner surname the town alone cannot tell them apart.
       */
      header: 'Address',
      value: (r) => r.address ?? '—',
      cell: (r) => (r.address
        ? <span style={{ whiteSpace: 'nowrap' }}>{r.address}</span>
        : <span style={{ color: '#b0b6c0' }}>—</span>),
    },
    {
      header: 'City / ZIP',
      value: (r) => [r.city, r.zip].filter(Boolean).join(' ') || '—',
      cell: (r) => <>{r.city} <span style={{ color: '#9098a6', fontSize: 12 }}>{r.zip}</span></>,
    },
    { header: 'Eff Date', value: (r) => r.effectiveDate ?? '—' },
    {
      header: 'Grade',
      /**
       * The one cell that cannot be byte-identical to the table: on screen an override is
       * a ✎ icon next to the chip, and an icon has no text form. The CSV says it in words
       * instead, so the file carries the same FACT even though the characters differ.
       *
       * Two spellings because "A (manual: A)" is nonsense — when the override agrees with
       * the grade the only thing worth saying is that a producer set it deliberately.
       */
      value: (r) => {
        const g = r.grade ?? '?';
        if (!r.manualGrade) return g;
        return r.manualGrade === r.grade ? `${g} (manual override)` : `${g} (manual: ${r.manualGrade})`;
      },
      cell: (r) => (
        <>
          <Chip label={r.grade ?? '?'} size="small" sx={{ bgcolor: gradeColor(r.grade), color: '#fff', fontWeight: 700, height: 20 }} />
          {r.manualGrade && <Tooltip title="Manual override"><span style={{ marginLeft: 4, fontSize: 11, color: '#8a5a00' }}>✎</span></Tooltip>}
        </>
      ),
    },
    { header: 'Type', value: (r) => r.propertyType ?? '—' },
    { header: 'Travelers', value: (r) => eligLabel(r.travelersEligible) },
    { header: 'Plymouth', value: (r) => eligLabel(r.plymouthEligible) },
    {
      // The `reason` field carries a different thing per report, so it gets the name of
      // whatever it actually holds rather than a catch-all "Reason".
      header: report === 'cohort' ? 'Status' : report === 'reachability' ? 'Renewal Week' : 'Reason',
      value: (r) => r.reason ?? '—',
      cell: (r) => (r.reason
        ? <Chip label={r.reason} size="small" sx={{ height: 20, fontSize: 11, bgcolor: '#fff3d6', color: '#8a5a00', fontWeight: 600 }} />
        : <span style={{ color: '#b0b6c0' }}>—</span>),
    },
  ];

  // Per-report facts. These were previously visible only as prose inside Detail, which
  // meant they could not be sorted or filtered in a spreadsheet.
  const extras: QcColumn[] = report === 'cohort'
    ? [
        /**
         * The addresses themselves, not Yes/No.
         *
         * A Yes told you the household was reachable but not at what, so checking one
         * homeowner — or handing the list to anyone — meant opening every card. A lead can
         * hold several insured addresses, so all of them are listed; an empty cell means
         * none, which reads the same as the old "No".
         */
        ...listColumns('Insured Email', rows, (r) => r.insuredEmailList),
        // The second email in the cadence goes to this person, so the export has to carry
        // who they are — an address with no name cannot be addressed.
        { header: 'Co-Insured Name', value: (r) => r.coInsuredName ?? '' },
        ...listColumns('Co-Insured Email', rows, (r) => r.coInsuredEmailList),
        ...listColumns('Insured Phone', rows, (r) => r.insuredPhoneList, fmtPhone),
        ...listColumns('Co-Insured Phone', rows, (r) => r.coInsuredPhoneList, fmtPhone),
        { header: 'Deep Traced', value: (r) => yn(r.matched) },
        /**
         * contactability (Sec. 4.1) — first among the contact columns on purpose.
         *
         * It is the field the campaign list is built from, so an export handed to anyone
         * carries the routing decision with it rather than leaving them to re-derive it
         * from five address columns and get a different answer.
         */
        { header: 'Contactability', value: (r) => CONTACTABILITY_LABEL[r.contactability ?? 'none'] },
        { header: 'Channel', value: (r) => CHANNEL_LABEL[r.channel ?? 'mail'] },
      ]
    : report === 'emails_insured' || report === 'emails_all'
      ? [
          /**
           * The send lists (Frank, 23 Sep 2026). Addresses first, because that is what the
           * file is for — everything else on the row is there so a validated address can be
           * traced back to a property.
           *
           * The insured and co-insured columns stay apart even on the wider list. Merging
           * them would make the two exports impossible to check against each other, which
           * is the only reason there are two.
           */
          ...listColumns('Insured Email', rows, (r) => r.insuredEmailList),
          ...(report === 'emails_all'
            ? [
              { header: 'Co-Insured Name', value: (r: QcRow) => r.coInsuredName ?? '' },
              ...listColumns('Co-Insured Email', rows, (r) => r.coInsuredEmailList),
              // The leads this list adds and the insured-only list loses.
              { header: 'Co-Insured Only', value: (r: QcRow) => yn(r.coInsuredOnly) },
            ]
            : []),
          { header: 'Renewal Week', value: (r) => r.cohort ?? '' },
          /**
           * ── The campaign merge fields ─────────────────────────────────────
           *
           * Everything the email itself substitutes, under the names the sending tool uses,
           * so this file can be imported and mapped without anything being rebuilt at the
           * other end. Rebuilding is what produced a renewal date one day early on all 678
           * accounts, and a template asking for {{ first_name }} against a contact carrying
           * firstName, which renders blank and looks exactly like missing data.
           *
           * camelCase and no spaces, deliberately: the platform's own variables are spelled
           * {{firstName}}, and a header here becomes the variable name on import.
           */
          ...CAMPAIGN_VAR_COLUMNS,
        ]
      : report === 'reachability'
        ? [
          { header: 'Insured Emails', value: (r) => String(r.insuredEmailCount ?? 0), numeric: true },
          { header: 'Co-Insured Only', value: (r) => yn(r.coInsuredOnly) },
          { header: 'Reachable', value: (r) => yn((r.insuredEmailCount ?? 0) > 0 || r.coInsuredOnly) },
        ]
      : report === 'contact_coverage'
        ? [
            { header: 'Phone', value: (r) => yn(r.hasPhone) },
            { header: 'Email', value: (r) => yn(r.hasEmail) },
            { header: 'DOB', value: (r) => yn(r.hasDob) },
            { header: 'Condo', value: (r) => yn(r.isCondo) },
          ]
        : report === 'blast_skiptrace'
          ? [
              { header: 'Matched', value: (r) => yn(r.matched) },
              { header: 'Phone Found', value: (r) => yn(r.hasPhone) },
              { header: 'Email Found', value: (r) => yn(r.hasEmail) },
            ]
          : report === 'call_outcome'
            ? [
                {
                  header: 'Call status',
                  value: (r) => (r.callStatus ?? '').replace('_', ' '),
                  cell: (r) => {
                    // The four that replaced 'contacted' are not all green. A quote being
                    // worked and a do-not-call were the same word and belong at opposite
                    // ends of the queue.
                    const c = r.callStatus === 'quoting' ? { bg: '#e7f5ec', fg: '#166534' }
                      : r.callStatus === 'callback_due' ? { bg: '#e8f0fe', fg: '#1565c0' }
                        : r.callStatus === 'do_not_call' || r.callStatus === 'unreachable'
                          ? { bg: '#fdecea', fg: '#b3261e' }
                          : r.callStatus === 'attempting' ? { bg: '#fff8e8', fg: '#8a5a00' }
                            : { bg: '#eef1f5', fg: '#5a6675' };
                    return (
                      <Chip size="small" label={(r.callStatus ?? '').replace('_', ' ')}
                        sx={{ height: 19, fontSize: 11, fontWeight: 700, bgcolor: c.bg, color: c.fg }} />
                    );
                  },
                },
                // Attempts AND days, because Frank's stop rule needs both: four calls in
                // one afternoon is not an unreachable lead.
                { header: 'Attempts', value: (r) => String(r.callAttempts ?? 0), numeric: true },
                { header: 'Days dialled', value: (r) => String(r.callDays ?? 0), numeric: true },
                {
                  header: 'Last outcome',
                  value: (r) => (r.callLastOutcome ?? '').replace(/_/g, ' '),
                  cell: (r) => (r.callLastOutcome ? r.callLastOutcome.replace(/_/g, ' ') : '—'),
                },
                {
                  header: 'Quote stage',
                  value: (r) => (r.quoteStage ?? '').replace('_', ' '),
                  cell: (r) => {
                    const c = r.quoteStage === 'sold' ? { bg: '#e7f5ec', fg: '#166534' }
                      : r.quoteStage === 'lost' ? { bg: '#fdecea', fg: '#b3261e' }
                        : r.quoteStage === 'quoted' ? { bg: '#e8eefc', fg: '#1a3d7c' }
                          : { bg: '#eef1f5', fg: '#5a6675' };
                    return (
                      <Chip size="small" label={(r.quoteStage ?? '').replace('_', ' ')}
                        sx={{ height: 19, fontSize: 11, fontWeight: 700, bgcolor: c.bg, color: c.fg }} />
                    );
                  },
                },
                { header: 'Quoted', value: (r) => (r.quotedPremium == null ? '' : String(r.quotedPremium)), numeric: true },
                { header: 'Sold for', value: (r) => (r.boundPremium == null ? '' : String(r.boundPremium)), numeric: true },
                { header: 'Lost reason', value: (r) => r.lostReason ?? '' },
              ]
            : [];

  const all: QcColumn[] = [
    ...base,
    ...extras,
    { header: 'Detail', value: (r) => r.context },
    { header: 'By', value: (r) => r.by ?? '—' },
    { header: 'When', value: (r) => r.at ?? '—' },
  ];

  /**
   * Borrow a column from the shared list by its header.
   *
   * It throws on a miss instead of returning undefined. `find(...)!` tells the compiler a
   * lookup cannot fail while leaving it free to fail at runtime — and it did: a branch
   * below asked for 'City' when the header is 'City / ZIP', so an undefined went into the
   * column list and the whole page died on `c.numeric`, with a stack pointing at the table
   * three hundred lines from the mistake. Failing here names the header that is wrong.
   *
   * It is the same trap as LEAD_COLS: a hand-written list of strings that another list has
   * to keep agreeing with, and nothing checking that it does.
   */
  const take = (h: string) => {
    const c = all.find((x) => x.header === h);
    if (!c) throw new Error(`columnsFor(${report}): no column headed "${h}" — it was renamed or removed`);
    return c;
  };

  /**
   * Card against roll, in adjacent columns.
   *
   * The comparison IS the report — a reader has to see "Kristi Schiavone" next to "Kristi
   * Graham" to judge it, so neither name belongs inside a Detail sentence.
   *
   * Built with take() rather than fresh definitions. The first version wrote its own
   * Lead ID and Owner columns and they rendered as plain text: the shared ones carry a
   * `cell` that links to the card, and redefining them silently dropped it. Reusing them
   * means this report cannot lose a behaviour the others have.
   */
  if (report === 'co_insured_verify') {
    return [
      take('Lead ID'),
      take('Owner'),
      take('Address'),
      take('City / ZIP'),
      take('Grade'),
      { header: 'Co-insured on the card', value: (r: QcRow) => r.coInsuredName ?? '' },
      { header: 'Co-insured per WIIP', value: (r: QcRow) => r.rollCoInsured ?? '' },
      { header: 'Verdict', value: (r: QcRow) => r.reason ?? '' },
      { header: 'Detail', value: (r: QcRow) => r.context ?? '' },
      { header: 'Checked', value: (r: QcRow) => (r.at ?? '').slice(0, 10) },
    ];
  }

  /**
   * Grade Changes: the date and the category belong at the FRONT.
   *
   * 'When' is the last of fourteen columns, past a Detail column wide enough to push it
   * off screen — which is why the tab looked as though it carried no date at all. The
   * category is what the list is read for, so it sits beside it rather than having to be
   * inferred from the free text in Detail.
   */
  if (report === 'grade_overrides') {
    const when = take('When');
    const rest = all.filter((c) => c.header !== 'When');
    const at = rest.findIndex((c) => c.header === 'Eff Date') + 1;
    rest.splice(at, 0,
      { ...when, header: 'Changed On' },
      /**
       * The renewal week, beside the date rather than instead of it (Frank, fix 20:
       * "with cohort, account count and process").
       *
       * Eff Date is a different date for every lead, so counting changes per week meant
       * grouping four hundred distinct dates by eye. The cohort is the only column here
       * that lines up with how the weeks are discussed everywhere else.
       */
      { header: 'Renewal week', value: (r) => r.cohort ?? '—' },
      { header: 'Why', value: (r) => CATEGORY_LABEL[(r.changeCategory ?? 'other') as GradeChangeCategory] ?? '—' },
    );
    return rest;
  }

  /**
   * Recapture Log: the event first, the account second (Frank, fix 22).
   *
   * He asked for "date, cohort, accounts affected, process, whether Ruben was notified" —
   * in that order, because the question the tab answers is "what changed and when", not
   * "tell me about this lead". The lead columns follow so a row can still be opened.
   *
   * Eligibility and property type are dropped. They describe the account as it is now, and
   * putting them beside columns that describe a moment in the past invites reading all of
   * them as the same vintage — which is the confusion this log exists to end.
   */
  if (report === 'recapture_log') {
    return [
      {
        header: 'Came back',
        value: (r) => (r.at ? new Date(r.at).toLocaleDateString() : '—'),
      },
      {
        /**
         * The renewal week as it was LOGGED, not as the lead reads now. A lead re-dated
         * afterwards must not silently move between weeks in a log that has been read.
         */
        header: 'Renewal week',
        value: (r) => r.cohort ?? '—',
      },
      take('Lead ID'),
      take('Owner'),
      take('Address'),
      take('City / ZIP'),
      {
        header: 'Returned by',
        value: (r) => r.recaptureProcess ?? '—',
      },
      {
        /**
         * Grade before and after in one column. Two columns reading "A" and "A" take twice
         * the width to say nothing; what matters is the handful where they differ.
         */
        header: 'Grade',
        value: (r) => (r.priorGrade && r.priorGrade !== (r.manualGrade ?? r.grade)
          ? `${r.priorGrade} → ${r.manualGrade ?? r.grade ?? '?'}`
          : (r.manualGrade ?? r.grade ?? '—')),
        cell: (r) => {
          const now = r.manualGrade ?? r.grade ?? null;
          const moved = r.priorGrade && r.priorGrade !== now;
          return (
            <span style={{ fontSize: 12 }}>
              {moved && <span style={{ color: '#6b7280' }}>{r.priorGrade} → </span>}
              <Chip label={now ?? '?'} size="small"
                sx={{ bgcolor: gradeColor(now), color: '#fff', fontWeight: 700, height: 19 }} />
            </span>
          );
        },
      },
      {
        /**
         * The column the tab exists for.
         *
         * "Held" means the account arrived after its cohort's send list was built, so it is
         * NOT in this cycle's mail. Frank's fix 19 is precisely that this must be visible
         * rather than silently absorbed — a cohort that grew after it was counted is the
         * thing nobody could previously see.
         */
        header: 'In this cycle?',
        value: (r) => (r.recaptureHeld ? 'No — held, arrived after the list was built' : 'Yes'),
        cell: (r) => (
          <Chip size="small" label={r.recaptureHeld ? 'Held back' : 'On the list'}
            sx={{
              height: 19, fontSize: 11, fontWeight: 700,
              bgcolor: r.recaptureHeld ? '#fff3d6' : '#e7f5ec',
              color: r.recaptureHeld ? '#8a5a00' : '#166534',
            }} />
        ),
      },
      {
        /** Fix 21: no retroactive change to a worked account without telling Ruben. */
        header: 'Ruben told',
        value: (r) => (r.recaptureNotifiedAt
          ? new Date(r.recaptureNotifiedAt).toLocaleDateString()
          : (r.recaptureHeld ? 'Not yet' : 'n/a — nothing changed for him')),
        cell: (r) => {
          if (r.recaptureNotifiedAt) {
            return <span style={{ fontSize: 12 }}>{new Date(r.recaptureNotifiedAt).toLocaleDateString()}</span>;
          }
          if (!r.recaptureHeld) return <span style={{ color: '#9aa4b2', fontSize: 12 }}>—</span>;
          return (
            <Chip size="small" label="Not yet"
              sx={{ height: 19, fontSize: 11, fontWeight: 700, bgcolor: '#fdecea', color: '#b3261e' }} />
          );
        },
      },
      {
        header: 'Status before',
        value: (r) => r.priorStatus ?? 'Not captured',
      },
      { header: 'Detail', value: (r) => r.context ?? '' },
    ];
  }

  return all;
}

/**
 * The recovery pipeline's columns — one definition for the table and the CSV.
 *
 * Same contract as LEDGER_COLUMNS and for the same reason. Export CSV used to write
 * `shownRows`, which on this report is the blast-run lead list — a table that is not on
 * screen at all, because this report draws its own. So the file described a different
 * population from the page, and the only clue was the row count.
 *
 * That is how "export gave me one lead" happened: the Eff from/to boxes persist across
 * report switches by design, a single week was still set from an earlier report, and the
 * blast-run list honestly held one lead for that week while the pipeline table on screen
 * showed a different number. Both were right; the export was reading the wrong one.
 */
type PipelineColumn = {
  header: string;
  value: (r: PipelineRow) => string;
  cell?: (r: PipelineRow) => React.ReactNode;
};

const PIPELINE_COLUMNS: PipelineColumn[] = [
  {
    header: 'Lead ID',
    value: (r) => r.id,
    cell: (r) => (
      <Link href={`/leads/${r.id}?from=qc`} style={{ color: '#6b7280', textDecoration: 'none', fontFamily: 'monospace', fontSize: 11 }}>{r.id}</Link>
    ),
  },
  {
    header: 'Owner',
    value: (r) => r.owner || '',
    cell: (r) => (
      <Link href={`/leads/${r.id}?from=qc`} style={{ color: '#1565c0', textDecoration: 'none' }}>{r.owner || '(no owner name)'}</Link>
    ),
  },
  {
    header: 'Address',
    value: (r) => r.address ?? '',
    cell: (r) => (r.address
      ? <span style={{ whiteSpace: 'nowrap' }}>{r.address}</span>
      : <span style={{ color: '#b0b6c0' }}>—</span>),
  },
  {
    header: 'City / ZIP',
    value: (r) => [r.city, r.zip].filter(Boolean).join(' '),
    cell: (r) => <>{r.city} <span style={{ color: '#9098a6' }}>{r.zip}</span></>,
  },
  { header: 'Eff date', value: (r) => r.effectiveDate ?? '' },
  {
    header: 'Grade',
    value: (r) => r.grade ?? '',
    cell: (r) => <Chip label={r.grade ?? '?'} size="small" sx={{ bgcolor: gradeColor(r.grade), color: '#fff', fontWeight: 700, height: 19 }} />,
  },
  { header: 'Status', value: (r) => r.status ?? '' },
  {
    // Green Yes / red No, never a dash: this is the column that says whether the lead can
    // be mailed at all, and a dash would read as "unknown" when it is a definite no.
    header: 'Insured email?',
    value: (r) => (r.hasEmail ? 'Yes' : 'No'),
    cell: (r) => (
      <span style={{ fontWeight: 700, color: r.hasEmail ? '#166534' : '#b3261e' }}>{r.hasEmail ? 'Yes' : 'No'}</span>
    ),
  },
  { header: 'Phone?', value: (r) => (r.hasPhone ? 'Yes' : 'No'), cell: (r) => (r.hasPhone ? 'Yes' : '—') },
  { header: 'Tracerfy tried', value: (r) => r.triedTracerfyAt ?? '', cell: (r) => r.triedTracerfyAt ?? '—' },
  { header: 'BatchData tried', value: (r) => r.triedBatchDataAt ?? '', cell: (r) => r.triedBatchDataAt ?? '—' },
  {
    header: 'Recovered by',
    value: (r) => r.recoveredBy ?? '',
    cell: (r) => (
      <span style={{ fontWeight: r.recoveredBy ? 700 : 400, color: r.recoveredBy ? '#166534' : 'inherit' }}>{r.recoveredBy ?? '—'}</span>
    ),
  },
  {
    /*
     * On screen these sit in their own panel below the table; in a file there is no
     * "below", so the distinction has to be a column or it is lost.
     */
    header: 'Trust / company owned',
    value: (r) => (r.entity ? r.entity.label : ''),
  },
];

/**
 * Reports that draw their own table and never populate `rows`.
 *
 * The generic per-lead table below renders for every other report. For these it drew an
 * empty one underneath the real one, headed "0 records — No records match", which reads
 * as a failed query sitting under a working report.
 *
 * Named as a set rather than repeated as `report !== 'x' && report !== 'y'` in the two
 * places that need it: the ledger was added months after the blast tab and inherited the
 * same bug, because the condition was a literal in two spots and nothing said what it was
 * for.
 */
const REPORTS_WITH_OWN_TABLE: ReportType[] = ['blast_skiptrace', 'cohort_ledger'];

/**
 * One renewal week's worth of column definitions — the ledger's answer to columnsFor().
 *
 * Same contract as QcColumn and for the same reason, stated at the top of this file: the
 * table and the CSV read one list, so the file cannot say something different from the
 * screen. The ledger previously rendered a hand-written header array and a hand-written
 * body, and could not be exported at all — `setLedger` leaves `rows` empty, so the Export
 * CSV button was permanently disabled on the one report Frank actually asked to be sent.
 *
 * `value` is the exported string; `cell` is the richer on-screen version where there is
 * one. Anything a tooltip explains has to survive into `value` as a plain number, because
 * a spreadsheet has no hover.
 */
// Shared with the standalone Cohorts screen — see src/components/ledgerColumns.tsx.
// Re-declared here once and the two drifted immediately; there is one list now.

export default function QcReportsPage() {
  // Filters persist across navigation until reset (Frank Aug-2026).
  const [report, setReport] = useStickyState<ReportType>('qc:report', 'referral');
  const [carrier, setCarrier] = useStickyState<'any' | 'travelers' | 'plymouth'>('qc:carrier', 'any');
  const [value, setValue] = useStickyState<'review' | 'ineligible' | 'eligible'>('qc:value', 'review');
  const [setBy, setSetBy] = useStickyState<'any' | 'producer' | 'system'>('qc:setBy', 'any');
  const [q, setQ] = useStickyState('qc:q', '');
  /**
   * The age band for the Grade-B roof report — of the HOUSE, not the roof.
   *
   * Every row in that report has an unknown roof year; that is what it selects for. So the
   * thing worth filtering on is how old the house is, which is what Frank's criterion is
   * written against: "homes 75 years or newer where an unknown or aged roof is the only
   * disqualifier."
   *
   * Defaults to his stated band rather than to the old behaviour. The old filter had no
   * upper bound and returned 941 houses built between 1850 and 1950.
   */
  /**
   * 'qc:ageMin2' — a NEW key on purpose.
   *
   * These are sticky, so an old value of 20 would survive in the browser of everyone who
   * has used this screen. That 20 meant "21 and up" under the old exclusive comparison and
   * means "20 and up" under the new inclusive one, so the same stored value would silently
   * widen the band by a year for exactly the people who use the report most.
   */
  const [ageMin, setAgeMin] = useStickyState('qc:ageMin2', '21');
  /**
   * Which grade the email lists cover.
   *
   * NOT sticky. Every other control here is a filter you refine; this one decides which
   * population leaves the building in a file that goes to a sending tool. Remembering it
   * across sessions is how somebody exports Grade Bs believing they exported Grade As —
   * the file looks identical and the copy is written for the other population.
   */
  const [listGrade, setListGrade] = useState<'A' | 'B'>('A');
  const [queueing, setQueueing] = useState(false);
  const [queues, setQueues] = useState<Array<{ grade: 'A' | 'B'; waiting: number; traced: number; queuedBy: string[]; oldest: string | null }>>([]);

  /**
   * What each blast queue is holding.
   *
   * Loaded separately from the report rows because it must be right even when the report
   * is empty: "0 records" and "no queue" look identical on screen, and one of them means
   * the button did nothing.
   */
  /**
   * Which grade's recovery pipeline is on screen.
   *
   * Sticky within the session only, via the same sessionStorage the stage uses: coming back
   * to a screen you left on Grade B should not silently show Grade A, but it must not
   * persist across days either — the default view of this screen is the go-live population.
   */
  const [pipeGrade, setPipeGrade] = useState<'A' | 'B'>('A');
  const [queueRun, setQueueRun] = useState<{ grade: 'A' | 'B'; done: number; total: number; hits: number; credits: number; busy: boolean; error: string | null } | null>(null);

  const loadQueues = useCallback(async () => {
    try {
      const res = await fetch('/api/admin/blast-queue');
      const json = await res.json();
      if (json.success) setQueues(json.queues ?? []);
    } catch { /* a queue header that fails to load must not take the report down */ }
  }, []);
  const [queueMsg, setQueueMsg] = useState<string | null>(null);

  /**
   * Put the rows currently on screen into a skip-trace blast queue.
   *
   * Sends the property ids RATHER than the filters that produced them. The blast otherwise
   * re-derives its population from Leads-page filters, and this report's population —
   * Grade B, roof year unknown, house 21-76 years old — is not expressible there. Sending
   * filters would run the blast over 3,482 leads when 2,681 were on screen, and the first
   * sign of it would be the credit bill.
   *
   * The grade travels with the request because A and B are separate queues with different
   * economics: a Grade A trace chases an address for an account already priced and ready to
   * send; a Grade B trace is speculative, which is exactly why Frank wants them apart.
   */
  const queueForBlast = async (grade: 'A' | 'B') => {
    const ids = shownRows.map((r: QcRow) => String(r.propertyId ?? '')).filter(Boolean);
    if (!ids.length) return;
    setQueueing(true);
    setQueueMsg(null);
    try {
      const res = await fetch('/api/admin/blast-queue', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          propertyIds: ids,
          grade,
          reason: report === 'roof_b'
            ? `Grade-B roof pull · homes ${ageMin}-${ageMax} · ${effFrom || 'any'} to ${effTo || 'any'}`
            : `${report} · ${effFrom || 'any'} to ${effTo || 'any'}`,
        }),
      });
      const json = await res.json();
      if (!json.success) throw new Error(json.error || 'Could not queue those leads');
      /**
       * Every number is reported, including the ones that mean "nothing happened". A bare
       * "queued 0" after selecting 2,681 leads reads as a failure; "all 2,681 were already
       * queued" is the same fact and answers the question the person is about to ask.
       */
      const bits = [`${json.queued} queued into the Grade ${grade} blast`];
      if (json.isolated) bits.push(`${json.isolated} isolated`);
      if (json.alreadyQueued) bits.push(`${json.alreadyQueued} already queued`);
      if (json.alreadyTraced) bits.push(`${json.alreadyTraced} already traced — not re-queued, they would re-spend credits`);
      if (json.alreadyIsolated) bits.push(`${json.alreadyIsolated} were already isolated, reason kept`);
      setQueueMsg(bits.join(' · '));
      void loadQueues();
    } catch (e) {
      setQueueMsg(e instanceof Error ? e.message : 'Could not queue those leads');
    } finally {
      setQueueing(false);
    }
  };
  // 76, per Frank on 28 Sep. Paired with ageMin's EXCLUSIVE 20, the band is 21-76.
  const [ageMax, setAgeMax] = useStickyState('qc:ageMax2', '76');
  const [effFrom, setEffFrom] = useStickyState('qc:effFrom', '');
  const [effTo, setEffTo] = useStickyState('qc:effTo', '');
  // Contact-coverage drill-down: click a summary chip to filter the rows to that slice.
  /** Drill-down on the Renewal Week summary: click a chip to filter, click again to clear. */
  /**
   * Renewal Week drill-down. One active choice PER KIND, not one overall, so "Grade A"
   * and "reachable by insured email" narrow together — which is the question actually
   * being asked ("how many Grade A can we email?"), and was impossible when picking a
   * second chip silently replaced the first.
   */
  // Sticky, like the filters above: opening a lead and coming back should not silently
  // widen the view the producer was reading.
  const [cohortFilter, setCohortFilter] = useStickyState<{ grade?: string; status?: string; trait?: string }>('qc:cohortFilter', {});
  /** Reachability drill-down: which slice of the population the table is narrowed to. */
  const [reachFilter, setReachFilter] = useStickyState<'all' | 'insured' | 'coOnly' | 'unreachable'>('qc:reachFilter', 'all');
  /**
   * Calls & Outcomes drill-down, kept as TWO independent filters.
   *
   * The questions worth asking of this report are crossings — "reached and never
   * quoted", "quoted a fortnight ago and neither sold nor lost" — and a single combined
   * chip list cannot express either. So the call state and the quote state narrow
   * separately and compose.
   */
  const [callFilter, setCallFilter] = useStickyState<string>('qc:callFilter', 'all');
  const [quoteFilter, setQuoteFilter] = useStickyState<string>('qc:quoteFilter', 'all');
  const [outcomeGrade, setOutcomeGrade] = useStickyState<string>('qc:outcomeGrade', 'all');
  const [covFilter, setCovFilter] = useStickyState<'all' | 'sfh' | 'condo' | 'both' | 'phoneOnly' | 'emailOnly' | 'neither' | 'noEmail' | 'hasDob'>('qc:covFilter', 'all');
  const [rows, setRows] = useState<QcRow[]>([]);
  const [ledger, setLedger] = useState<LedgerRow[]>([]);
  /** Grade Changes: which reason category the list is narrowed to (A33). */
  const [changeFilter, setChangeFilter] = useStickyState<string | null>('qc:changeFilter', null);

  /** Contact recovery run state — preview first, then an explicit paid run. */
  const [recovery, setRecovery] = useState<{ busy: boolean; preview: number | null; msg: string }>(
    { busy: false, preview: null, msg: '' },
  );


  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [ran, setRan] = useState(false);
  // Which report the rows in state actually came from. Switching reports keeps the
  // old rows on screen until the new fetch lands, so a summary computed from "rows"
  // would describe the previous report — the blast summary read 974 leads from the
  // Referrals list. Summaries render only once this matches.
  const [rowsReport, setRowsReport] = useState<ReportType | null>(null);
  /**
   * The home-age band the rows on screen were actually fetched with.
   *
   * Held apart from the input boxes so the summary can say which population is being
   * displayed rather than which one is being asked for. Those two drift the moment somebody
   * types without pressing Run, and the table gives no sign of it.
   */
  const [ranAge, setRanAge] = useState<{ min: number; max: number } | null>(null);

  /**
   * Restoring the view after a trip to a lead (Abdullah Sep-2026).
   *
   * The filters already survive in sessionStorage, but the RESULTS do not: coming back
   * put the producer on the right report with the right dates and an empty table asking
   * them to press Run again, on the pipeline's first stage rather than the one they had
   * open. The lead page sends them back with ?restore=1; that re-runs the report once,
   * after the sticky filters have hydrated, so the screen they left is the screen they
   * return to.
   */
  const [hydrated, setHydrated] = useState(false);
  const restoredRef = useRef(false);

  /**
   * ── Only the newest request may write to the screen ──────────────────────
   *
   * Switching reports starts a fetch and leaves the previous one in flight. Whichever
   * resolves LAST wins, and the slow one is usually the big one: leaving Referrals
   * (1,385 rows) for the email list reliably landed the referral rows under the email-list
   * tab. It is not obviously wrong on screen either — the stale callback also calls
   * setRowsReport with ITS OWN report, so the columns follow the old rows and the table is
   * internally consistent. Only the tab, the record count and the date range say otherwise,
   * which reads as a filter that did not apply rather than a response that arrived late.
   *
   * Every write below is therefore guarded on the sequence number this run was given. An
   * AbortController would stop the request, but not the ones already past the await inside
   * the vendor client — the guard covers both and is cheaper to reason about.
   */
  const runSeq = useRef(0);
  const run = useCallback(async () => {
    const seq = ++runSeq.current;
    const current = () => seq === runSeq.current;
    setLoading(true); setError(null);
    try {
      // The ledger is one row per WEEK, not per lead, so it has its own endpoint and its
      // own shape — forcing it through QcRow would mean inventing a lead for each cohort.
      if (report === 'cohort_ledger') {
        const u = new URL('/api/admin/cohort-ledger', window.location.origin);
        if (effFrom) u.searchParams.set('effFrom', effFrom);
        if (effTo) u.searchParams.set('effTo', effTo);
        const r = await fetch(u.toString());
        const j = await r.json();
        if (!j.success) throw new Error(j.error || 'Report failed');
        if (!current()) return;
        setLedger(j.data || []);
        setRows([]);
        setRowsReport(report);
        setRan(true);
        return;
      }

      const url = new URL('/api/admin/reports', window.location.origin);
      url.searchParams.set('report', report);
      if (report === 'referral') { url.searchParams.set('carrier', carrier); url.searchParams.set('value', value); url.searchParams.set('setBy', setBy); }
      if (report === 'keyword') url.searchParams.set('q', q.trim());
      if (report === 'emails_insured' || report === 'emails_all') {
        url.searchParams.set('grade', listGrade);
      }
      if (report === 'roof_b') {
        if (ageMin.trim()) url.searchParams.set('ageMin', ageMin.trim());
        if (ageMax.trim()) url.searchParams.set('ageMax', ageMax.trim());
        // Recorded as sent, so the summary describes the rows rather than the boxes.
        setRanAge({ min: Number(ageMin) || 21, max: Number(ageMax) || 76 });
      }
      if (effFrom) url.searchParams.set('effFrom', effFrom);
      if (effTo) url.searchParams.set('effTo', effTo);
      const res = await fetch(url.toString());
      const json = await res.json();
      if (!json.success) throw new Error(json.error || 'Report failed');
      if (!current()) return;
      setRows(json.data || []);
      setRowsReport(report);
      setRan(true);
      // The pipeline is part of this report, so it loads when the report does — with
      // whatever range the operator actually chose, and on the stage they were last
      // reading rather than always the first one.
      if (report === 'blast_skiptrace') {
        void loadPipelineRef.current?.(stageRef.current);
        void loadQueues();
      }
    } catch (e) {
      if (!current()) return;
      setError(e instanceof Error ? e.message : 'Report failed');
      setRows([]);
      setRowsReport(null);
    } finally {
      if (current()) setLoading(false);
    }
    /**
     * listGrade, ageMin and ageMax belong here for the same reason the rest do: run()
     * reads them when it builds the URL.
     *
     * Leaving listGrade out was a real bug, not a lint nit. The callback would have been
     * memoised with whatever grade was selected when it was created, so switching to
     * Grade B and pressing Run would have re-fetched Grade A and drawn it under a
     * Grade B toggle — a file of the wrong population, labelled as the right one, with
     * nothing on screen disagreeing.
     */
  }, [report, carrier, value, setBy, q, effFrom, effTo, listGrade, ageMin, ageMax, loadQueues]);

  /**
   * run() is defined above loadPipeline and needs to call it. A ref avoids reordering two
   * callbacks that each depend on the other's inputs.
   */
  const loadPipelineRef = useRef<((stage: PipelineStage) => Promise<void>) | null>(null);
  /**
   * Read inside loadPipeline instead of the state value.
   *
   * loadPipeline is memoised on [effFrom, effTo]; adding pipeGrade would rebuild it on every
   * switch and re-fire the effect that calls it, racing two requests for the two grades. The
   * ref is always current without changing the callback's identity.
   */
  const pipeGradeRef = useRef<'A' | 'B'>('A');

  /**
   * The stage on screen, held in a ref as well as in state because run() needs to read it
   * without taking it as a dependency (that would re-create run on every tab click and
   * re-fire the effects that watch it). Mirrored into sessionStorage so it is still the
   * chosen stage after a trip to a lead and back.
   */
  const stageRef = useRef<PipelineStage>('isolated');

  /** Recovery pipeline: which stage is on screen, its rows, and the stage totals. */
  const [pipeline, setPipeline] = useState<{
    stage: PipelineStage; rows: PipelineRow[];
    counts: Record<string, number> | null; busy: boolean; msg: string;
    /**
     * Set when a run ended itself — out of credits, a rejected key, or a vendor failing
     * on every call. Held apart from `msg` because it is a different kind of statement:
     * msg reports what a run did, this reports why it did not finish.
     */
    stopped?: { reason: 'no_credits' | 'auth' | 'vendor_error'; vendor: string; detail: string; remaining: number } | null;
    /**
     * Every run pointed at this range, newest first (Frank, fix 20).
     *
     * Carried beside the counts because it is what makes them readable: "45 waiting" means
     * one thing if nothing has ever been run against that week and another if three runs
     * have been over it and found nothing.
     */
    runs: RunRow[];
    /** Rows still saying 'running' an hour on — the process died without closing them. */
    stalled: RunRow[];
  }>({ stage: 'isolated', rows: [], counts: null, busy: false, msg: '', stopped: null, runs: [], stalled: [] });

  /**
   * Split the stage into what a blast can work and what it will never touch.
   *
   * Trust- and company-owned leads sit at their stage permanently: there is no named
   * person for a vendor to look up, so no run ever clears them. Left in the main table
   * they make the pipeline look stuck, and they inflate the "Run Tracerfy on N" button
   * into promising work it will skip. Separated here so both numbers tell the truth.
   */
  const pipelineWorkable = useMemo(
    () => pipeline.rows.filter((r) => !r.entity), [pipeline.rows],
  );
  const pipelineEntities = useMemo(
    () => pipeline.rows.filter((r) => r.entity), [pipeline.rows],
  );

  const loadPipeline = useCallback(async (stage: PipelineStage) => {
    stageRef.current = stage;
    try { sessionStorage.setItem('qc:pipeStage', stage); } catch { /* blocked storage is not worth failing over */ }
    setPipeline((p) => ({ ...p, busy: true, stage }));
    try {
      const u = new URL('/api/admin/recovery-pipeline', window.location.origin);
      if (effFrom) u.searchParams.set('effFrom', effFrom);
      if (effTo) u.searchParams.set('effTo', effTo);
      u.searchParams.set('stage', stage);
      u.searchParams.set('grade', pipeGradeRef.current);
      const j = await (await fetch(u.toString())).json();
      if (!j.success) throw new Error(j.error || 'Could not read the pipeline');
      /**
       * Drop a response for a grade that is no longer selected.
       *
       * Both pipelines have identical stage names, so a slow Grade A response landing after
       * a switch to Grade B would repaint B's panel with A's numbers and nothing would look
       * wrong. The server echoes the grade back precisely so this check is possible.
       */
      if (j.grade && j.grade !== pipeGradeRef.current) return;
      setPipeline((p) => ({
        ...p, stage, rows: j.data || [], counts: j.counts, busy: false,
        runs: j.runs || [], stalled: j.stalled || [],
      }));
    } catch (e) {
      setPipeline((p) => ({ ...p, busy: false, msg: e instanceof Error ? e.message : 'Failed' }));
    }
  }, [effFrom, effTo]);
  loadPipelineRef.current = loadPipeline;

  // Declared after the useStickyState calls above, so by the time this commits they have
  // already queued their restored values and the next render carries both.
  useEffect(() => {
    try {
      const st = sessionStorage.getItem('qc:pipeStage');
      if (st && PIPELINE_STAGES.some((s) => s.key === st)) {
        stageRef.current = st as PipelineStage;
        setPipeline((p) => ({ ...p, stage: st as PipelineStage }));
      }
    } catch { /* ignore blocked storage */ }
    setHydrated(true);
  }, []);

  useEffect(() => {
    if (!hydrated || restoredRef.current) return;
    restoredRef.current = true;
    const params = new URLSearchParams(window.location.search);
    if (params.get('restore') !== '1') return;
    // Drop the marker so a manual reload of this URL is an ordinary visit.
    window.history.replaceState(null, '', '/admin/qc');
    void run();
    restoreScrollRef.current = true;
  }, [hydrated, run]);

  /** Set when a restore is in flight, so the pipeline panel can be scrolled back into view. */
  const restoreScrollRef = useRef(false);
  const pipelineRef = useRef<HTMLDivElement | null>(null);
  useEffect(() => {
    if (!restoreScrollRef.current || loading || !pipelineRef.current) return;
    restoreScrollRef.current = false;
    pipelineRef.current.scrollIntoView({ block: 'start' });
  }, [loading, rowsReport]);

  const runPipelineBlast = useCallback(async (vendor: 'tracerfy' | 'batchdata', dryRun: boolean) => {
    setPipeline((p) => ({ ...p, busy: true, msg: '', stopped: null }));
    try {
      const j = await (await fetch('/api/admin/recovery-pipeline', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ vendor, effFrom, effTo, dryRun, limit: MAX_PER_BLAST }),
      })).json();
      if (!j.success) throw new Error(j.error || 'Blast failed');
      const name = vendor === 'tracerfy' ? 'Tracerfy' : 'BatchData';
      setPipeline((p) => ({
        ...p, busy: false, counts: j.counts, stopped: j.stopped ?? null,
        msg: `${name}: tried ${j.attempted}, matched ${j.matched}, `
          + `recovered ${j.recovered}`
          + (j.phoneOnly ? `, ${j.phoneOnly} gained a phone but no email` : '')
          + `, ${j.movedOn} moved on`
          // Said out loud: otherwise "tried 9" against a stage of 31 reads as a failure.
          + (j.entityOwned ? `, ${j.entityOwned} trust/company owned and not called` : ''),
      }));
      await loadPipeline(vendor === 'tracerfy' ? 'isolated' : 'tracerfy');
    } catch (e) {
      setPipeline((p) => ({ ...p, busy: false, stopped: null, msg: e instanceof Error ? e.message : 'Blast failed' }));
    }
  }, [effFrom, effTo, loadPipeline]);

  /**
   * Cleared when the tab or the dates change — never auto-loaded.
   *
   * It used to load itself the moment the tab opened, which meant that with the date
   * boxes empty it quietly scoped to the ENTIRE book and offered a paid blast against it.
   * Every isolated lead happens to come from one week, so "31" looked like that week's
   * number and was really all of them. Every other report on this page waits for Run;
   * this one has no business being the exception, least of all the one that spends money.
   */
  useEffect(() => {
    setPipeline((p) => ({ ...p, rows: [], counts: null, msg: '' }));
  }, [report, effFrom, effTo]);

  /**
   * Clear the result banners when the thing they described is no longer on screen.
   *
   * "Isolated 0." sat under a filter it had nothing to do with, minutes after the run that
   * produced it, reading as a statement about whatever the operator was looking at now. A
   * result is about the moment it was produced; once the tab, the dates or the filter move,
   * it is describing something the reader can no longer see, and a stale number on a screen
   * people are learning to trust is worse than no number.
   */
  useEffect(() => {
    setIsolateState((r) => ({ ...r, preview: null, msg: '' }));
    setRecovery((r) => ({ ...r, preview: null, msg: '' }));
  }, [report, effFrom, effTo, cohortFilter, changeFilter]);

  /**
   * What the run will cover, said in the operator's own terms.
   *
   * "181 leads" next to a table showing six is the kind of mismatch that makes a number
   * untrustworthy even when both are correct, so the scope is named rather than implied.
   */
  const scopeLabel = effFrom || effTo
    ? `${effFrom || 'the start'} – ${effTo || 'today'}`
    : 'the whole book';

  /** Isolate run state — preview, then apply. */
  const [isolateState, setIsolateState] = useState<{ busy: boolean; preview: number | null; msg: string }>(
    { busy: false, preview: null, msg: '' },
  );

  const runIsolate = useCallback(async (dryRun: boolean) => {
    setIsolateState((r) => ({ ...r, busy: true, msg: '' }));
    try {
      const res = await fetch('/api/admin/isolate', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ dryRun, effFrom, effTo }),
      });
      const j = await res.json();
      if (!j.success) throw new Error(j.error || 'Isolate failed');
      const was = Object.entries(j.fromStatus || {})
        .map(([k, v]) => `${v} ${k}`).join(', ');
      if (dryRun) {
        setIsolateState({
          busy: false,
          preview: j.candidates,
          msg: j.candidates
            ? `${j.candidates} would be isolated (currently ${was || 'unset'}). Their status is remembered and restored if an email turns up.`
              + (j.restored ? ` ${j.restored} already-isolated lead(s) are now reachable and would be put back.` : '')
            : 'Nothing to isolate in this range.',
        });
      } else {
        setIsolateState({
          busy: false, preview: null,
          msg: `Isolated ${j.isolated}${j.restored ? `, restored ${j.restored}` : ''}.`,
        });
        await run();
      }
    } catch (e) {
      setIsolateState({ busy: false, preview: null, msg: e instanceof Error ? e.message : 'Isolate failed' });
    }
  }, [run, effFrom, effTo]);

  const runRecovery = useCallback(async (dryRun: boolean) => {
    setRecovery((r) => ({ ...r, busy: true, msg: '' }));
    try {
      const res = await fetch('/api/admin/contact-recovery', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        // The run must cover exactly the range on screen — not the whole book.
        body: JSON.stringify({ dryRun, limit: 25, effFrom, effTo }),
      });
      const j = await res.json();
      if (!j.success) throw new Error(j.error || 'Recovery failed');
      if (dryRun) {
        setRecovery({
          busy: false,
          preview: j.candidates,
          msg: `${j.candidates} lead${j.candidates === 1 ? '' : 's'} in ${scopeLabel} are still unreachable and were downgraded for it`
            + `${j.stillNoDob ? `, and ${j.stillNoDob} of the next ${Math.min(j.candidates, 25)} also have no DOB, which BatchData cannot supply` : ''}.`,
        });
      } else {
        setRecovery({
          busy: false,
          preview: null,
          msg: `Ran on ${j.attempted}: ${j.matched} matched, ${j.recoveredEmail} gained an email, `
            + `${j.recoveredPhone} gained a phone, ${j.regraded} re-graded, `
            + `${j.needsReview} still under a manual grade and needing review`
            + (j.errors?.length ? ` · stopped early: ${j.errors[0].error}` : ''),
        });
        await run();
      }
    } catch (e) {
      setRecovery({ busy: false, preview: null, msg: e instanceof Error ? e.message : 'Recovery failed' });
    }
  }, [run, effFrom, effTo, scopeLabel]);

  // Auto-run on report switch (except keyword, which waits for a term).
  useEffect(() => {
    setCovFilter('all'); // reset the coverage drill-down on report change
    setCohortFilter({});
    setReachFilter('all'); // reset the reachability drill-down on report change
    setCallFilter('all'); setQuoteFilter('all'); setOutcomeGrade('all');
    // Renewal Week without a range means the entire book — nearly 10,000 rows over the
    // wire for a report whose whole point is one week. It waits for dates, the same way
    // keyword waits for a term.
    if (report === 'keyword' || (report === 'cohort' && !effFrom && !effTo)) {
      setRows([]); setRowsReport(null); setRan(false); return;
    }
    run();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [report]);

  /**
   * Export exactly what is on screen.
   *
   * Columns come from columnsFor(report) — the same definition the table renders — so the
   * file cannot have a different shape from the page. Rows come from `shownRows`, which is
   * the filtered set, so whatever drill-down chip is active is what lands in the file.
   *
   * The table caps rendering at MAX_RENDERED for speed; the CSV deliberately writes every
   * matching row, which is the one place the two differ and the only sane way round.
   */
  const exportCsv = () => {
    const esc = (v: string) => {
      let s = String(v ?? '');
      // A cell starting with = + - @ is executed as a formula by Excel and Sheets when
      // the file is opened. These rows carry producer-typed notes, so that is a real
      // risk rather than a theoretical one. Prefixing an apostrophe neutralises it.
      if (/^[=+\-@]/.test(s)) s = `'${s}`;
      return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
    };

    /**
     * The ledger is one row per WEEK, not per lead, so it has its own column list and
     * never populates `rows`. Handled as a branch rather than by inventing a QcRow per
     * cohort — which is the same reason it has its own endpoint and its own table.
     */
    /**
     * Each report that draws its own table exports THAT table.
     *
     * The generic branch writes `shownRows`, which only exists for the reports that use
     * the generic table. For the other two it is a different population entirely — and on
     * Blast Skip Traces it is not even rendered, so the file silently described leads
     * nobody was looking at. That is what produced a one-row export while the pipeline
     * table on screen showed a different number: with a single week still in the date
     * boxes the blast-run list genuinely held one lead, and that is what got written.
     */
    const isLedger = report === 'cohort_ledger';
    const isPipeline = report === 'blast_skiptrace';
    const lines = isLedger
      ? [
        LEDGER_COLUMNS.map((c) => esc(c.header)).join(','),
        ...ledger.map((d) => LEDGER_COLUMNS.map((c) => esc(c.value(d))).join(',')),
      ]
      : isPipeline
        ? [
          PIPELINE_COLUMNS.map((c) => esc(c.header)).join(','),
          // Workable first, then the trust-owned panel, so the file reads in the same
          // order as the screen. Both are written: they are one stage, shown apart.
          ...[...pipelineWorkable, ...pipelineEntities]
            .map((r) => PIPELINE_COLUMNS.map((c) => esc(c.value(r))).join(',')),
        ]
        : [
          tableColumns.map((c) => esc(c.header)).join(','),
          ...shownRows.map((r) => tableColumns.map((c) => esc(c.value(r))).join(',')),
        ];

    // CRLF and a UTF-8 BOM, both for Excel. Without the BOM it reads the file as ANSI and
    // the em dashes and middot separators in Detail come out as mojibake — the export
    // then visibly does NOT match the screen, which is the whole point of this function.
    const blob = new Blob([`﻿${lines.join('\r\n')}`], { type: 'text/csv;charset=utf-8;' });

    // Name says which report, and whether it is filtered — so a narrowed export is never
    // mistaken later for the full set.
    // A drill-down chip narrows the per-lead reports; the ledger has no chips, so it is
    // never "filtered" and must not be labelled as though it might be.
    // Only the generic reports have a drill-down chip that narrows the set. The other
    // two export their table whole, so labelling their file '_filtered' would be a lie.
    const filtered = !isLedger && !isPipeline && shownRows.length !== rows.length ? '_filtered' : '';
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    // Named for the SELECTED report and, for the pipeline, the stage on screen — so a
    // file of BatchData-stage leads cannot be mistaken later for the whole pipeline.
    const what = isPipeline ? `blast_skiptrace_${pipeline.stage}` : (rowsReport ?? report);
    a.download = `BIA_QC_${what}${filtered}_${new Date().toISOString().slice(0, 10)}.csv`;
    a.click();
    URL.revokeObjectURL(a.href);
  };

  /**
   * Trace a queue, one bounded chunk at a time.
   *
   * Chunked because the route is: one Tracerfy call per lead plus a courtesy gap runs past
   * every serverless limit in a single request, and a timeout there spends credits nobody
   * can account for. Each chunk commits, so a closed laptop resumes rather than re-charges.
   *
   * The estimate is fetched first and shown before anything is spent. A blast that starts
   * on click is a blast somebody runs by accident.
   */
  const runQueue = async (grade: 'A' | 'B') => {
    setQueueRun({ grade, done: 0, total: 0, hits: 0, credits: 0, busy: true, error: null });
    try {
      const est = await fetch(`/api/admin/skiptrace-blast?queue=${grade}`).then((r) => r.json());
      if (!est.success) throw new Error(est.error || 'Could not estimate the run');
      const total: number = est.eligible ?? 0;
      setQueueRun((s) => (s ? { ...s, total } : s));
      if (!total) { setQueueRun((s) => (s ? { ...s, busy: false } : s)); void loadQueues(); return; }

      let done = 0, hits = 0, credits = 0;
      // Bounded: the queue shrinks as leads gain a trace stamp, so this terminates even if
      // a chunk returns nothing. Without the ceiling a vendor returning zero forever would
      // spin here.
      for (let guard = 0; guard < 2000 && done < total; guard++) {
        const res = await fetch(`/api/admin/skiptrace-blast?queue=${grade}&chunk=5`, { method: 'POST' });
        const json = await res.json();
        if (!json.success) throw new Error(json.error || 'The run stopped');
        /**
         * The blast returns { processed, hit, miss, creditsSpent } — not traced/hits/credits.
         *
         * Reading the wrong names failed silently, because `?? 0` turns an absent field into
         * a plausible number: the first real run reported "traced 1 · 0 matched · 0 credits"
         * while Tracerfy had matched the lead and charged for it. A run summary that
         * understates spend is worse than no summary.
         */
        const n = json.processed ?? 0;
        if (!n) break;
        done += n;
        hits += json.hit ?? 0;
        credits += json.creditsSpent ?? 0;
        setQueueRun((s) => (s ? { ...s, done, hits, credits } : s));
      }
      setQueueRun((s) => (s ? { ...s, busy: false } : s));
      void loadQueues();
      // Refresh the report so the traced rows move from waiting to their result.
      void run();
    } catch (e) {
      setQueueRun((s) => (s ? { ...s, busy: false, error: e instanceof Error ? e.message : 'The run stopped' } : s));
      void loadQueues();
    }
  };

  /**
   * Falls back rather than asserting.
   *
   * This was `REPORTS.find(...)!`, which tells the compiler the lookup cannot fail while
   * leaving it free to fail at runtime — and it did the moment Cohort Ledger moved to its
   * own screen: the selection is sticky, so anyone whose last visit left it on that report
   * came back to an undefined `active` and a blank page. The same shape took this screen
   * down once before over a renamed column.
   */
  const active = REPORTS.find((r) => r.key === report) ?? REPORTS[0];
  useEffect(() => {
    if (!REPORTS.some((r) => r.key === report)) setReport(REPORTS[0].key);
  }, [report, setReport]);

  /**
   * The columns for whichever report is selected. Rebuilt only when the report changes,
   * and shared by the table and Export CSV so the file always matches the page.
   *
   * Keyed off `rowsReport`, not `report`: switching tabs leaves the previous report's
   * rows on screen until the new fetch lands, and drawing the NEW report's columns over
   * the OLD report's rows would show empty cells for a moment and — worse — export them
   * that way if someone clicked during the fetch.
   */
  const tableColumns = useMemo(
    // rows, because the address columns are counted from the widest row on screen.
    () => columnsFor(rowsReport ?? report, rows),
    [rowsReport, report, rows],
  );
  // Keyed off the SELECTED report, not the one last run, so switching to the ledger hides
  // the generic table immediately rather than leaving the previous report's rows on screen.
  const rendersOwnTable = REPORTS_WITH_OWN_TABLE.includes(report);

  // Contact-coverage tallies (Frank's breakdown) — computed from the returned rows.
  /**
   * Renewal-week tallies. Counted from the rows rather than fetched separately, so the
   * summary can never disagree with the table underneath it — the two are the same data.
   * manualGrade wins over grade because an override is the grade a producer stands behind.
   */
  const cohort = report === 'cohort' && rowsReport === report && rows.length ? (() => {
    const grades: Record<string, number> = {};
    const statuses: Record<string, number> = {};
    // Split by person. The insured is who campaigns actually mail; the co-insured is
    // reach we hold but do not use, and rolling the two together hid that.
    let traced = 0, insuredEmail = 0, coInsuredEmail = 0, insuredPhone = 0, coInsuredPhone = 0;
    // contactability (Sec. 4.1) — the same population split by how it can be reached.
    let chEmail = 0, chPhone = 0, chMail = 0, chHouseholdOnly = 0;
    for (const r of rows) {
      const g = r.manualGrade || r.grade || 'ungraded';
      grades[g] = (grades[g] ?? 0) + 1;
      const s = r.reason || '(none)';
      statuses[s] = (statuses[s] ?? 0) + 1;
      if (r.matched) traced++;
      if (r.hasInsuredEmail) insuredEmail++;
      if (r.hasCoInsuredEmail) coInsuredEmail++;
      if (r.hasInsuredPhone) insuredPhone++;
      if (r.hasCoInsuredPhone) coInsuredPhone++;
      switch (r.contactability) {
        case 'email_and_phone': case 'email_only': chEmail++; break;
        case 'phone_only': chPhone++; break;
        case 'none':
          // Nothing for the insured. Where the HOUSEHOLD still has something, the lead
          // belongs to the call queue rather than the post — counting them together is
          // what put people with no number into a calling list.
          if (r.directMailOnly) chMail++; else chHouseholdOnly++;
          break;
        default: break;
      }
    }
    return { total: rows.length, grades, statuses, traced, insuredEmail, coInsuredEmail, insuredPhone, coInsuredPhone,
      chEmail, chPhone, chMail, chHouseholdOnly };
  })() : null;

  /**
   * Reachability per renewal week.
   *
   * Computed from the same rows the table shows, so the summary can never disagree with
   * what is underneath it. "Co-insured only" is the number that matters: those households
   * are unreachable today purely because of the insured-only rule.
   */
  const reach = report === 'reachability' && rowsReport === report && rows.length ? (() => {
    const byCohort = new Map<string, { cohort: string; label: string; total: number; insured: number; coOnly: number }>();
    for (const r of rows) {
      const key = r.cohort ?? 'untagged';
      const cur = byCohort.get(key) ?? { cohort: key, label: r.reason ?? '—', total: 0, insured: 0, coOnly: 0 };
      cur.total++;
      if ((r.insuredEmailCount ?? 0) > 0) cur.insured++;
      else if (r.coInsuredOnly) cur.coOnly++;
      byCohort.set(key, cur);
    }
    const weeks = [...byCohort.values()].sort((a, b) => (a.cohort < b.cohort ? -1 : 1));
    const t = weeks.reduce((a, w) => ({
      total: a.total + w.total, insured: a.insured + w.insured, coOnly: a.coOnly + w.coOnly,
    }), { total: 0, insured: 0, coOnly: 0 });
    return { weeks, ...t };
  })() : null;

  /**
   * Counts for the Calls & Outcomes chips.
   *
   * Every count is of the WHOLE report, not of the currently filtered set — otherwise
   * picking a chip rewrites the numbers on all the other chips and there is no way back
   * to a true denominator. The counts stay put; only the table narrows.
   */
  const outcomeTally = report === 'call_outcome' && rowsReport === report && rows.length ? (() => {
    const call: Record<string, number> = {};
    const quote: Record<string, number> = {};
    const grade: Record<string, number> = {};

    /**
     * Grade narrows the call and quote counts; they do not narrow each other.
     *
     * Grade is the coarser cut and the one picked first — "of my Grade A leads, how many
     * have been called" is the question, and answering it with counts for the whole book
     * would be answering a different one. Call and quote stay at full width against that
     * grade, so choosing one still leaves a true denominator for the other; otherwise
     * every chip rewrites every other chip and there is no way back.
     */
    const inGrade = outcomeGrade === 'all'
      ? rows
      : rows.filter((r) => String(r.manualGrade || r.grade || 'ungraded') === outcomeGrade);

    // Grade counts are always of the whole report — they are what you choose BETWEEN.
    for (const r of rows) {
      const g = String(r.manualGrade || r.grade || 'ungraded');
      grade[g] = (grade[g] ?? 0) + 1;
    }
    for (const r of inGrade) {
      if (r.callStatus) call[r.callStatus] = (call[r.callStatus] ?? 0) + 1;
      if (r.callLastOutcome) call[r.callLastOutcome] = (call[r.callLastOutcome] ?? 0) + 1;
      if (r.quoteStage) quote[r.quoteStage] = (quote[r.quoteStage] ?? 0) + 1;
    }
    /**
     * The gap worth naming: reached, asked for a quote, and never quoted.
     *
     * It is the one state in this report that is nobody's queue — the call is done, so it
     * leaves the call list, and there is no quote, so it never enters the quote list.
     */
    const askedNotQuoted = inGrade.filter(
      (r) => r.callLastOutcome === 'quote_requested'
        && (r.quoteStage === 'not_rated' || r.quoteStage === 'rated'),
    ).length;
    const quotedNoOutcome = inGrade.filter((r) => r.quoteStage === 'quoted').length;
    return { total: rows.length, inGrade: inGrade.length, call, quote, grade, askedNotQuoted, quotedNoOutcome };
  })() : null;

  const coverage = report === 'contact_coverage' && rowsReport === report && rows.length ? (() => {
    const t = {
      total: rows.length, sfh: 0, condo: 0,
      both: 0, phoneOnly: 0, emailOnly: 0, neither: 0, noEmail: 0, hasDob: 0,
    };
    for (const r of rows) {
      if (r.isCondo) t.condo++; else t.sfh++;
      if (r.hasPhone && r.hasEmail) t.both++;
      else if (r.hasPhone) t.phoneOnly++;
      else if (r.hasEmail) t.emailOnly++;
      else t.neither++;
      if (!r.hasEmail) t.noEmail++;
      if (r.hasDob) t.hasDob++;
    }
    return t;
  })() : null;

  // Blast runs — one row per run, newest first. Match counts only: what the run
  // recovered is a QC question, what it cost is not (Frank Sep-2026).
  const blastRuns = report === 'blast_skiptrace' && rowsReport === report && rows.length ? (() => {
    const byRun = new Map<string, { runId: string; when: string; by: string; leads: number; hits: number; phone: number; email: number }>();
    for (const r of rows) {
      const key = r.runId ?? 'unknown';
      const cur = byRun.get(key) ?? { runId: key, when: r.at ?? '—', by: r.by ?? '—', leads: 0, hits: 0, phone: 0, email: 0 };
      cur.leads++;
      if (r.matched) cur.hits++;
      if (r.hasPhone) cur.phone++;
      if (r.hasEmail) cur.email++;
      // Rows arrive newest-first, so the last one seen is the run's earliest stamp.
      if (r.at && r.at < cur.when) cur.when = r.at;
      byRun.set(key, cur);
    }
    return [...byRun.values()].sort((a, b) => (a.when < b.when ? 1 : -1));
  })() : null;

  // Rows actually shown in the table + exported: coverage drill-down filter applied.
/**
 * Rows rendered at once. A renewal-week cohort is ~1,500 leads and rendering every one
 * as a MUI TableRow locks the page for seconds — the summary above already carries the
 * totals, and Export CSV still writes the COMPLETE set, so the table only has to be
 * enough to eyeball.
 */
const MAX_RENDERED = 300;

  const shownRows = useMemo(() => {
    if (report === 'cohort') {
      const { grade, status, trait } = cohortFilter;
      if (!grade && !status && !trait) return rows;
      const traitOf = (r: QcRow) => ({
        traced: !!r.matched,
        insuredEmail: !!r.hasInsuredEmail,
        coInsuredEmail: !!r.hasCoInsuredEmail,
        insuredPhone: !!r.hasInsuredPhone,
        coInsuredPhone: !!r.hasCoInsuredPhone,
        // The gap, not the coverage. Everything else here counts what we CAN reach;
        // this is the work list — who is eligible to be mailed and has no address to
        // mail. It is the number the re-trace decision is made on.
        noInsuredEmail: !r.hasInsuredEmail,
        /**
         * Already deep traced and STILL has no insured address.
         *
         * Re-running the same tool on these returns the same nothing. They are the only
         * leads a second provider could add anything to, and separating them is what
         * stops the next blast paying to re-trace leads that were never traced at all.
         */
        tracedStillNoEmail: !!r.matched && !r.hasInsuredEmail,
        /**
         * The channel segments (Sec. 4.1 / 4.2), each retrievable by name.
         *
         * directMail is the one the directive asks for explicitly (task 28): nothing
         * anywhere on the card, so the post is the only way left. Flagged, never
         * regraded — a lead with no email is not a worse prospect, it is a prospect on
         * a different channel.
         */
        chEmail: r.contactability === 'email_and_phone' || r.contactability === 'email_only',
        chPhone: r.contactability === 'phone_only',
        directMail: !!r.directMailOnly,
        // Nothing for the insured, but the household can still be reached. These are the
        // leads that make Grade A look like a working email list when it is not.
        householdOnly: r.contactability === 'none' && !r.directMailOnly,
      } as Record<string, boolean>);
      return rows.filter((r) => {
        if (grade && (r.manualGrade || r.grade || 'ungraded') !== grade) return false;
        if (status && (r.reason || '(none)') !== status) return false;
        if (trait && !traitOf(r)[trait]) return false;
        return true;
      });
    }
    if (report === 'grade_overrides') {
      return changeFilter ? rows.filter((r) => (r.changeCategory ?? 'other') === changeFilter) : rows;
    }
    if (report === 'call_outcome') {
      if (callFilter === 'all' && quoteFilter === 'all' && outcomeGrade === 'all') return rows;
      return rows.filter((r) => {
        // The grade as the card shows it: a producer's override wins over the rules.
        const g = String(r.manualGrade || r.grade || 'ungraded');
        if (outcomeGrade !== 'all' && g !== outcomeGrade) return false;
        // The call side matches either a status or a specific last outcome, so one chip
        // row can offer both without the user having to know which is which.
        const callOk = callFilter === 'all'
          || r.callStatus === callFilter
          || r.callLastOutcome === callFilter;
        const quoteOk = quoteFilter === 'all' || r.quoteStage === quoteFilter;
        return callOk && quoteOk;
      });
    }
    if (report === 'reachability') {
      if (reachFilter === 'all') return rows;
      return rows.filter((r) => {
        const ins = (r.insuredEmailCount ?? 0) > 0;
        if (reachFilter === 'insured') return ins;
        if (reachFilter === 'coOnly') return !ins && !!r.coInsuredOnly;
        return !ins && !r.coInsuredOnly;
      });
    }
    if (report !== 'contact_coverage' || covFilter === 'all') return rows;
    return rows.filter((r) => {
      switch (covFilter) {
        case 'sfh': return !r.isCondo;
        case 'condo': return !!r.isCondo;
        case 'both': return !!r.hasPhone && !!r.hasEmail;
        case 'phoneOnly': return !!r.hasPhone && !r.hasEmail;
        case 'emailOnly': return !r.hasPhone && !!r.hasEmail;
        case 'neither': return !r.hasPhone && !r.hasEmail;
        case 'noEmail': return !r.hasEmail;
        case 'hasDob': return !!r.hasDob;
        default: return true;
      }
    });
  }, [rows, report, covFilter, cohortFilter, reachFilter, changeFilter, callFilter, quoteFilter, outcomeGrade]);

  return (
    <Container maxWidth="xl" sx={{ py: 4 }}>
      <Box sx={{ mb: 3 }}>
        <Typography variant="h4" sx={{ fontWeight: 'bold', mb: 0.5 }}>QC / Data Validation</Typography>
        <Typography variant="body1" color="text.secondary">
          Pull producer notes, variance notes, eligibility &amp; grade overrides back out — spot trends without leaving the CRM.
        </Typography>
      </Box>

      {(() => {
        const grouped = new Set(REPORT_GROUPS.flatMap((g) => g.keys));
        const ungrouped = REPORTS.filter((r) => !grouped.has(r.key));
        const groups = ungrouped.length
          ? [...REPORT_GROUPS, { label: 'Other', keys: ungrouped.map((r) => r.key) }]
          : REPORT_GROUPS;
        return (
          <Box sx={{ mb: 2.5, display: 'flex', flexWrap: 'wrap', gap: { xs: 2, md: 3 }, rowGap: 2 }}>
            {groups.map((g) => (
              <Box key={g.label}>
                <Typography
                  sx={{
                    fontSize: 10, fontWeight: 700, letterSpacing: '.09em',
                    textTransform: 'uppercase', color: '#8a93a3', mb: 0.75,
                  }}
                >
                  {g.label}
                </Typography>
                <Stack direction="row" spacing={0.75} useFlexGap sx={{ flexWrap: 'wrap' }}>
                  {g.keys.map((k) => {
                    const r = REPORTS.find((x) => x.key === k);
                    if (!r) return null;
                    const on = report === r.key;
                    return (
                      <Button
                        key={r.key}
                        onClick={() => setReport(r.key)}
                        size="small"
                        startIcon={r.icon}
                        disableElevation
                        sx={{
                          textTransform: 'none',
                          fontSize: 12.5,
                          fontWeight: on ? 700 : 500,
                          px: 1.25, py: 0.5,
                          borderRadius: 1.5,
                          whiteSpace: 'nowrap',
                          border: '1px solid',
                          // The selected report is the one thing on this row that must be
                          // unmistakable; everything else recedes.
                          bgcolor: on ? '#1f5f8b' : '#fff',
                          color: on ? '#fff' : '#3d4658',
                          borderColor: on ? '#1f5f8b' : '#dfe3e8',
                          '& .MuiButton-startIcon': { mr: 0.6, '& svg': { fontSize: 17 } },
                          '&:hover': {
                            bgcolor: on ? '#18506f' : '#f2f6fa',
                            borderColor: on ? '#18506f' : '#c4cdd8',
                          },
                        }}
                      >
                        {r.label}
                      </Button>
                    );
                  })}
                </Stack>
              </Box>
            ))}
          </Box>
        );
      })()}

      <Paper variant="outlined" sx={{ p: 2, mb: 2 }}>
        <Typography variant="caption" color="text.secondary" sx={{ display: 'block', mb: 1.5 }}>{active.blurb}</Typography>
        <Stack direction={{ xs: 'column', md: 'row' }} spacing={1.5} sx={{ alignItems: { md: 'center' }, flexWrap: 'wrap' }}>
                    {report === 'referral' && (
            <>
              <FormControl size="small" sx={{ minWidth: 150 }}>
                <InputLabel>Carrier</InputLabel>
                <Select label="Carrier" value={carrier} onChange={(e) => setCarrier(e.target.value as any)}>
                  <MenuItem value="any">Either carrier</MenuItem>
                  <MenuItem value="travelers">Travelers</MenuItem>
                  <MenuItem value="plymouth">Plymouth Rock</MenuItem>
                </Select>
              </FormControl>
              <FormControl size="small" sx={{ minWidth: 150 }}>
                <InputLabel>Status</InputLabel>
                <Select label="Status" value={value} onChange={(e) => setValue(e.target.value as any)}>
                  <MenuItem value="review">Referral</MenuItem>
                  <MenuItem value="ineligible">Non-eligible</MenuItem>
                  <MenuItem value="eligible">Eligible</MenuItem>
                </Select>
              </FormControl>
              <FormControl size="small" sx={{ minWidth: 190 }}>
                <InputLabel>Set by</InputLabel>
                <Select label="Set by" value={setBy} onChange={(e) => setSetBy(e.target.value as any)}>
                  <MenuItem value="any">Anyone</MenuItem>
                  <MenuItem value="producer">Producer-reviewed</MenuItem>
                  <MenuItem value="system">System-flagged</MenuItem>
                </Select>
              </FormControl>
            </>
          )}
          {report === 'keyword' && (
            <TextField
              size="small" label="Keyword" value={q} placeholder='e.g. "Howell", "referral", "Travelers declined"'
              onChange={(e) => setQ(e.target.value)} onKeyDown={(e) => { if (e.key === 'Enter') run(); }}
              sx={{ minWidth: 320 }}
            />
          )}
          {(report === 'emails_insured' || report === 'emails_all') && (
            <>
              {/*
                ── Which grade this file is for ──────────────────────────────
                A toggle rather than a "grade" column, because these two lists are exported
                and handed to a sending tool. Grade A carries a band price and two CTA arms;
                Grade B has no band price at all and a single arm. A file holding both means
                one of the two populations receives copy written for the other, and nothing
                about the file would look wrong.

                Frank, 28 Sep: "Email outreach may be more important on these accounts than
                Grade As since we don't have a band price."
              */}
              <ToggleButtonGroup
                size="small"
                exclusive
                value={listGrade}
                onChange={(_, v) => { if (v) setListGrade(v); }}
                sx={{ '& .MuiToggleButton-root': { px: 1.75, textTransform: 'none', fontWeight: 600 } }}
              >
                <ToggleButton value="A">Grade A</ToggleButton>
                <ToggleButton value="B">Grade B</ToggleButton>
              </ToggleButtonGroup>
              <Typography variant="caption" sx={{ color: '#5a6675', alignSelf: 'center', maxWidth: 300 }}>
                {listGrade === 'A'
                  ? 'Wave one — rated accounts with a band price.'
                  : 'Wave two — no band price, single CTA arm. Run the skip trace blast on these first so there are addresses to export.'}
              </Typography>
            </>
          )}
          {report === 'roof_b' && (
            <>
              {/*
                Labelled "home age", not "roof year". Naming it after the roof would invite
                a range nobody can filter on: the roof year is NULL on every row here, so
                any roof-year band returns an empty report.
              */}
              {/*
                Labelled "years old", and the build years it works out to are shown beside
                the boxes as you type.

                It said "Home age from (yrs)", which reads as a year — 2001 was typed into
                it, meaning houses built in 2001. That asks for houses two thousand years
                old, correctly returns nothing, and looks like a broken filter rather than a
                misread label. Showing "built 1951–2006" alongside makes the unit impossible
                to mistake, because a build year is what the reader is thinking in.
              */}
              <TextField
                size="small" type="number" label="Home age from" value={ageMin}
                onChange={(e) => setAgeMin(e.target.value)}
                onKeyDown={(e) => { if (e.key === 'Enter') run(); }}
                sx={{ width: 140 }}
                slotProps={{ htmlInput: { min: 0, max: 200 }, inputLabel: { shrink: true } }}
                helperText="years old"
              />
              <TextField
                size="small" type="number" label="to" value={ageMax}
                onChange={(e) => setAgeMax(e.target.value)}
                onKeyDown={(e) => { if (e.key === 'Enter') run(); }}
                sx={{ width: 110 }}
                slotProps={{ htmlInput: { min: 0, max: 200 }, inputLabel: { shrink: true } }}
                helperText="years old"
              />
              {(() => {
                const thisYear = new Date().getFullYear();
                const lo = Number(ageMin); const hi = Number(ageMax);
                const ok = Number.isFinite(lo) && Number.isFinite(hi) && lo >= 0 && hi >= lo && hi <= 200;
                return (
                  <Typography variant="caption" sx={{ color: ok ? '#5a6675' : '#b3261e', alignSelf: 'center', maxWidth: 220 }}>
                    {ok
                      ? `= built ${thisYear - hi} to ${thisYear - lo}`
                      : 'That is an age in years, not a build year — Frank\'s band is homes 21 to 76 years old.'}
                  </Typography>
                );
              })()}
            </>
          )}
          <TextField size="small" type="date" label="Eff from" value={effFrom} onChange={(e) => setEffFrom(e.target.value)} slotProps={{ inputLabel: { shrink: true } }} />
          <TextField size="small" type="date" label="Eff to" value={effTo} onChange={(e) => setEffTo(e.target.value)} slotProps={{ inputLabel: { shrink: true } }} />
          <Button variant="contained" size="small" startIcon={<SearchIcon />} onClick={run} disabled={loading || (report === 'keyword' && !q.trim())}>Run</Button>
          <Box sx={{ flex: 1 }} />
          {/*
            The ledger keeps its rows in `ledger`, not `rows`, so gating purely on
            shownRows left Export CSV permanently greyed out on the one report anybody
            actually needed to send anywhere.
          */}
          {/*
            Offered on the Grade-B roof report, which is the pull Frank asked for. It queues
            what is ON SCREEN, so the filter boxes above are the selection — there is no
            second place to choose a population and therefore no way for the two to disagree.
          */}
          {report === 'roof_b' && (
            <Button
              variant="contained" size="small" color="warning"
              startIcon={queueing ? <CircularProgress size={14} color="inherit" /> : <BoltIcon />}
              onClick={() => queueForBlast('B')}
              disabled={queueing || !shownRows.length}
              sx={{ mr: 1 }}
            >
              {queueing ? 'Queuing…' : `Move ${shownRows.length} to Grade B skip-trace blast`}
            </Button>
          )}
          <Button
            variant="outlined" size="small" startIcon={<DownloadIcon />} onClick={exportCsv}
            disabled={
              report === 'cohort_ledger' ? !ledger.length
                : report === 'blast_skiptrace' ? !pipeline.rows.length
                  : !shownRows.length
            }
          >
            Export CSV
          </Button>
        </Stack>
      </Paper>

      {error && <Alert severity="error" sx={{ mb: 2 }}>{error}</Alert>}

      {report === 'cohort_ledger' && rowsReport === 'cohort_ledger' && (
        <Paper variant="outlined" sx={{ mb: 2, ...scrollableTable }}>
          {/* Report rows run to twenty-odd columns. The lead stays pinned so a row keeps
              its identity while the columns scroll past it. */}
          <Table size="small" stickyHeader sx={stickyFirstColumn}>
            <TableHead>
              <TableRow>
                {/*
                  Two different recoveries, named apart.

                  One column called "Recovered" read as "what the skip trace bought" and
                  answered with a grade round trip: it said 1 for the Oct 5 week while the
                  pipeline had found insured emails for 11 leads in that same week. Both
                  numbers were right and neither was the one being asked for. A lead that
                  is Grade A and unmailable never left Grade A, so finding it an address
                  moves Mailable and leaves the grade columns alone.
                */}
                {/*
                  The three channels, side by side (Sec. 4.2).

                  Grade A was being read as an email list and it is not one — it is a
                  mixed bag, and until there was a report to tell the three types apart
                  nobody could see it. Mailable / Call queue / Direct mail are the same
                  Grade A population split by how it can actually be reached, so the row
                  says what can be done with the week rather than only how big it is.
                */}
                {LEDGER_COLUMNS.map((c) => (
                  <TableCell key={c.header} align={c.numeric ? 'right' : 'left'}
                    sx={{ fontWeight: 700, fontSize: 12, whiteSpace: 'nowrap' }}>{c.header}</TableCell>
                ))}
              </TableRow>
            </TableHead>
            <TableBody>
              {/*
                One row, rendered from LEDGER_COLUMNS — the same list the CSV writes.
                Each column's tooltip and its own conditional formatting live in its
                `cell`; what is left here is the formatting that depends on the ROW.
              */}
              {ledger.map((d) => {
                const over = d.lostPct != null && d.lostPct > LOST_TARGET_PCT;
                const emphasis: Record<string, boolean> = {
                  'Renewal week': true,
                  'Grade A at pull': true,
                  'Grade A now': true,
                  Mailable: true,
                  'Lost %': true,
                  'Workable lost %': true,
                  'Regained A': !!d.recovered,
                  'Email found': !!d.emailRecovered,
                  'Unworked A': !!d.unworkedGradeA,
                };
                const colour: Record<string, string> = {
                  Downgraded: d.downgraded ? '#b3261e' : 'inherit',
                  'Regained A': d.recovered ? '#166534' : 'inherit',
                  'Email found': d.emailRecovered ? '#166534' : 'inherit',
                  Mailable: d.aNow && d.mailable / d.aNow < 0.8 ? '#8a5a00' : '#166534',
                  'Call queue': d.phoneOnly ? '#8a5a00' : 'inherit',
                  'Direct mail': d.directMailOnly ? '#b3261e' : 'inherit',
                  'No insured contact': d.noInsuredContact ? '#8a5a00' : 'inherit',
                  'Unworked A': d.unworkedGradeA ? '#8a5a00' : 'inherit',
                  // The only colour set by a target rather than by being non-zero.
                  'Lost %': over ? '#b3261e' : '#166534',
                  'Workable lost %': d.workableLostPct != null && d.workableLostPct > LOST_TARGET_PCT ? '#b3261e' : '#166534',
                  'Lost: no contact': d.downgradedUncontactable ? '#8a5a00' : 'inherit',
                };
                return (
                  <TableRow key={d.cohort} hover>
                    {LEDGER_COLUMNS.map((c) => (
                      <TableCell
                        key={c.header}
                        align={c.numeric ? 'right' : 'left'}
                        sx={{
                          fontSize: 12,
                          whiteSpace: c.header === 'Renewal week' ? 'nowrap' : undefined,
                          fontWeight: emphasis[c.header] ? 700 : 400,
                          color: colour[c.header] ?? 'inherit',
                        }}
                      >
                        {c.cell ? c.cell(d) : (c.value(d) || '—')}
                      </TableCell>
                    ))}
                  </TableRow>
                );
              })}
            </TableBody>
          </Table>
          <Box sx={{ p: 1.5, borderTop: '1px solid #e6e8eb' }}>
            <Typography variant="caption" color="text.secondary" sx={{ display: 'block' }}>
              Grade A at pull → downgraded → low point → regained Grade A → Grade A now →
              <b> mailable</b> (of those, how many have an insured email).
              Target is a loss of {LOST_TARGET_PCT}% or less. <b>↑</b> marks leads that were not Grade A at
              pull and are now.
            </Typography>
            {/*
              Frank names a window inclusively — "10/26 to 11/02" — which is eight days and
              ends on the NEXT week's Monday. Renewal Week honours that literally; this tab
              counts whole weeks. Both are right and they do not match, so the difference is
              stated here rather than left to be discovered by comparing two screens.
            */}
            <Typography variant="caption" color="text.secondary" sx={{ display: 'block', mt: 0.5 }}>
              Rows are whole renewal weeks (Monday–Sunday). A date range is widened to the
              weeks it touches, so these totals will not match a Renewal Week range that
              starts or ends mid-week — that tab counts the exact dates you type.
            </Typography>
            {/*
              Named, not just counted. A number in a column says a week has a problem; the
              county says where to look, and that is the difference between "19 leads were
              missed" and "the Middlesex leads were never surfaced to anyone".
            */}
            {ledger.some((d) => d.rated > 0 && d.unworkedTopCounty) && (
              <Typography variant="caption" sx={{ color: '#8a5a00', display: 'block', mt: 0.5 }}>
                Unworked Grade A concentrated in one county:{' '}
                {ledger
                  .filter((d) => d.rated > 0 && d.unworkedTopCounty)
                  .map((d) => `${d.label} — ${d.unworkedTopCountyShare}% in ${d.unworkedTopCounty}`)
                  .join('; ')}
                . These weeks have been worked, so those leads were available and never put in front of a producer.
              </Typography>
            )}
            {ledger.some((d) => d.noPullRecord || d.unexplained) && (
              <Typography variant="caption" sx={{ color: '#8a5a00', display: 'block', mt: 0.5 }}>
                Measurement gaps:{' '}
                {ledger.filter((d) => d.noPullRecord).map((d) => `${d.label} — ${d.noPullRecord} leads with no recorded starting grade`).join('; ')}
                {ledger.some((d) => d.noPullRecord) && ledger.some((d) => d.unexplained) ? '; ' : ''}
                {ledger.filter((d) => d.unexplained).map((d) => `${d.label} — ${d.unexplained} left Grade A with no logged reason`).join('; ')}
              </Typography>
            )}
          </Box>
        </Paper>
      )}

      {report === 'grade_overrides' && rowsReport === 'grade_overrides' && rows.length > 0 && (() => {
        const counts = new Map<string, number>();
        for (const r of rows) {
          const k = r.changeCategory ?? 'other';
          counts.set(k, (counts.get(k) ?? 0) + 1);
        }
        const order = [...counts.entries()].sort((a, b) => b[1] - a[1]);
        return (
          <Paper variant="outlined" sx={{ p: 2, mb: 2 }}>
            <Stack direction="row" spacing={1} useFlexGap sx={{ flexWrap: 'wrap', alignItems: 'center' }}>
              <Typography variant="subtitle2" sx={{ mr: 1 }}>Why the grade changed</Typography>
              {order.map(([key, n]) => {
                const active = changeFilter === key;
                // The recoverable bucket is coloured apart from the rest: it is the only
                // one where running a better trace changes the answer, so it is the only
                // one worth spending credits on.
                const recoverable = key === RECOVERABLE;
                return (
                  <Chip
                    key={key} size="small" clickable
                    label={`${CATEGORY_LABEL[key as GradeChangeCategory] ?? key}: ${n.toLocaleString()}`}
                    onClick={() => setChangeFilter(active ? null : key)}
                    sx={{
                      fontWeight: recoverable ? 700 : 500,
                      ...(recoverable
                        ? { bgcolor: '#1565c0', color: '#fff', '&:hover': { bgcolor: '#0d47a1' } }
                        : { variant: 'outlined' }),
                      outline: active ? '2px solid #0d47a1' : 'none',
                      outlineOffset: 1,
                    }}
                  />
                );
              })}
            </Stack>
            <Typography variant="caption" color="text.secondary" sx={{ display: 'block', mt: 1 }}>
              Only <b>{CATEGORY_LABEL[RECOVERABLE]}</b> can be reversed by re-tracing — a lead under a trust
              or outside carrier appetite stays down however good the trace is. Filter to that chip before
              batching a re-trace.
              {changeFilter && <> · showing {shownRows.length.toLocaleString()} — click the chip again to clear</>}
            </Typography>
            {/*
              These chips count CHANGES, and a lead can be re-graded more than once. The
              recovery panel below counts LEADS, so the two legitimately differ — said
              here rather than left to look like an error, which is how the 521-vs-518
              mismatch was read before anyone checked it.
            */}
            <Typography variant="caption" color="text.secondary" sx={{ display: 'block', mt: 0.5 }}>
              Counts are grade changes, not leads — a lead re-graded twice appears twice.
            </Typography>

            {/*
              The action that follows from the filter, offered where the filter is.

              Tracerfy has already run on these and returned nothing, so this calls
              BatchData directly rather than paying for a Tracerfy hit first. It is
              capped and previewed on purpose: the last mass operation run without a
              preview is still being unpicked.
            */}
            {changeFilter === RECOVERABLE && (
              <Box sx={{ mt: 1.5, pt: 1.5, borderTop: '1px solid #e6e8eb' }}>
                <Stack direction="row" spacing={1} sx={{ alignItems: 'center', flexWrap: 'wrap' }} useFlexGap>
                  <Button
                    size="small" variant="contained"
                    startIcon={recovery.busy ? <CircularProgress size={14} color="inherit" /> : <ContactPhoneIcon />}
                    onClick={() => runRecovery(true)}
                    disabled={recovery.busy}
                  >
                    {recovery.busy ? 'Working…' : 'Preview contact recovery'}
                  </Button>
                  {/*
                    The count comes from the preview, which was itself scoped to the
                    dates on screen — so the button says how many leads it will really
                    call for, not a fixed cap that may exceed the whole filtered set.
                  */}
                  {recovery.preview != null && recovery.preview > 0 && (
                    <Button
                      size="small" variant="outlined" color="warning"
                      onClick={() => runRecovery(false)}
                      disabled={recovery.busy}
                    >
                      Run on {Math.min(recovery.preview, 25)} of {recovery.preview} — costs money
                    </Button>
                  )}
                  {recovery.preview === 0 && (
                    <Typography variant="caption" sx={{ color: '#166534' }}>
                      Nothing to recover in this range.
                    </Typography>
                  )}
                </Stack>
                {recovery.msg && (
                  <Typography variant="caption" sx={{ display: 'block', mt: 1, color: '#3d4658' }}>
                    {recovery.msg}
                  </Typography>
                )}
                <Typography variant="caption" sx={{ display: 'block', mt: 0.5, color: '#8a5a00' }}>
                  BatchData returns phones and emails but <b>no date of birth</b> — a lead downgraded only
                  for a missing DOB is not fixed by this. Leads under a producer&apos;s manual grade keep it
                  and are reported for review rather than re-graded automatically.
                </Typography>
              </Box>
            )}
          </Paper>
        );
      })()}

      {cohort && (() => {
        // Every chip is a filter. Clicking the active one clears it, so there is no
        // separate "reset" to hunt for — the way out is the way in.
        const chip = (
          kind: 'grade' | 'status' | 'trait',
          value: string,
          label: string,
          sx: Record<string, unknown> = {},
        ) => {
          const active = cohortFilter[kind] === value;
          return (
            <Chip
              key={`${kind}:${value}`} size="small" label={label} clickable
              onClick={() => setCohortFilter((f) => ({ ...f, [kind]: active ? undefined : value }))}
              sx={{
                ...sx,
                cursor: 'pointer',
                outline: active ? '2px solid #1565c0' : 'none',
                outlineOffset: 1,
              }}
            />
          );
        };

        /**
         * The one combination that decides whether a cohort can be mailed this week.
         *
         * Grade A is the eligibility gate and an insured address is the delivery gate;
         * either number on its own overstates the list. Stacking the two chips gives the
         * same answer, but nobody reads a chip row as an AND — so this states it outright.
         */
        const isGradeA = (r: QcRow) => (r.manualGrade || r.grade || 'ungraded') === 'A';
        const aInsEmail = rows.filter((r) => r.hasInsuredEmail && isGradeA(r)).length;
        const aInsActive = cohortFilter.grade === 'A' && cohortFilter.trait === 'insuredEmail';

        // The other half of the same question: eligible to mail, nothing to mail to.
        const aNoEmail = rows.filter((r) => !r.hasInsuredEmail && isGradeA(r)).length;
        /**
         * How many of them are ACTUALLY isolated.
         *
         * The chip used to read "(Isolated)" for every lead it counted. Across the book
         * that is 22 leads out of 1,133 — the label was true only in the single week the
         * isolate action had been run on, and read as a statement of fact everywhere
         * else. A chip that asserts a status it has not checked is how a screen stops
         * being worth believing, so it now reports the split instead.
         */
        const aNoEmailIsolated = rows.filter(
          (r) => !r.hasInsuredEmail && isGradeA(r) && r.reason === 'isolated',
        ).length;
        /**
         * What isolating would overwrite, computed from the rows already on screen.
         *
         * This is the only thing the old two-step preview told anyone that the chip did
         * not — and it cost a round trip and an extra click to say it. Isolation is free
         * and reversible, so a preview earns nothing here; the pattern was copied from the
         * operations that spend money, where it does.
         */
        const aNoEmailByStatus = rows
          .filter((r) => !r.hasInsuredEmail && isGradeA(r) && r.reason !== 'isolated')
          .reduce<Record<string, number>>((acc, r) => {
            const k = r.reason || 'new';
            acc[k] = (acc[k] ?? 0) + 1;
            return acc;
          }, {});
        const toIsolate = Object.values(aNoEmailByStatus).reduce((t, n) => t + n, 0);
        const breakdown = Object.entries(aNoEmailByStatus)
          .sort((x, y) => y[1] - x[1])
          .map(([k, n]) => `${n} ${k}`)
          .join(' · ');

        const isolationLabel = aNoEmail === 0
          ? ''
          : aNoEmailIsolated === aNoEmail ? ' (all isolated)'
            : aNoEmailIsolated === 0 ? ' (none isolated yet)'
              : ` (${aNoEmailIsolated} isolated)`;
        const aNoEmailActive = cohortFilter.grade === 'A' && cohortFilter.trait === 'noInsuredEmail';

        return (
          <Paper variant="outlined" sx={{ p: 2, mb: 2 }}>
            <Stack direction="row" spacing={1} useFlexGap sx={{ flexWrap: 'wrap', alignItems: 'center', mb: 1.5 }}>
              <Typography variant="h6" sx={{ mr: 1 }}>{cohort.total.toLocaleString()} leads</Typography>
              {['A', 'B', 'C', 'D', 'ungraded'].filter((g) => cohort.grades[g]).map((g) => chip(
                'grade', g, `${g}: ${cohort.grades[g].toLocaleString()}`,
                {
                  fontWeight: 600,
                  ...(g === 'A' ? { bgcolor: '#dcfce7', color: '#166534' }
                    : g === 'ungraded' ? { bgcolor: '#fff3d6', color: '#8a5a00' } : {}),
                },
              ))}
            </Stack>

            <Stack direction="row" spacing={1} useFlexGap sx={{ flexWrap: 'wrap', alignItems: 'center' }}>
              {Object.entries(cohort.statuses).sort((a, b) => b[1] - a[1]).map(([s, n]) => chip(
                'status', s, `${s}: ${n.toLocaleString()}`, { variant: 'outlined' },
              ))}
            </Stack>

            <Divider sx={{ my: 1.5 }} />

            {/* The numbers that decide whether this cohort can be emailed at all. */}
            <Stack direction="row" spacing={1} useFlexGap sx={{ flexWrap: 'wrap', alignItems: 'center' }}>
              {chip('trait', 'traced', `${cohort.traced.toLocaleString()} deep skip traced — all grades`)}
              {chip('trait', 'tracedStillNoEmail',
                `${rows.filter((r) => r.matched && !r.hasInsuredEmail).length.toLocaleString()} traced but still no insured email — all grades`,
                { bgcolor: '#fff3d6', color: '#8a5a00', fontWeight: 600 })}
              {chip('trait', 'insuredEmail', `${cohort.insuredEmail.toLocaleString()} have an insured email — all grades`, {
                fontWeight: 600,
                ...(cohort.insuredEmail / cohort.total < 0.5
                  ? { bgcolor: '#fee2e2', color: '#b3261e' }
                  : { bgcolor: '#dcfce7', color: '#166534' }),
              })}
              <Chip
                size="small" clickable
                label={`${aInsEmail.toLocaleString()} have an insured email — Grade A only`}
                onClick={() => setCohortFilter((f) => (aInsActive
                  ? { ...f, grade: undefined, trait: undefined }
                  : { ...f, grade: 'A', trait: 'insuredEmail' }))}
                sx={{
                  fontWeight: 700,
                  bgcolor: '#1565c0',
                  color: '#fff',
                  '&:hover': { bgcolor: '#0d47a1' },
                  outline: aInsActive ? '2px solid #0d47a1' : 'none',
                  outlineOffset: 1,
                }}
              />
              <Chip
                size="small" clickable
                label={`${aNoEmail.toLocaleString()} missing an insured email — Grade A only${isolationLabel}`}
                onClick={() => setCohortFilter((f) => (aNoEmailActive
                  ? { ...f, grade: undefined, trait: undefined }
                  : { ...f, grade: 'A', trait: 'noInsuredEmail' }))}
                sx={{
                  fontWeight: 700,
                  bgcolor: aNoEmail ? '#b3261e' : '#e6e8eb',
                  color: aNoEmail ? '#fff' : '#3d4658',
                  '&:hover': { bgcolor: aNoEmail ? '#8c1d18' : '#d6d9dd' },
                  outline: aNoEmailActive ? '2px solid #8c1d18' : 'none',
                  outlineOffset: 1,
                }}
              />
              {chip('trait', 'coInsuredEmail', `${cohort.coInsuredEmail.toLocaleString()} have a co-insured email — all grades`, {
                ...(cohort.coInsuredEmail ? { bgcolor: '#fff3d6', color: '#8a5a00' } : {}),
              })}
              {chip('trait', 'insuredPhone', `${cohort.insuredPhone.toLocaleString()} have an insured phone — all grades`)}
              {/*
                contactability (Sec. 4.1) — the same leads, split by the channel that can
                actually work them. Grade A is a mixed bag; these three chips are what
                turns it back into three usable lists. Each is a named segment: click it
                and the table below is that list, ready to export.
              */}
              {chip('trait', 'chEmail', `Email campaign: ${cohort.chEmail.toLocaleString()}`, {
                ...(cohort.chEmail ? { bgcolor: '#e7f5ec', color: '#166534', fontWeight: 600 } : {}),
              })}
              {chip('trait', 'chPhone', `Call queue: ${cohort.chPhone.toLocaleString()}`, {
                ...(cohort.chPhone ? { bgcolor: '#fff3d6', color: '#8a5a00', fontWeight: 600 } : {}),
              })}
              {chip('trait', 'directMail', `Direct mail: ${cohort.chMail.toLocaleString()}`, {
                ...(cohort.chMail ? { bgcolor: '#fdecea', color: '#b3261e', fontWeight: 600 } : {}),
              })}
              {!!cohort.chHouseholdOnly && chip('trait', 'householdOnly',
                `No insured contact, household reachable: ${cohort.chHouseholdOnly.toLocaleString()}`, {
                  bgcolor: '#fff', color: '#8a5a00', border: '1px solid #f0c987', fontWeight: 600,
                })}
              {chip('trait', 'coInsuredPhone', `${cohort.coInsuredPhone.toLocaleString()} have a co-insured phone — all grades`, {
                ...(cohort.coInsuredPhone ? { bgcolor: '#fff3d6', color: '#8a5a00' } : {}),
              })}
              {/*
                The action the chip beside it implies.

                Isolating parks a lead as unreachable while REMEMBERING the status it had
                — most of these are already rated, and the email cadence depends on that
                distinction, so overwriting it would cost more than it tidied.
              */}
              {cohortFilter.grade === 'A' && cohortFilter.trait === 'noInsuredEmail' && toIsolate > 0 && (
                <Button
                  size="small" variant="outlined" color="warning"
                  onClick={() => {
                    // One click, one question. The breakdown is the thing worth pausing
                    // over — isolating a RATED lead changes which email copy it receives.
                    if (confirm(
                      `Isolate ${toIsolate} Grade A lead${toIsolate === 1 ? '' : 's'} with no insured email?

`
                      + `Currently: ${breakdown}.

`
                      + 'Their current status is remembered and restored automatically if an address turns up. '
                      + 'Nothing is sent and no vendor is called.',
                    )) runIsolate(false);
                  }}
                  disabled={isolateState.busy}
                  sx={{ ml: 0.5 }}
                >
                  {isolateState.busy ? 'Working…' : `Isolate ${toIsolate} (${breakdown})`}
                </Button>
              )}
              <Typography variant="caption" color="text.secondary">
                {Math.round((cohort.insuredEmail / cohort.total) * 100)}% of this cohort has an insured email address
                {' — campaigns mail the named insured only, so the co-insured counts are reach we hold but do not use.'}
              </Typography>
              {(cohortFilter.grade || cohortFilter.status || cohortFilter.trait) && (
                <Typography variant="caption" sx={{ color: '#1565c0', fontWeight: 600 }}>
                  · showing {shownRows.length.toLocaleString()} — click the chip again to clear
                </Typography>
              )}
              {isolateState.msg && (
                <Typography variant="caption" sx={{ color: '#8a5a00', display: 'block', width: '100%', mt: 0.5 }}>
                  {isolateState.msg}
                </Typography>
              )}
            </Stack>
          </Paper>
        );
      })()}

      {outcomeTally && (() => {
        /**
         * The lead card's own vocabulary, in the card's own order — the status ladder
         * first, then the eight outcomes, then the quote stages. A producer reading this
         * board and then opening a lead should meet the same words in the same sequence.
         */
        /**
         * The four that replaced "Reached" (Frank, 25 Sep 2026).
         *
         * One chip for "Reached" could not answer the question anyone actually has of this
         * filter — which of these need a callback made, which are being quoted, and which
         * asked us to stop. Those are four different piles of work and they were one.
         */
        const CALL_STATUS: Array<[string, string]> = [
          ['not_attempted', 'Not attempted'],
          ['attempting', 'Attempting'],
          ['callback_due', 'Callback due'],
          ['quoting', 'Quoting'],
          ['not_interested', 'Not interested'],
          ['do_not_call', 'Do not call'],
          ['unreachable', 'Unreachable'],
        ];
        const CALL_OUTCOME: Array<[string, string]> = [
          ['no_answer', 'No answer'],
          ['voicemail', 'Voicemail left'],
          ['bad_number', 'Bad number / disconnected'],
          ['wrong_person', 'Wrong person'],
          ['callback_scheduled', 'Reached — callback scheduled'],
          ['quote_requested', 'Reached — quote requested'],
          ['not_interested', 'Reached — not interested'],
          ['do_not_call', 'Reached — do not call'],
        ];
        const QUOTE_CHIPS: Array<[string, string]> = [
          ['not_rated', 'Not rated'],
          ['rated', 'Rated'],
          ['quoted', 'Quoted'],
          ['sold', 'Sold'],
          ['lost', 'Lost'],
        ];
        /**
         * Every state is shown, including the ones at zero.
         *
         * Hiding an empty state makes the board describe only what has happened, when the
         * question a producer is asking is "how many are where" — and "nobody has been
         * reached yet" is an answer. A zero chip is muted and does nothing when clicked,
         * so it reads as a count rather than an offer.
         */
        const chip = (active: boolean, label: string, n: number, onClick: () => void) => (
          <Chip
            key={label} size="small" label={`${label} · ${n.toLocaleString()}`}
            onClick={n ? onClick : undefined}
            variant={active ? 'filled' : 'outlined'}
            sx={{
              height: 24, fontSize: 12,
              cursor: n ? 'pointer' : 'default',
              fontWeight: active ? 700 : 400,
              bgcolor: active ? '#1a3d7c' : undefined,
              color: active ? '#fff' : (n ? undefined : '#b6bcc6'),
              borderColor: n ? undefined : '#e6e8eb',
            }}
          />
        );
        const label = (t: string) => (
          <Typography sx={{ fontSize: 10, fontWeight: 700, letterSpacing: '.09em', textTransform: 'uppercase', color: '#8a93a3', mb: 0.6 }}>
            {t}
          </Typography>
        );
        return (
          <Paper variant="outlined" sx={{ p: 1.5, mb: 2 }}>
            <Typography sx={{ fontSize: 13, fontWeight: 700, color: '#2c3440', mb: 1 }}>
              Where {outcomeTally.inGrade.toLocaleString()} lead{outcomeTally.inGrade === 1 ? '' : 's'} stand
              {outcomeGrade !== 'all' && (
                <span style={{ fontWeight: 400, color: '#5a6675' }}>{` · Grade ${outcomeGrade} only, of ${outcomeTally.total.toLocaleString()}`}</span>
              )}
            </Typography>

            {/*
              Grade first, because it is the coarsest cut and the one a producer picks
              before anything else — "of my Grade A leads, how many have been called".
              It composes with the two below rather than replacing them, the same way
              Renewal Week's grade / status / trait compose.
            */}
            {label('Grade')}
            <Stack direction="row" spacing={0.75} useFlexGap sx={{ flexWrap: 'wrap', mb: 1.25 }}>
              {chip(outcomeGrade === 'all', 'All', outcomeTally.total, () => setOutcomeGrade('all'))}
              {['A', 'B', 'C', 'D', 'ungraded'].map((g) => {
                const n = outcomeTally.grade[g] ?? 0;
                const active = outcomeGrade === g;
                return (
                  <Chip
                    key={g} size="small" label={`${g} · ${n.toLocaleString()}`}
                    onClick={n ? () => setOutcomeGrade(active ? 'all' : g) : undefined}
                    sx={{
                      height: 24, fontSize: 12, fontWeight: 700,
                      cursor: n ? 'pointer' : 'default',
                      // The grade's own colour, so a grade reads the same here as it does
                      // on the lead card and in every other report.
                      bgcolor: n ? gradeColor(g) : '#f4f6f8',
                      color: n ? '#fff' : '#b6bcc6',
                      outline: active ? '2px solid #1565c0' : 'none',
                      outlineOffset: 1,
                    }}
                  />
                );
              })}
            </Stack>

            {label('Call status')}
            <Stack direction="row" spacing={0.75} useFlexGap sx={{ flexWrap: 'wrap', mb: 1.25 }}>
              {chip(callFilter === 'all', 'All', outcomeTally.inGrade, () => setCallFilter('all'))}
              {CALL_STATUS.map(([k, l]) =>
                chip(callFilter === k, l, outcomeTally.call[k] ?? 0, () => setCallFilter(k)))}
            </Stack>

            {label('What the last call returned')}
            <Stack direction="row" spacing={0.75} useFlexGap sx={{ flexWrap: 'wrap', mb: 1.5 }}>
              {CALL_OUTCOME.map(([k, l]) =>
                chip(callFilter === k, l, outcomeTally.call[k] ?? 0, () => setCallFilter(k)))}
            </Stack>

            {label('Quote stage')}
            <Stack direction="row" spacing={0.75} useFlexGap sx={{ flexWrap: 'wrap' }}>
              {chip(quoteFilter === 'all', 'All', outcomeTally.inGrade, () => setQuoteFilter('all'))}
              {QUOTE_CHIPS.map(([k, l]) =>
                chip(quoteFilter === k, l, outcomeTally.quote[k] ?? 0, () => setQuoteFilter(k)))}
            </Stack>

            {/*
              The two states that belong to nobody's queue, promoted out of the chip rows
              because neither is reachable by picking one chip — they are crossings.
            */}
            {(outcomeTally.askedNotQuoted > 0 || outcomeTally.quotedNoOutcome > 0) && (
              <Stack direction="row" spacing={1} useFlexGap sx={{ flexWrap: 'wrap', mt: 1.5, pt: 1.25, borderTop: '1px solid #e6e8eb' }}>
                {outcomeTally.askedNotQuoted > 0 && (
                  <Chip
                    size="small"
                    label={`${outcomeTally.askedNotQuoted} asked for a quote and never got one`}
                    onClick={() => { setCallFilter('quote_requested'); setQuoteFilter('all'); }}
                    sx={{ cursor: 'pointer', height: 24, fontSize: 12, fontWeight: 700, bgcolor: '#fff8e8', color: '#8a5a00' }}
                  />
                )}
                {outcomeTally.quotedNoOutcome > 0 && (
                  <Chip
                    size="small"
                    label={`${outcomeTally.quotedNoOutcome} quoted, neither sold nor lost`}
                    onClick={() => { setCallFilter('all'); setQuoteFilter('quoted'); }}
                    sx={{ cursor: 'pointer', height: 24, fontSize: 12, fontWeight: 700, bgcolor: '#e8eefc', color: '#1a3d7c' }}
                  />
                )}
              </Stack>
            )}
          </Paper>
        );
      })()}

      {reach && (() => {
        const pct = (n: number, d: number) => (d ? `${Math.round((n / d) * 100)}%` : '—');
        // Every chip filters the table. Clicking the active one clears it, so the way out
        // is the way in — no separate reset to hunt for.
        const slice = (key: typeof reachFilter, label: string, sx: Record<string, unknown> = {}) => (
          <Chip
            key={key} size="small" label={label} clickable
            onClick={() => setReachFilter(reachFilter === key ? 'all' : key)}
            sx={{
              ...sx, cursor: 'pointer',
              outline: reachFilter === key ? '2px solid #1565c0' : 'none', outlineOffset: 1,
            }}
          />
        );
        const combined = reach.insured + reach.coOnly;
        const unreachable = reach.total - combined;

        return (
          <Paper variant="outlined" sx={{ p: 2, mb: 2 }}>
            <Stack direction="row" spacing={1} useFlexGap sx={{ flexWrap: 'wrap', alignItems: 'center', mb: 1.5 }}>
              <Typography variant="h6" sx={{ mr: 1 }}>{reach.total.toLocaleString()} leads</Typography>
              {slice('insured', `${reach.insured.toLocaleString()} reachable at the insured (${pct(reach.insured, reach.total)})`, {
                fontWeight: 600, bgcolor: '#dcfce7', color: '#166534',
              })}
              {slice('coOnly', `${reach.coOnly.toLocaleString()} only at the co-insured`, {
                fontWeight: 600, bgcolor: '#fff3d6', color: '#8a5a00',
              })}
              {slice('unreachable', `${unreachable.toLocaleString()} unreachable`, {
                bgcolor: '#fee2e2', color: '#b3261e',
              })}
              {reachFilter !== 'all' && (
                <Typography variant="caption" sx={{ color: '#1565c0', fontWeight: 600 }}>
                  · showing {shownRows.length.toLocaleString()} — click the chip again to clear
                </Typography>
              )}
            </Stack>

            {/* The point of the report: what the insured-only rule costs in reach. */}
            <Typography variant="caption" color="text.secondary" sx={{ display: 'block', mb: 1.5 }}>
              Combined reach would be <strong>{combined.toLocaleString()}</strong> ({pct(combined, reach.total)}) if
              co-insured addresses were mailed — <strong>{reach.coOnly.toLocaleString()}</strong> households
              {' '}({pct(reach.coOnly, reach.total)}) are reachable no other way. Campaigns currently go to the named insured only.
            </Typography>

            <Divider sx={{ my: 1.5 }} />

            <Box sx={{ overflowX: 'auto' }}>
              <Table size="small">
                <TableHead>
                  <TableRow>
                    <TableCell>Renewal week</TableCell>
                    <TableCell align="right">Leads</TableCell>
                    <TableCell align="right">Insured</TableCell>
                    <TableCell align="right">Co-insured only</TableCell>
                    <TableCell align="right">Combined</TableCell>
                    <TableCell align="right">Reach</TableCell>
                  </TableRow>
                </TableHead>
                <TableBody>
                  {reach.weeks.map((w) => {
                    const c = w.insured + w.coOnly;
                    return (
                      <TableRow key={w.cohort} hover>
                        <TableCell>{w.label}</TableCell>
                        <TableCell align="right">{w.total.toLocaleString()}</TableCell>
                        <TableCell align="right">{w.insured.toLocaleString()}</TableCell>
                        <TableCell align="right" sx={{ color: w.coOnly ? '#8a5a00' : 'inherit', fontWeight: w.coOnly ? 600 : 400 }}>
                          {w.coOnly.toLocaleString()}
                        </TableCell>
                        <TableCell align="right">{c.toLocaleString()}</TableCell>
                        <TableCell align="right">{pct(c, w.total)}</TableCell>
                      </TableRow>
                    );
                  })}
                </TableBody>
              </Table>
            </Box>
          </Paper>
        );
      })()}

      {coverage && (() => {
        // Clickable chip → filter the table to that slice. Clicking the active one clears it.
        const covChip = (key: typeof covFilter, label: string, sx: any) => {
          const active = covFilter === key;
          return (
            <Chip
              label={label} size="small" clickable
              onClick={() => setCovFilter(active ? 'all' : key)}
              sx={{ ...sx, cursor: 'pointer', outline: active ? '2px solid #1565c0' : 'none', outlineOffset: 1 }}
            />
          );
        };
        return (
          <Paper variant="outlined" sx={{ p: 2, mb: 2 }}>
            <Stack direction="row" sx={{ alignItems: 'center', justifyContent: 'space-between', mb: 1, flexWrap: 'wrap', gap: 1 }}>
              <Typography variant="subtitle2" sx={{ fontWeight: 700 }}>
                Rated accounts — contact coverage ({coverage.total}){covFilter !== 'all' ? ` · showing ${shownRows.length}` : ''}
              </Typography>
              {covFilter !== 'all' && (
                <Button size="small" onClick={() => setCovFilter('all')}>Clear filter</Button>
              )}
            </Stack>
            <Typography variant="caption" color="text.secondary" sx={{ display: 'block', mb: 1 }}>Click a chip to filter the list below.</Typography>
            <Stack direction="row" spacing={1} sx={{ flexWrap: 'wrap', gap: 1 }}>
              {covChip('sfh', `SFH: ${coverage.sfh}`, { bgcolor: '#dcfce7', color: '#166534', fontWeight: 700 })}
              {covChip('condo', `Condo: ${coverage.condo}`, { bgcolor: '#ede9fe', color: '#5b21b6', fontWeight: 700 })}
              <Box sx={{ width: 1, alignSelf: 'stretch', borderLeft: '1px solid', borderColor: 'divider', mx: 0.5 }} />
              {covChip('both', `Phone + Email: ${coverage.both}`, { bgcolor: '#dcfce7', color: '#166534' })}
              {covChip('phoneOnly', `Phone only: ${coverage.phoneOnly}`, { bgcolor: '#fff3d6', color: '#8a5a00', fontWeight: 600 })}
              {covChip('emailOnly', `Email only: ${coverage.emailOnly}`, { bgcolor: '#fff3d6', color: '#8a5a00', fontWeight: 600 })}
              {covChip('neither', `Neither: ${coverage.neither}`, { bgcolor: '#fee2e2', color: '#b3261e', fontWeight: 600 })}
              <Box sx={{ width: 1, alignSelf: 'stretch', borderLeft: '1px solid', borderColor: 'divider', mx: 0.5 }} />
              {covChip('noEmail', `No email (downgrade review): ${coverage.noEmail}`, { bgcolor: '#fff', color: '#b3261e', fontWeight: 600, border: '1px solid #f2a3a3' })}
              {covChip('hasDob', `Has DOB: ${coverage.hasDob}`, { border: '1px solid', borderColor: 'divider' })}
            </Stack>
          </Paper>
        );
      })()}

      {/*
        The recovery pipeline: isolated → Tracerfy → BatchData → recovered.

        Four stages rather than the three tools, because "came back" is a population
        people need to count, not just an outcome. Each stage is read from the lead's own
        recorded stage, so the tab totals and the QC filters cannot disagree.
      */}
      {/*
        ── The queues, before anything else on this screen ────────────────────
        Grade A and Grade B are separate runs with separate economics: an A trace chases an
        address for an account already priced and ready to send; a B trace is speculative,
        which is exactly why Frank asked for them apart. Showing them as one number would
        undo that at the only point somebody looks.
      */}
      {report === 'blast_skiptrace' && queues.length > 0 && (
        <Paper variant="outlined" sx={{ p: 2, mb: 2, borderColor: '#e0b84c', bgcolor: '#fffdf5' }}>
          <Typography variant="subtitle2" sx={{ fontWeight: 700, mb: 1 }}>
            Waiting in the skip-trace queue
          </Typography>
          <Stack direction="row" spacing={2} useFlexGap sx={{ flexWrap: 'wrap' }}>
            {queues.map((q) => (
              <Box
                key={q.grade}
                sx={{
                  px: 2, py: 1.25, borderRadius: 1, minWidth: 230,
                  border: '1px solid',
                  // Grade B is coloured apart deliberately. It is the speculative spend,
                  // and the one somebody could start believing it was the other.
                  borderColor: q.grade === 'B' ? '#b26a00' : '#2c6ecb',
                  bgcolor: q.grade === 'B' ? '#fff4e5' : '#eef4ff',
                }}
              >
                <Stack direction="row" spacing={1} sx={{ alignItems: 'center', mb: 0.5 }}>
                  <Chip
                    size="small"
                    label={`Grade ${q.grade}`}
                    sx={{
                      height: 20, fontSize: 11, fontWeight: 700,
                      bgcolor: q.grade === 'B' ? '#b26a00' : '#2c6ecb',
                      color: '#fff',
                    }}
                  />
                  <Typography variant="body2" sx={{ fontWeight: 700 }}>
                    {q.waiting.toLocaleString()} waiting
                  </Typography>
                  {q.traced > 0 && (
                    <Typography variant="caption" sx={{ color: '#5a6675' }}>
                      · {q.traced.toLocaleString()} already traced
                    </Typography>
                  )}
                </Stack>
                <Typography variant="caption" sx={{ display: 'block', color: '#5a6675' }}>
                  {q.grade === 'B'
                    ? 'No band price — speculative spend. Run separately from Grade A.'
                    : 'Priced accounts waiting on an address.'}
                </Typography>
                <Typography variant="caption" sx={{ display: 'block', color: '#8a8f98' }}>
                  queued by {q.queuedBy.join(', ') || '—'}{q.oldest ? ` · oldest ${q.oldest}` : ''}
                </Typography>
                {/*
                  Why the count on the button and the count during the run differ.

                  The label is the queue length; the run first asks how many are actually
                  workable and traces those. Trust and company-owned leads are skipped — so
                  "Trace 2,419" starts reporting "5/2,330" and looks like it lost 89 leads.
                  Saying it up front costs one line and removes the whole question.
                */}
                <Typography variant="caption" sx={{ display: 'block', color: '#8a8f98' }}>
                  Leads owned by a trust or company are skipped and not charged for, so the
                  run may cover slightly fewer than this.
                </Typography>

                {/*
                  Per queue, not one button for both. Running A and B together is the exact
                  thing keeping them separate is for — the spend decision is different.
                */}
                <Button
                  size="small"
                  variant="contained"
                  color={q.grade === 'B' ? 'warning' : 'primary'}
                  startIcon={queueRun?.busy && queueRun.grade === q.grade
                    ? <CircularProgress size={13} color="inherit" />
                    : <BoltIcon />}
                  onClick={() => runQueue(q.grade)}
                  disabled={!q.waiting || (queueRun?.busy ?? false)}
                  sx={{ mt: 1 }}
                >
                  {queueRun?.busy && queueRun.grade === q.grade
                    ? `Tracing ${queueRun.done}/${queueRun.total || q.waiting}…`
                    : `Trace ${q.waiting.toLocaleString()} — costs credits`}
                </Button>

                {queueRun && queueRun.grade === q.grade && !queueRun.busy && (
                  <Typography
                    variant="caption"
                    sx={{ display: 'block', mt: 0.75, color: queueRun.error ? '#b3261e' : '#1b6b2f', fontWeight: 600 }}
                  >
                    {queueRun.error
                      ? queueRun.error
                      : `traced ${queueRun.done} · ${queueRun.hits} matched · ${queueRun.credits} credits`}
                  </Typography>
                )}
              </Box>
            ))}
          </Stack>
          <Typography variant="caption" sx={{ display: 'block', color: '#5a6675', mt: 1.25 }}>
            Queued leads are isolated — they stay out of send lists until a trace returns an
            address. Their status is unchanged.
          </Typography>
        </Paper>
      )}

      {report === 'blast_skiptrace' && (
        <Paper ref={pipelineRef} variant="outlined" sx={{ p: 2, mb: 2 }}>
          <Stack direction="row" spacing={1} sx={{ alignItems: 'center', mb: 1.5, flexWrap: 'wrap' }} useFlexGap>
            {/*
              The range is named, not implied. With the date boxes empty this covers the
              whole book, and a number that does not say what it counts is how "31" got
              read as one week's leads when it was every isolated lead there is.
            */}
            <Typography variant="subtitle2" sx={{ fontWeight: 700, mr: 1 }}>
              Contact recovery pipeline
              <Box component="span" sx={{ fontWeight: 400, color: '#5a6675', ml: 0.75 }}>
                — {effFrom || effTo ? `${effFrom || 'start'} to ${effTo || 'today'}` : 'all dates'}
              </Box>
            </Typography>

            {/*
              Grade A and Grade B run through identical stages and are never counted
              together. Merging them would hide which population the work landed in, and
              they are worked for different reasons — an A recovery unblocks an account
              already priced, a B recovery unblocks one with no band price at all.
            */}
            <ToggleButtonGroup
              size="small"
              exclusive
              value={pipeGrade}
              onChange={(_, v) => {
                if (!v || v === pipeGrade) return;
                setPipeGrade(v);
                pipeGradeRef.current = v;
                try { sessionStorage.setItem('qc:pipeGrade', v); } catch { /* blocked storage is not worth failing over */ }
                void loadPipeline(pipeline.stage);
              }}
              sx={{
                mr: 1,
                '& .MuiToggleButton-root': { px: 1.5, py: 0.25, textTransform: 'none', fontWeight: 700, fontSize: 12 },
                '& .Mui-selected': {
                  bgcolor: pipeGrade === 'B' ? '#b26a00 !important' : '#2c6ecb !important',
                  color: '#fff !important',
                },
              }}
            >
              <ToggleButton value="A">Grade A</ToggleButton>
              <ToggleButton value="B">Grade B</ToggleButton>
            </ToggleButtonGroup>
            {PIPELINE_STAGES.map((st) => {
              const n = pipeline.counts?.[st.key] ?? 0;
              const active = pipeline.stage === st.key;
              return (
                <Chip
                  key={st.key} size="small" clickable
                  label={`${st.label}: ${n.toLocaleString()}`}
                  onClick={() => loadPipeline(st.key)}
                  sx={{
                    fontWeight: active ? 700 : 500,
                    bgcolor: active ? st.color : '#f1f3f5',
                    color: active ? '#fff' : '#3d4658',
                    '&:hover': { bgcolor: active ? st.color : '#e3e6ea' },
                  }}
                />
              );
            })}
            <Button size="small" onClick={() => loadPipeline(pipeline.stage)} disabled={pipeline.busy}>
              {pipeline.busy ? 'Loading…' : 'Refresh'}
            </Button>
          </Stack>

          {/*
            ── Where the whole book went ─────────────────────────────────────

            The four chips say how many leads sit at each stage and never said how many
            there are altogether, so the only way to answer "how much have we traced, out of
            what" was to add four numbers in your head and hope none of them overlapped.
            Frank asked exactly that question after running a Grade B blast.

            One sentence, arithmetic that closes: everything enrolled, split into done and
            not done, plus the ones nobody has enrolled at all — which is the number that
            makes the other four look wrong when it is missing.
          */}
          {!!pipeline.counts && (() => {
            const c = pipeline.counts;
            const enrolled = c.isolated + c.tracerfy + c.batchdata + c.recovered;
            const traced = c.tracerfy + c.batchdata + c.recovered;
            const total = enrolled + (c.awaitingIsolation ?? 0);
            return (
              <Typography variant="body2" sx={{ mb: 1, color: '#3d4658' }}>
                <b>Grade {pipeGrade}</b> in this date range: <b>{total.toLocaleString()}</b> leads with no
                insured email.{' '}
                {traced.toLocaleString()} {traced === 1 ? 'has' : 'have'} been through a trace
                {enrolled > 0 && ` (${Math.round((traced / enrolled) * 100)}% of the ${enrolled.toLocaleString()} enrolled)`},
                {' '}<b>{c.isolated.toLocaleString()}</b> {c.isolated === 1 ? 'is' : 'are'} still waiting
                {!!c.awaitingIsolation && <>, and {c.awaitingIsolation.toLocaleString()} {c.awaitingIsolation === 1 ? 'is' : 'are'} not enrolled yet</>}.
              </Typography>
            );
          })()}

          <Typography variant="caption" color="text.secondary" sx={{ display: 'block', mb: 1 }}>
            {PIPELINE_STAGES.find((s) => s.key === pipeline.stage)?.blurb(pipeGrade)}
            {' '}Recovery means an insured <b>email</b> — that is what isolation is. A lead that gains only a
            phone keeps the phone and stays in the pipeline.
          </Typography>

          {/*
            Which vendor actually earned its money.

            The stage chips say where leads ARE; they never said who got them out, so
            "Recovered: 1" could not answer the only question that decides whether a second
            vendor is worth paying for. Both figures are already recorded per lead.
          */}
          {!!pipeline.counts && (pipeline.counts.recovered > 0 || pipeline.counts.phoneOnly > 0) && (
            <Typography variant="caption" sx={{ display: 'block', mb: 1, color: '#166534' }}>
              Recovered by — <b>Tracerfy {pipeline.counts.recoveredByTracerfy ?? 0}</b>
              {' · '}<b>BatchData {pipeline.counts.recoveredByBatchData ?? 0}</b>
              {!!pipeline.counts.phoneOnly && (
                <Box component="span" sx={{ color: '#8a5a00' }}>
                  {'  ·  '}{pipeline.counts.phoneOnly} gained a phone but no email — still unmailable, still in the pipeline
                </Box>
              )}
            </Typography>
          )}

          {/* Only the two vendor stages can be blasted; the others are outcomes. */}
          {/*
            Leads that belong in this pipeline and have not been put in it.

            Four zeros used to mean two completely different things — "this week has no
            unreachable leads" and "nobody has pressed Isolate for this week" — and the
            11/09 week showed the second while reading as the first, with 47 leads waiting.
            The only control that could enrol them lived behind a chip on the Renewal Week
            tab, which is not a place anyone looking at an empty pipeline would think to go.

            Isolating is free, calls no vendor, sends nothing, and remembers each lead's
            status so it can be undone. So the action belongs here, next to the gap it fills.
          */}
          {!!pipeline.counts?.awaitingIsolation && (
            <Alert
              severity="info"
              sx={{ mb: 2 }}
              action={
                <Button
                  size="small"
                  disabled={isolateState.busy}
                  onClick={() => {
                    const n = pipeline.counts?.awaitingIsolation ?? 0;
                    if (confirm(
                      `Isolate ${n} Grade ${pipeGrade} lead${n === 1 ? '' : 's'} with no insured email?\n\n`
                      + 'They move into this pipeline so they can be worked through Tracerfy and '
                      + 'BatchData. Each lead\'s current status is remembered and restored '
                      + 'automatically if an address turns up.\n\n'
                      + 'Nothing is sent and no vendor is called — this costs nothing.',
                    )) runIsolate(false);
                  }}
                >
                  {isolateState.busy ? 'Working…' : `Isolate ${pipeline.counts.awaitingIsolation}`}
                </Button>
              }
            >
              <strong>
                {pipeline.counts.awaitingIsolation} Grade {pipeGrade} lead
                {pipeline.counts.awaitingIsolation === 1 ? '' : 's'} in this range {pipeline.counts.awaitingIsolation === 1 ? 'has' : 'have'} no insured email and {pipeline.counts.awaitingIsolation === 1 ? 'is' : 'are'} not in the pipeline yet.
              </strong>
              {' '}The stages below only count leads that have been isolated, so they read
              zero until these are enrolled. Isolating is free and reversible.
            </Alert>
          )}

          {isolateState.msg && (
            <Typography variant="caption" sx={{ color: '#8a5a00', display: 'block', mb: 1.5 }}>
              {isolateState.msg}
            </Typography>
          )}

          {(pipeline.stage === 'isolated' || pipeline.stage === 'tracerfy') && (
            <Stack direction="row" spacing={1} sx={{ alignItems: 'center', mb: 1, flexWrap: 'wrap' }} useFlexGap>
              {/*
                The button no longer tries to predict whether the account can pay.
                Neither vendor publishes a balance, so any figure here is arithmetic on a
                number somebody typed in — and once the account was topped up outside the
                CRM that arithmetic went negative and disabled the stage while the vendor
                dashboard showed a balance. Guessing wrong in that direction blocks work
                that was affordable all along.

                The run finds out instead: it tries, the vendor refuses, it stops on the
                spot and says so. Nothing below the refusal is attempted, so an empty
                account costs one call rather than the ~290 it cost the last time a blast
                carried on regardless.
              */}
              {(() => {
                const vendor = pipeline.stage === 'isolated' ? 'tracerfy' : 'batchdata';
                /**
                 * ── The same leads are offered by the queue panel above ─────────
                 *
                 * queueForBlast stamps recoveryStage='isolated' as well as blastQueuedAt, so
                 * a lead queued for a blast is enrolled in this pipeline at the same moment.
                 * On 30 Sep that was a perfect overlap: 2,419 waiting in the Grade B queue,
                 * 2,419 at "Not traced yet", 2,419 in both. Two buttons, one vendor, one set
                 * of leads, and nothing on screen saying so — the reasonable reading was that
                 * they did different things and one of them had not been run.
                 *
                 * Both are kept. They are not interchangeable: this one caps at MAX_PER_BLAST
                 * and the queue runs the whole backlog in one go, which for 2,419 leads is the
                 * difference between one click and twenty-four. Grade A leads isolated by hand
                 * never enter the queue at all, so this button is the only way to work them.
                 *
                 * What was missing was the sentence telling you which to press.
                 */
                const queueForThisGrade = queues.find((x) => x.grade === pipeGrade);
                const alsoQueued = pipeline.stage === 'isolated'
                  && !!queueForThisGrade?.waiting
                  && queueForThisGrade.waiting >= (pipeline.counts?.isolated ?? 0)
                  && (pipeline.counts?.isolated ?? 0) > 0;
                /**
                 * The workable rows, NOT counts[stage].
                 *
                 * counts[stage] includes trust-owned leads, which the run skips without
                 * calling anyone — so the button used to offer "Run Tracerfy on 31" and
                 * then attempt 9. The figure on a button that spends money has to be the
                 * number it will actually spend on.
                 */
                const pool = pipelineWorkable.length;
                return (
                  <>
                    <Button
                      size="small"
                      // Secondary when the queue above offers the same leads in one go, so the
                      // two buttons stop competing for the same press.
                      variant={alsoQueued ? 'outlined' : 'contained'}
                      startIcon={pipeline.busy ? <CircularProgress size={13} color="inherit" /> : <BoltIcon />}
                      onClick={() => runPipelineBlast(vendor, false)}
                      disabled={pipeline.busy || !pool}
                    >
                      {`Run ${vendor === 'tracerfy' ? 'Tracerfy' : 'BatchData'} on `}
                      {pool <= MAX_PER_BLAST ? pool : `${MAX_PER_BLAST} of ${pool}`}
                    </Button>

                    {alsoQueued && (
                      <Typography variant="caption" sx={{ color: '#8a5a00', fontWeight: 600 }}>
                        These are the same leads as the Grade {pipeGrade} queue above — the amber
                        button there traces all {queueForThisGrade!.waiting.toLocaleString()} in one
                        go. Use this one only to run a batch of {MAX_PER_BLAST}.
                      </Typography>
                    )}
                    <Typography variant="caption" sx={{ color: '#8a5a00' }}>
                      {pool > MAX_PER_BLAST
                        ? `Costs money · capped at ${MAX_PER_BLAST} per run, so this needs ${Math.ceil(pool / MAX_PER_BLAST)} runs · leads that return nothing move to the next stage`
                        : 'Costs money · leads that return nothing move to the next stage'}
                      {/*
                        Why the button offers fewer than the chip counts.

                        The chip says 2,419 and the button says 2,330, and the 89 between
                        them were explained only in a source comment. Two numbers that
                        disagree with no reason given is the thing that makes a screen feel
                        broken even when both are right.
                      */}
                      {pipelineEntities.length > 0 && (
                        <> · {pipelineEntities.length.toLocaleString()} of the{' '}
                          {(pipeline.counts?.[pipeline.stage] ?? 0).toLocaleString()} at this stage are owned by
                          a trust or company, so a person-level trace cannot return anything for them —
                          they are listed separately below and not charged for
                        </>
                      )}
                    </Typography>
                  </>
                );
              })()}
            </Stack>
          )}

          {pipeline.msg && (
            <Typography variant="caption" sx={{ display: 'block', mb: 1, color: '#1565c0', fontWeight: 600 }}>
              {pipeline.msg}
            </Typography>
          )}

          {/*
            Shown only when a run actually stopped itself. It reports what happened rather
            than what might: the vendor refused, at this point, with this many leads left.
          */}
          {pipeline.stopped && (
            <Alert severity="warning" sx={{ mb: 2 }}>
              <strong>
                {pipeline.stopped.reason === 'no_credits'
                  ? `${pipeline.stopped.vendor} is out of credits — the run stopped.`
                  : pipeline.stopped.reason === 'auth'
                    ? `${pipeline.stopped.vendor} rejected the API key — the run stopped.`
                    : `${pipeline.stopped.vendor} failed on three calls in a row — the run stopped.`}
              </strong>
              {' '}
              {pipeline.stopped.remaining > 0
                ? `${pipeline.stopped.remaining} lead${pipeline.stopped.remaining === 1 ? '' : 's'} in this batch ${pipeline.stopped.remaining === 1 ? 'was' : 'were'} not attempted and ${pipeline.stopped.remaining === 1 ? 'has' : 'have'} not been charged — still at this stage, so the same button picks up where this left off.`
                : 'Every lead in this batch had already been attempted.'}
              {pipeline.stopped.reason === 'no_credits' && ' Top up and run it again.'}
              <Box sx={{ mt: 0.5, fontFamily: 'monospace', fontSize: 11, color: '#5a6675' }}>
                {pipeline.stopped.vendor} said: {pipeline.stopped.detail}
              </Box>
            </Alert>
          )}

          <Box sx={{ overflowX: 'auto' }}>
            <Table size="small">
              <TableHead>
                <TableRow>
                  {/*
                    The Trust column is meaningful only in the file — on screen those leads
                    have their own panel below the table.
                  */}
                  {PIPELINE_COLUMNS.filter((c) => c.header !== 'Trust / company owned').map((c) => (
                    <TableCell key={c.header} sx={{ fontFamily: 'monospace', fontSize: 10.5, letterSpacing: '.06em', textTransform: 'uppercase', color: '#5a6675', whiteSpace: 'nowrap' }}>{c.header}</TableCell>
                  ))}
                </TableRow>
              </TableHead>
              <TableBody>
                {pipelineWorkable.slice(0, MAX_RENDERED).map((r) => (
                  <TableRow key={r.id} hover>
                    {PIPELINE_COLUMNS.filter((c) => c.header !== 'Trust / company owned').map((c) => (
                      <TableCell key={c.header} sx={{ fontSize: c.header === 'Lead ID' ? 11 : 12 }}>
                        {c.cell ? c.cell(r) : (c.value(r) || '—')}
                      </TableCell>
                    ))}
                  </TableRow>
                ))}
                {!pipelineWorkable.length && (
                  <TableRow>
                    <TableCell colSpan={PIPELINE_COLUMNS.length - 1} sx={{ fontSize: 12, color: '#5a6675', py: 2 }}>
                      {pipelineEntities.length
                        ? `Nothing workable at this stage — the ${pipelineEntities.length} lead${pipelineEntities.length === 1 ? '' : 's'} here ${pipelineEntities.length === 1 ? 'is' : 'are'} trust or company owned, listed below.`
                        : 'Nothing at this stage for the chosen dates.'}
                    </TableCell>
                  </TableRow>
                )}
              </TableBody>
            </Table>
          </Box>

          {/*
            Trust- and company-owned leads at this stage.

            Held out of the table above and out of the blast because the vendors key off a
            named person and an entity is not one — the call bills and returns nothing. Of
            686 entity-owned leads in the book exactly one has ever been traced, and the
            number it returned was logged as a bad number the next day.

            They are shown rather than hidden because they are the reason this stage never
            reaches zero. A queue that will not drain with no explanation gets re-run, and
            re-running is what costs money. The matched word sits next to each owner so a
            real homeowner wrongly caught here is visible instead of silently dropped.
          */}
          {!!pipelineEntities.length && (
            <Box
              sx={{
                mt: 2, p: 1.5, borderRadius: 1,
                border: '1px solid #e0b84c', bgcolor: '#fdf7e7',
              }}
            >
              <Typography sx={{ fontSize: 13, fontWeight: 700, color: '#6b4e00', mb: 0.25 }}>
                Trust &amp; company owned — not skip traced ({pipelineEntities.length})
              </Typography>
              <Typography sx={{ fontSize: 12, color: '#6b5a2e', mb: 1.25 }}>
                The owner of record is an entity, not a person, so there is no named
                individual for Tracerfy or BatchData to look up. These are excluded from
                every blast and cost nothing. They stay at this stage — that is expected,
                not a stuck queue.
              </Typography>
              <Box sx={{ maxHeight: 260, overflowY: 'auto' }}>
                <Table size="small">
                  <TableBody>
                    {pipelineEntities.slice(0, MAX_RENDERED).map((r) => (
                      <TableRow key={r.id} hover>
                        <TableCell sx={{ fontSize: 11, fontFamily: 'monospace', border: 0, py: 0.4 }}>
                          <Link href={`/leads/${r.id}?from=qc`} style={{ color: '#6b7280', textDecoration: 'none' }}>{r.id}</Link>
                        </TableCell>
                        <TableCell sx={{ fontSize: 12, border: 0, py: 0.4 }}>
                          <Link href={`/leads/${r.id}?from=qc`} style={{ color: '#1565c0', textDecoration: 'none' }}>{r.owner || '(no owner name)'}</Link>
                        </TableCell>
                        <TableCell sx={{ fontSize: 12, border: 0, py: 0.4 }}>
                          {r.city} <span style={{ color: '#9098a6' }}>{r.zip}</span>
                        </TableCell>
                        <TableCell sx={{ fontSize: 12, border: 0, py: 0.4 }}>{r.effectiveDate ?? '—'}</TableCell>
                        <TableCell sx={{ border: 0, py: 0.4 }}>
                          <Chip
                            size="small"
                            label={r.entity!.label}
                            title={`Identified by "${r.entity!.matched}"`}
                            sx={{ height: 19, fontSize: 11, bgcolor: '#e0b84c', color: '#3d2c00', fontWeight: 700 }}
                          />
                        </TableCell>
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
              </Box>
              {pipelineEntities.length > MAX_RENDERED && (
                <Typography sx={{ fontSize: 11, color: '#6b5a2e', mt: 0.75 }}>
                  Showing {MAX_RENDERED} of {pipelineEntities.length}.
                </Typography>
              )}
            </Box>
          )}

          {/*
            The run history (Frank, 24 Sep 2026 · fix 20).

            Underneath the stage counts rather than on a tab of its own, because it is what
            makes them readable. A stage showing "45 waiting" means one thing if nothing has
            ever been run against that week and something else entirely if three runs have
            already been over it and found nothing — and the counts alone cannot tell those
            apart. That is how 11/09 sat with 47 leads waiting and read as though it had none.
          */}
          <Box sx={{ mt: 2, pt: 2, borderTop: '1px solid #e6e9ef' }}>
            <Typography variant="subtitle2" sx={{ fontWeight: 700, mb: 1 }}>
              Runs against this range
              <Box component="span" sx={{ fontWeight: 400, color: '#5a6675', ml: 0.75 }}>
                — every blast, including the ones that found nothing
              </Box>
            </Typography>
            <RunHistory runs={pipeline.runs} stalled={pipeline.stalled} />
          </Box>
        </Paper>
      )}

      {/*
        The old per-run history and the raw row table are hidden on this tab.
        
        The recovery pipeline above now answers the question this tab exists for — where
        each lead stands and what each vendor found — and showing a second, differently
        shaped count of the same leads underneath it is exactly how two numbers on one
        screen end up being argued about. Export CSV still writes every row.
      */}
      {report !== 'blast_skiptrace' && blastRuns && blastRuns.length > 0 && (
        <Paper variant="outlined" sx={{ p: 2, mb: 2 }}>
          <Typography variant="subtitle2" sx={{ fontWeight: 700, mb: 0.5 }}>
            {blastRuns.length} blast run{blastRuns.length === 1 ? '' : 's'} · {rows.length} lead{rows.length === 1 ? '' : 's'} traced
          </Typography>
          <Typography variant="caption" color="text.secondary" sx={{ display: 'block', mb: 1.5 }}>
            What each run recovered. Leads that returned nothing are worth re-checking before they are written off.
          </Typography>
          <Stack spacing={1}>
            {blastRuns.map((run) => (
              <Stack
                key={run.runId}
                direction="row" spacing={1} useFlexGap
                sx={{ alignItems: 'center', flexWrap: 'wrap', py: 0.75, borderTop: '1px solid', borderColor: 'divider' }}
              >
                <Typography variant="body2" sx={{ fontWeight: 600, minWidth: 92, fontVariantNumeric: 'tabular-nums' }}>{run.when}</Typography>
                <Typography variant="caption" color="text.secondary" sx={{ minWidth: 190 }}>{run.by}</Typography>
                <Chip size="small" label={`${run.leads} leads`} sx={{ height: 20, fontSize: 11 }} />
                <Chip size="small" label={`${run.hits} matched`} sx={{ height: 20, fontSize: 11, bgcolor: '#dcfce7', color: '#166534', fontWeight: 600 }} />
                <Chip size="small" label={`${run.leads - run.hits} no match`} sx={{ height: 20, fontSize: 11 }} />
                <Typography variant="caption" color="text.secondary">
                  {run.phone} with phone · {run.email} with email
                </Typography>
              </Stack>
            ))}
          </Stack>
        </Paper>
      )}

      {/*
        Shown for EVERY report, including the two that draw their own table.
        Those two used to show no count at all, so a date range quietly narrowing the set
        was invisible — which is how an export of one row came as a surprise. The number
        here is always the number Export CSV will write.
      */}
      {/*
        Kept until the next run rather than auto-dismissed. Queuing 2,681 leads and isolating
        them is not a toast — somebody needs to be able to read the breakdown, and check it
        against the blast screen, without having had to catch it.
      */}
      {queueMsg && (
        <Alert
          severity={/^0 queued/.test(queueMsg) ? 'info' : 'success'}
          onClose={() => setQueueMsg(null)}
          sx={{ mb: 1.5 }}
        >
          {queueMsg}
        </Alert>
      )}

      <Box sx={{ mb: 1, display: 'flex', alignItems: 'center', gap: 1 }}>
        {loading ? <CircularProgress size={18} /> : (() => {
          const n = report === 'cohort_ledger' ? ledger.length
            : report === 'blast_skiptrace' ? pipeline.rows.length
              : shownRows.length;
          const unit = report === 'cohort_ledger' ? 'renewal week' : 'record';
          return (
            <Typography variant="body2" color="text.secondary">
              <strong>{n.toLocaleString()}</strong> {unit}{n === 1 ? '' : 's'}
              {report === 'blast_skiptrace' && ` at the ${pipeline.stage} stage`}
              {(effFrom || effTo) && (
                <span style={{ color: '#8a5a00' }}>
                  {' '}· filtered to {effFrom || 'any'} → {effTo || 'any'}
                </span>
              )}
              {/*
                The band these rows were actually fetched with — not the band in the boxes.

                Changing the boxes does not re-run anything, so the table can sit there
                showing one population while the controls describe another, with nothing
                saying so. That is how a working filter reads as a broken one: 2001 was in
                the box and 176 rows were on screen from the previous 20–75 run.
              */}
              {report === 'roof_b' && ranAge && (
                <>
                  <span style={{ color: '#8a5a00' }}>
                    {/*
                      Straight from the boxes now that both bounds are inclusive. This
                      briefly printed min + 1 to compensate for an exclusive lower bound,
                      which was correct and still confusing: typing 21 showed 22.
                    */}
                    {' '}· homes {ranAge.min}–{ranAge.max} years old
                  </span>
                  {(String(ranAge.min) !== ageMin.trim() || String(ranAge.max) !== ageMax.trim()) && (
                    <span style={{ color: '#b3261e', fontWeight: 700 }}>
                      {' '}— the boxes have changed since this ran. Press Run.
                    </span>
                  )}
                </>
              )}
            </Typography>
          );
        })()}
      </Box>

      {!rendersOwnTable && (
      <Paper variant="outlined" sx={{ overflowX: 'auto' }}>
        <Table size="small" stickyHeader>
          <TableHead>
            <TableRow>
              {tableColumns.map((c) => (
                <TableCell key={c.header} align={c.numeric ? 'right' : 'left'} sx={{ fontWeight: 700, whiteSpace: 'nowrap' }}>
                  {c.header}
                </TableCell>
              ))}
            </TableRow>
          </TableHead>
          <TableBody>
            {shownRows.slice(0, MAX_RENDERED).map((r) => (
              <TableRow key={r.propertyId + r.context} hover>
                {tableColumns.map((c) => (
                  <TableCell
                    key={c.header}
                    align={c.numeric ? 'right' : 'left'}
                    sx={c.header === 'Detail'
                      ? { maxWidth: 380, fontSize: 12.5, color: '#3d4658' }
                      : /Email|Phone/.test(c.header)
                        // Several addresses per cell: wrap rather than stretch the table.
                        ? { maxWidth: 230, fontSize: 12, color: '#3d4658', wordBreak: 'break-word' }
                        : { whiteSpace: 'nowrap', fontSize: 12.5 }}
                  >
                    {c.cell ? c.cell(r) : c.value(r)}
                  </TableCell>
                ))}
              </TableRow>
            ))}
            {shownRows.length > MAX_RENDERED && (
              <TableRow>
                <TableCell colSpan={tableColumns.length} sx={{ textAlign: 'center', py: 2, color: '#8a5a00', bgcolor: '#fff8e8', fontSize: 12.5 }}>
                  Showing the first {MAX_RENDERED} of {shownRows.length.toLocaleString()} — Export CSV gives you all of them.
                </TableCell>
              </TableRow>
            )}
            {!loading && ran && shownRows.length === 0 && (
              <TableRow><TableCell colSpan={tableColumns.length} sx={{ textAlign: 'center', py: 4, color: '#888' }}>No records match.</TableCell></TableRow>
            )}
          </TableBody>
        </Table>
      </Paper>
      )}
    </Container>
  );
}
