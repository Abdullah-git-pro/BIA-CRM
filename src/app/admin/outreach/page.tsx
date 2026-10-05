'use client';

import React, { useCallback, useEffect, useMemo, useState } from 'react';
import {
  Container, Box, Typography, Paper, TextField, Button, Chip, Table, TableHead,
  TableRow, TableCell, TableBody, CircularProgress, Alert, Stack, Tooltip, Divider,
  LinearProgress,
} from '@mui/material';
import InsightsIcon from '@mui/icons-material/Insights';
import DownloadIcon from '@mui/icons-material/Download';
import WarningAmberIcon from '@mui/icons-material/WarningAmber';
import CheckCircleOutlineIcon from '@mui/icons-material/CheckCircleOutlineOutlined';
import PauseCircleOutlineIcon from '@mui/icons-material/PauseCircleOutlined';
import FilterAltIcon from '@mui/icons-material/FilterAlt';
import { useStickyState } from '@/hooks/useStickyState';
/**
 * Type-only. The service reads @/lib/neon; a value import would pull the database client
 * into this bundle and the page would die on "No database connection string was
 * provided" — the same way the QC page did.
 */
import type {
  OutreachDashboard, FunnelStage, Guardrail, DashboardCohort,
} from '@/services/outreachDashboard.service';
import type { OutreachChannels } from '@/services/outreachChannels.service';
import type { BandAccuracyCut, LossRow } from '@/services/quoteOutcomes.service';
import ChannelSections from './ChannelSections';
import ColumnHeader from './ColumnHeader';
import { stickyFirstColumn, scrollableTable } from '@/lib/stickyColumn';

/**
 * What the endpoint returns: the Grade A ladder, plus the per-channel half of Sec 10.7.
 *
 * Fetched in one call rather than several so the two halves cannot end up describing
 * different ranges — the route passes the range the dashboard RESOLVED (the programme
 * window, when none was asked for) to the channel sections.
 */
type DashboardPayload = OutreachDashboard & {
  channels: OutreachChannels;
  bandAccuracy: { by: string; cuts: BandAccuracyCut[] };
  losses: { rows: LossRow[]; totalLosses: number; missingCompetitor: number };
};

/**
 * The outreach dashboard (directive Sec. 10.7).
 *
 * Reads one endpoint and renders three things: the funnel as a ladder, the guardrails as
 * a pass/watch/pause list, and the same funnel per renewal week so a drifting cohort is
 * visible before the average absorbs it.
 *
 * ── Nothing is computed here ────────────────────────────────────────────────
 * Every count, rate, target and floor arrives from the service. That is deliberate and it
 * is the whole point of this screen: the recurring defect in this codebase is two places
 * deriving the same number and disagreeing, and a dashboard that recomputed a rate in the
 * browser would be the most expensive possible place to do it. The page decides colour
 * and wording, and nothing else.
 *
 * ── "Not started" is not "0%" ───────────────────────────────────────────────
 * Until the first email goes out, every rung below "loaded" is unmeasured. Drawing those
 * as 0% against a 27% target paints eight red bars for a campaign that has not begun, and
 * a screen that cries wolf before launch is one nobody reads after launch.
 */

const fmtPct = (v: number | null) => (v == null ? '—' : `${v}%`);
const fmtNum = (v: number) => v.toLocaleString();

/**
 * Where a rate sits against its own target and floor. Drives colour and wording.
 *
 * `none` is the one that matters. Several figures here have no target in the tracker —
 * delivery rate, hard bounce rate, unsubscribe rate, band-hit rate, bound per 1,000. The
 * obvious version of this function returns "ok" when there is no target to fail, which
 * paints a 40% hard-bounce rate green and labels it Pass. A measurement with nothing to
 * be measured against is not passing; it is unjudged, and it has to look unjudged.
 */
type Verdict = 'ok' | 'watch' | 'bad' | 'none' | 'unknown';

function verdictOf(
  value: number | null,
  target: number | null,
  floor: number | null,
  direction: 'higher' | 'lower',
  started: boolean,
): Verdict {
  if (!started || value == null) return 'unknown';
  if (target == null && floor == null) return 'none';
  // A "lower is better" figure is judged against its target and nothing else. Without one
  // there is no ceiling to breach, whatever floor may be set for some other purpose.
  if (direction === 'lower') return target == null ? 'none' : value <= target ? 'ok' : 'bad';
  // Between the floor and the target is "watch": in plan, but not where it should land.
  if (floor != null && value < floor) return 'bad';
  if (target != null && value < target) return 'watch';
  return 'ok';
}

const VERDICT_COLOUR: Record<Verdict, string> = {
  ok: '#166534',
  watch: '#8a5a00',
  bad: '#b3261e',
  // Readable, but plainly not a verdict.
  none: '#111827',
  unknown: '#6b7280',
};

/** What the chip says. `unknown` never reaches these — it renders its own chip. */
const VERDICT_LABEL: Record<Verdict, string> = {
  ok: 'On plan',
  watch: 'Below target',
  bad: 'Below floor',
  none: 'No target',
  unknown: '—',
};

const GUARDRAIL_LABEL: Record<Verdict, string> = {
  ok: 'Pass',
  watch: 'Watch',
  bad: 'Off plan',
  none: 'No target',
  unknown: '—',
};

/**
 * The CSV contract, shared by the table and the export — one list, so a column cannot be
 * on screen and missing from the file. Same pattern as LEDGER_COLUMNS on the QC page,
 * and for the same reason: that export was written by hand and drifted.
 */
type CohortColumn = {
  header: string;
  value: (r: DashboardCohort) => string | number;
  numeric?: boolean;
  /** What this column is for, shown on the header. See ColumnHeader. */
  help: string;
};

const COHORT_COLUMNS: CohortColumn[] = [
  {
    header: 'Renewal week', value: (r) => r.label,
    help: 'The week these policies come up for renewal. Leads are pulled 60 days ahead of it, '
      + 'so this is the week the outreach is aiming at, not the week it happens.',
  },
  {
    header: 'Grade A at pull', value: (r) => r.atPull, numeric: true,
    help: 'How many Grade A leads the week started with. Frozen at the moment of the pull, so '
      + 'it never moves afterwards and everything else can be measured against it.',
  },
  {
    header: 'Kept', value: (r) => r.kept, numeric: true,
    help: 'Of those, how many are still Grade A today. This is the number the 87% retention '
      + 'target is measured on.',
  },
  {
    header: 'Upgraded in', value: (r) => r.gained, numeric: true,
    help: 'Leads that were NOT Grade A at the pull and are now, usually a re-grade or a '
      + 'correction. They are worked like any other lead, but they are not retention, so they '
      + 'are counted apart rather than allowed to flatter the kept figure.',
  },
  {
    header: 'Worked', value: (r) => r.worked, numeric: true,
    help: 'Grade A today: kept plus upgraded in. This is the live working population, and '
      + 'everything to the right is measured against it.',
  },
  {
    header: 'With insured email', value: (r) => r.withEmail, numeric: true,
    help: 'Of the worked leads, how many have an email address for the named insured, who is '
      + 'the only person the first email goes to. A co-insured address does not count here.',
  },
  {
    header: 'Loaded', value: (r) => r.loaded, numeric: true,
    help: 'Handed over to the campaign platform, ready to send.',
  },
  {
    header: 'Emailed', value: (r) => r.emailed, numeric: true,
    help: 'Recorded as sent. The send is logged at the moment of loading, so this tracks the '
      + 'column to its left closely. Delivered is the honest measure of reach.',
  },
  {
    header: 'Delivered', value: (r) => r.delivered, numeric: true,
    help: 'Sent and not bounced. The campaign platform reports no delivery events, so this is '
      + 'worked out rather than observed.',
  },
  {
    header: 'Engaged', value: (r) => r.engaged, numeric: true,
    help: 'Replied, or clicked something in the email. Measured against delivered, not sent.',
  },
  {
    header: 'Quoted', value: (r) => r.quoted, numeric: true,
    help: 'A firm, bindable premium was given to the homeowner.',
  },
  {
    header: 'Bound', value: (r) => r.bound, numeric: true,
    help: 'The policy was written. The end of the journey this table describes.',
  },
];

export default function OutreachDashboardPage() {
  /**
   * Note the ".v2" on these keys.
   *
   * "All weeks" was briefly implemented as the range 01/01/2000 – 12/31/2099, and
   * useStickyState wrote those into sessionStorage. Fixing the button did not unfix the
   * stored value: anyone who had pressed it still opened the page with two absurd dates in
   * the boxes and a filter they never chose. Renaming the key retires them for good, at
   * the cost of forgetting a saved range once.
   */
  const [effFrom, setEffFrom] = useStickyState('outreach.effFrom.v2', '');
  const [effTo, setEffTo] = useStickyState('outreach.effTo.v2', '');
  /**
   * Which weeks to show when no dates are set.
   *
   * "All weeks" is the absence of a range, so it is a scope rather than a pair of dates.
   * It used to be sent as 01/01/2000–12/31/2099, which put those dates in the boxes and
   * made a deliberate choice look like a data-entry accident.
   */
  const [scope, setScope] = useStickyState<'programme' | 'all'>('outreach.scope', 'programme');
  /** Typing a date overrides the scope entirely — an explicit range always wins. */
  const customRange = Boolean(effFrom || effTo);
  const [data, setData] = useState<DashboardPayload | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');

  /**
   * Fetch on mount and whenever the range changes.
   *
   * The work is started inside an async function rather than run straight down the effect
   * body, and it is cancelled on cleanup. Both matter:
   *
   *  · Without the abort, changing the range twice leaves two requests in flight and the
   *    SLOWER one wins. The screen would then show a range the date boxes do not say —
   *    the most misleading failure a reporting page has, because every number on it is
   *    individually correct.
   *  · A response arriving after unmount would setState on a dead component.
   *
   * `ignore` covers the gap the abort cannot: a request already past the await when the
   * cleanup runs.
   */
  useEffect(() => {
    const ac = new AbortController();
    let ignore = false;

    void (async () => {
      setLoading(true);
      setError('');
      try {
        const u = new URL('/api/admin/outreach-dashboard', window.location.origin);
        if (effFrom) u.searchParams.set('effFrom', effFrom);
        if (effTo) u.searchParams.set('effTo', effTo);
        // Only meaningful with no dates set; with dates, the range already decides.
        if (!effFrom && !effTo && scope === 'all') u.searchParams.set('scope', 'all');
        const res = await fetch(u.toString(), { credentials: 'include', signal: ac.signal });
        const json = await res.json();
        if (ignore) return;
        if (!json.success) throw new Error(json.error || 'Failed to load');
        setData(json.data as DashboardPayload);
      } catch (e) {
        // An abort is this effect being superseded, not a failure to report.
        if (ignore || (e instanceof DOMException && e.name === 'AbortError')) return;
        setError(e instanceof Error ? e.message : 'Failed to load the dashboard');
        setData(null);
      } finally {
        if (!ignore) setLoading(false);
      }
    })();

    return () => { ignore = true; ac.abort(); };
  }, [effFrom, effTo, scope]);

  const dateMin = data?.cohortBounds.first ?? undefined;
  const dateMax = data?.cohortBounds.last ?? undefined;

  /**
   * Drop a persisted date that lies outside the weeks that exist.
   *
   * The renamed key handles the sentinels that are already stored, but this is the general
   * case: any saved range can be left pointing at a week the book no longer holds, and the
   * screen should not open on a filter the data cannot satisfy. Runs once the bounds are
   * known, and only when something is actually out of range, so it cannot loop.
   */
  useEffect(() => {
    if (!dateMin || !dateMax) return;
    if (effFrom && (effFrom < dateMin || effFrom > dateMax)) setEffFrom('');
    if (effTo && (effTo < dateMin || effTo > dateMax)) setEffTo('');
  }, [dateMin, dateMax, effFrom, effTo, setEffFrom, setEffTo]);

  /** The widest rung, so every bar is drawn against the same scale. */
  const maxCount = useMemo(
    () => Math.max(1, ...(data?.funnel ?? []).map((s) => s.count)),
    [data],
  );

  const exportCsv = useCallback(() => {
    if (!data) return;
    const esc = (v: unknown) => {
      const s = String(v ?? '');
      return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
    };
    const lines = [
      'Funnel',
      ['Stage', 'Count', 'Measured against', 'Rate %', 'Target %', 'Floor %', 'Status'].map(esc).join(','),
      ...data.funnel.map((s) => [
        s.label, s.count,
        data.funnel.find((x) => x.key === s.of)?.label ?? '',
        s.started ? (s.rate ?? '') : '', s.target ?? '', s.floor ?? '',
        s.started ? 'measured' : 'not started',
      ].map(esc).join(',')),
      '',
      'Guardrails',
      ['Guardrail', 'Measured over', 'Value', 'Target', 'Pauses at', 'Good direction',
        'Status', 'Pause rule', 'Needs attention', 'Definition'].map(esc).join(','),
      ...data.guardrails.map((g) => [
        g.label, g.scope, g.started ? (g.value ?? '') : '', g.target ?? '', g.pauseAt ?? '',
        g.direction,
        g.breached ? 'PAUSE RULE FIRED' : g.started ? 'measured' : 'not started',
        g.pause ?? '', g.needsAttention ?? '', g.definition,
      ].map(esc).join(',')),
      '',
      'By renewal week',
      COHORT_COLUMNS.map((c) => esc(c.header)).join(','),
      ...data.byCohort.map((r) => COHORT_COLUMNS.map((c) => esc(c.value(r))).join(',')),
    ];

    /**
     * The channel sections, appended to the same file.
     *
     * One export per screen, not one per panel: the point of this file is that somebody can
     * reconcile it against the page, and a page with six tables that exports two of them is
     * exactly the drift this codebase keeps paying for.
     */
    if (data.channels) {
      const { funnels, crossChannel, responseTime, deliverability, headline } = data.channels;
      lines.push('', 'Headline (Sec 10.7 verdict metric)',
        ['Emails sent', 'Bound premium per 1,000', 'Commission per 1,000', 'Note'].map(esc).join(','),
        [headline.emailsSent, headline.boundPremiumPer1k ?? '', headline.commissionPer1k ?? '',
          headline.note].map(esc).join(','));

      for (const f of funnels) {
        lines.push('', `${f.label} funnel — ${f.status}`,
          ['Stage', 'Count', 'Measured against', 'Rate %'].map(esc).join(','),
          ...f.rungs.map((r) => [
            r.label, f.started ? r.count : '',
            f.rungs.find((x) => x.key === r.of)?.label ?? '',
            r.rate ?? '',
          ].map(esc).join(',')));
        if (f.extras.length) {
          lines.push(['Measure', 'Value'].map(esc).join(','),
            ...f.extras.map((e) => [e.label, e.value ?? ''].map(esc).join(',')));
        }
      }

      lines.push('', 'Cross-channel — the decision view',
        ['Channel', 'Contacts', 'Quotes', 'Binds', 'Bound premium', 'Commission', 'Cost',
          'Cost per contact', 'Cost per quote', 'Cost per bind'].map(esc).join(','),
        ...crossChannel.map((r) => [
          r.channel, r.contacts, r.quotes, r.binds, r.boundPremium ?? '', r.commission ?? '',
          r.costTotal ?? '', r.costPerContact ?? '', r.costPerQuote ?? '', r.costPerBind ?? '',
        ].map(esc).join(',')));

      lines.push('', 'Response time (engagement to first call)',
        ['Leads measured', 'Median minutes', 'Mean minutes', 'Slowest minutes',
          'Within 15 min %', 'Note'].map(esc).join(','),
        [responseTime.measured, responseTime.medianMinutes ?? '', responseTime.meanMinutes ?? '',
          responseTime.slowestMinutes ?? '', responseTime.withinSlaPct ?? '',
          responseTime.note].map(esc).join(','));

      lines.push('', 'Deliverability by sending mailbox (last 7 days)',
        ['Mailbox', 'Sent', 'Bounces', 'Bounce %', 'Complaints', 'Complaint %',
          'Unsubscribes', 'Unsub %'].map(esc).join(','),
        ...(deliverability.length
          ? deliverability.map((d) => [d.mailbox, d.sent, d.bounces, d.bounceRate ?? '',
            d.complaints, d.complaintRate ?? '', d.unsubscribes, d.unsubRate ?? ''].map(esc).join(','))
          : ['(nothing sent in the last 7 days)']));

      lines.push('', `Band accuracy by ${data.bandAccuracy.by}`,
        ['Cut', 'Quoted', 'Inside at quote', 'Accuracy at quote %', 'Bound', 'Inside at bind',
          'Accuracy at bind %', 'Avg variance vs midpoint %'].map(esc).join(','),
        ...(data.bandAccuracy.cuts.length
          ? data.bandAccuracy.cuts.map((b) => [b.cut, b.quoted, b.insideAtQuote,
            b.accuracyAtQuote ?? '', b.bound, b.insideAtBind, b.accuracyAtBind ?? '',
            b.avgVarianceVsMidpointPct ?? ''].map(esc).join(','))
          : ['(nothing quoted against a published band yet)']));

      lines.push('',
        `Lost analysis — ${data.losses.totalLosses} loss(es), ${data.losses.missingCompetitor} without a competitor premium`,
        ['Carrier', 'Losses', 'With premium', 'Avg gap', 'Avg gap %', 'Reasons',
          'Municipalities'].map(esc).join(','),
        ...(data.losses.rows.length
          ? data.losses.rows.map((l) => [l.carrier, l.losses, l.withPremium, l.avgGap ?? '',
            l.avgGapPct ?? '',
            Object.entries(l.byReason).map(([k, v]) => `${k} (${v})`).join('; '),
            l.municipalities.join('; ')].map(esc).join(','))
          : ['(nothing lost to a named carrier yet)']));
    }
    const blob = new Blob([lines.join('\n')], { type: 'text/csv;charset=utf-8;' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = `outreach-dashboard-${new Date().toISOString().slice(0, 10)}.csv`;
    a.click();
    URL.revokeObjectURL(a.href);
  }, [data]);

  return (
    <Container maxWidth={false} sx={{ py: 3 }}>
      <Stack direction="row" spacing={1} sx={{ alignItems: 'center', mb: 0.5 }}>
        <InsightsIcon color="primary" />
        <Typography variant="h5" sx={{ fontWeight: 700 }}>Outreach dashboard</Typography>
      </Stack>
      <Typography variant="body2" color="text.secondary" sx={{ mb: 2 }}>
        Grade A at pull through to bound, with the guardrails that govern whether sending
        continues. Every target below is from the KPI Tracker (v12 Target Model).
      </Typography>

      <Paper variant="outlined" sx={{ p: 2, mb: 2 }}>
        <Stack direction={{ xs: 'column', sm: 'row' }} spacing={2} sx={{ alignItems: { sm: 'center' }, flexWrap: 'wrap' }}>
          {/*
            Bounded by the weeks the database actually holds, so the picker cannot offer a
            year the book has never seen. The bounds arrive with the data; until then the
            inputs are simply unbounded rather than guessing.
          */}
          <TextField
            label="Renewal week from" type="date" size="small" value={effFrom}
            onChange={(e) => setEffFrom(e.target.value)}
            slotProps={{
              inputLabel: { shrink: true },
              htmlInput: { min: dateMin, max: dateMax },
            }}
          />
          <TextField
            label="Renewal week to" type="date" size="small" value={effTo}
            onChange={(e) => setEffTo(e.target.value)}
            slotProps={{
              inputLabel: { shrink: true },
              htmlInput: { min: dateMin, max: dateMax },
            }}
          />
          {customRange && (
            <Typography variant="caption" color="text.secondary">
              Showing the dates above.
            </Typography>
          )}
          {/* Back to no range and the programme window — the screen's resting state. */}
          <Button
            size="small"
            onClick={() => { setEffFrom(''); setEffTo(''); setScope('programme'); }}
          >
            Reset
          </Button>
          <Box sx={{ flexGrow: 1 }} />
          <Button
            size="small" variant="outlined" startIcon={<DownloadIcon />}
            onClick={exportCsv} disabled={!data}
          >
            Export CSV
          </Button>
        </Stack>
      </Paper>

      {error && <Alert severity="error" sx={{ mb: 2 }}>{error}</Alert>}
      {loading && <Box sx={{ display: 'flex', justifyContent: 'center', py: 4 }}><CircularProgress /></Box>}

      {data && !loading && (
        <>
          {/*
            One banner, at the top, instead of a "not started" note on eight rows. Before
            the first send the bottom of the funnel is unmeasured, and saying that once is
            clearer than saying it repeatedly in smaller type.
          */}
          {/*
            Say which weeks are on screen, and name what is not.

            The default is the honest view — unfiltered, coverage reads 48.7% "below floor"
            because it includes weeks pulled before outreach existed. But a default that
            quietly dropped a week that was pulled and never prepared would be the worse
            failure of the two, so the excluded weeks are counted and shown.
          */}
          {data.defaultedRange && data.window && (
            <Alert severity="success" icon={<FilterAltIcon />} sx={{ mb: 2 }}>
              <b>Showing the outreach programme.</b>{' '}{data.window.reason}
              {data.excluded && (
                <Box component="span" sx={{ display: 'block', mt: 0.5 }}>
                  Not shown: {data.excluded.cohorts} earlier or later week
                  {data.excluded.cohorts === 1 ? '' : 's'} holding{' '}
                  <b>{fmtNum(data.excluded.worked)}</b> Grade A cards, of which{' '}
                  <b>{fmtNum(data.excluded.withEmail)}</b> have an insured email
                  {data.excluded.withEmail === 0 && ' — none of them was prepared for outreach'}
                  .{' '}
                  <Button
                    size="small"
                    onClick={() => setScope('all')}
                    sx={{ textTransform: 'none', p: 0, minWidth: 0, verticalAlign: 'baseline' }}
                  >
                    Show them too
                  </Button>
                </Box>
              )}
            </Alert>
          )}

          {/*
            The other half of the same choice.
            
            This used to be a Programme / All weeks toggle in the toolbar, and twice it was
            read as two unexplained words. The scope never needed a control of its own: the
            only reason to widen the range is the sentence above saying what is missing, so
            the action belongs in that sentence, and the way back belongs here.
          */}
          {!data.defaultedRange && !customRange && scope === 'all' && (
            <Alert severity="info" icon={<FilterAltIcon />} sx={{ mb: 2 }}>
              <b>Showing every renewal week.</b>{' '}This includes weeks pulled before outreach
              began, which were never skip traced — so email coverage reads far lower here
              than it does for the weeks actually being worked.{' '}
              <Button
                size="small"
                onClick={() => setScope('programme')}
                sx={{ textTransform: 'none', p: 0, minWidth: 0, verticalAlign: 'baseline' }}
              >
                Back to the outreach weeks
              </Button>
            </Alert>
          )}

          {!data.outreachStarted && (
            <Alert severity="info" icon={<PauseCircleOutlineIcon />} sx={{ mb: 2 }}>
              <b>Outreach has not started.</b>{' '}Nothing has been sent yet, so every stage from
              &ldquo;People emailed&rdquo; down is unmeasured rather than zero. The stages above
              it are live, and they are what the go/no-go gate is read from.
            </Alert>
          )}

          {/* ── The funnel ─────────────────────────────────────────────────── */}
          <Paper variant="outlined" sx={{ mb: 2 }}>
            <Box sx={{ px: 2, pt: 2, pb: 1 }}>
              <Typography variant="subtitle1" sx={{ fontWeight: 700 }}>The funnel</Typography>
              <Typography variant="caption" color="text.secondary">
                Each rate is measured against the stage named beside it — never against the top
                of the funnel. Quoting one denominator as another is discrepancy D2 in the log.
              </Typography>
            </Box>
            <Divider />
            {/* Eight columns of counts, rates, targets and floors. Wider than a phone, so it
                scrolls within the card and the stage name stays pinned — a rate with no stage
                beside it is exactly the confusion the caption above warns about. */}
            <Box sx={scrollableTable}>
            <Table size="small" sx={stickyFirstColumn}>
              <TableHead>
                <TableRow>
                  <ColumnHeader
                    label="Stage"
                    help="One step of the journey, from the leads we pulled down to the policies bound. Each step is a subset of the one above it."
                  />
                  <ColumnHeader
                    label="Count" align="right"
                    help="How many leads or people reached this step. A dash means the step has not started yet, which is not the same as zero."
                  />
                  <ColumnHeader
                    label="Share" width="22%"
                    help="The bar draws this step against the widest one, so where the drop-off happens is visible without reading the numbers."
                  />
                  <ColumnHeader
                    label="Rate" align="right"
                    help="This step as a percentage of the step named in the next column, never as a percentage of the top of the funnel."
                  />
                  <ColumnHeader
                    label="of"
                    help="Which step the rate is measured against. A percentage only means something against its own starting point, so each one names it."
                  />
                  <ColumnHeader
                    label="Target" align="right"
                    help="Where we expect this rate to land, taken from the KPI Tracker."
                  />
                  <ColumnHeader
                    label="Floor" align="right"
                    help="The lowest acceptable figure. Below the floor the plan needs revisiting, not just watching."
                  />
                  <ColumnHeader
                    label="Status"
                    help="On plan, below target, or below floor. Not started means nothing has happened at this step yet, so there is nothing to judge."
                  />
                </TableRow>
              </TableHead>
              <TableBody>
                {data.funnel.map((s: FunnelStage) => {
                  const v = verdictOf(s.rate, s.target, s.floor, 'higher', s.started);
                  const ofLabel = data.funnel.find((x) => x.key === s.of)?.label ?? '';
                  return (
                    <TableRow key={s.key} hover>
                      <TableCell sx={{ fontSize: 13, fontWeight: 600 }}>
                        {/*
                          Tagged because this exact text also appears one row down in the
                          "of" column, as that row's denominator. Without a way to tell the
                          two apart a test for "the stage is present" passes on the echo.
                        */}
                        <span data-testid="funnel-stage">{s.label}</span>
                        {s.note && (
                          <Tooltip title={s.note}>
                            <Typography component="span" sx={{ ml: 0.75, fontSize: 11, color: '#6b7280', cursor: 'help' }}>
                              ⓘ
                            </Typography>
                          </Tooltip>
                        )}
                      </TableCell>
                      <TableCell align="right" sx={{ fontSize: 13, fontWeight: 700 }}>
                        {s.started ? fmtNum(s.count) : '—'}
                      </TableCell>
                      <TableCell>
                        {/*
                          Width against the widest rung, not against the stage above, so the
                          bars narrow monotonically down the ladder and the drop-off is the
                          thing the eye lands on.
                        */}
                        <LinearProgress
                          variant="determinate"
                          value={s.started ? Math.min(100, (s.count / maxCount) * 100) : 0}
                          sx={{
                            height: 8, borderRadius: 1, backgroundColor: '#eef0f3',
                            '& .MuiLinearProgress-bar': { backgroundColor: VERDICT_COLOUR[v] },
                          }}
                        />
                      </TableCell>
                      <TableCell align="right" sx={{ fontSize: 13, fontWeight: 700, color: VERDICT_COLOUR[v] }}>
                        {s.started ? fmtPct(s.rate) : '—'}
                      </TableCell>
                      <TableCell sx={{ fontSize: 12, color: '#6b7280' }}>{ofLabel || '—'}</TableCell>
                      <TableCell align="right" sx={{ fontSize: 12 }}>{fmtPct(s.target)}</TableCell>
                      <TableCell align="right" sx={{ fontSize: 12 }}>{fmtPct(s.floor)}</TableCell>
                      <TableCell>
                        {/*
                          The top rung has no denominator, so there is nothing for a status
                          to be a status OF. It rendered an empty "—" chip, which reads as a
                          verdict that failed to compute rather than as one that cannot exist.
                        */}
                        {s.of === null ? null : s.started ? (
                          <Chip
                            size="small"
                            label={VERDICT_LABEL[v]}
                            sx={{
                              height: 20, fontSize: 11, fontWeight: 700,
                              color: VERDICT_COLOUR[v], borderColor: VERDICT_COLOUR[v],
                            }}
                            variant="outlined"
                          />
                        ) : (
                          <Chip size="small" label="Not started" variant="outlined"
                            sx={{ height: 20, fontSize: 11, color: '#6b7280' }} />
                        )}
                      </TableCell>
                    </TableRow>
                  );
                })}
              </TableBody>
            </Table>
            </Box>
          </Paper>

          {/* ── Guardrails ─────────────────────────────────────────────────── */}
          <Paper variant="outlined" sx={{ mb: 2 }}>
            <Box sx={{ px: 2, pt: 2, pb: 1 }}>
              <Typography variant="subtitle1" sx={{ fontWeight: 700 }}>Guardrails</Typography>
              <Typography variant="caption" color="text.secondary">
                The rules that stop a send rather than describe it. A guardrail with no
                measurement yet says so — it does not read as passing. Deliverability
                thresholds are playbook §08 and are enforced by the system, not by this
                screen; it reports what that service reads.
              </Typography>
            </Box>
            <Divider />
            {/* Same treatment as the funnel: the guardrail's name stays pinned while the
                reading, target, floor and pause rule scroll past it. */}
            <Box sx={scrollableTable}>
            <Table size="small" sx={stickyFirstColumn}>
              <TableHead>
                <TableRow>
                  <ColumnHeader
                    label="Guardrail"
                    help="A rule that can stop a send, rather than a number that only describes one. The period each is measured over is printed underneath its name."
                  />
                  <ColumnHeader
                    label="Now" align="right"
                    help="Where this figure stands today. A dash means there is nothing to measure yet, not that the figure is zero."
                  />
                  <ColumnHeader
                    label="Target" align="right"
                    help="Where we want this to be."
                  />
                  <ColumnHeader
                    label="Pauses at" align="right"
                    help="The figure at which sending stops. Deliberately separate from the target: a campaign sitting exactly on this line has not met its goal, it has reached the limit."
                  />
                  <ColumnHeader
                    label="Status"
                    help="Pass, watch, off plan, or no target set. PAUSE means the rule has fired and sending should stop."
                  />
                  <ColumnHeader
                    label="Pause rule"
                    help="What actually happens when the threshold is crossed."
                  />
                  <ColumnHeader
                    label="How it is measured"
                    help="The exact definition behind the number, so it can be checked rather than taken on trust."
                  />
                </TableRow>
              </TableHead>
              <TableBody>
                {data.guardrails.map((g: Guardrail) => {
                  /**
                   * A fired pause rule outranks the target comparison entirely. §08
                   * enforces `breached` by pausing the campaign, so the screen must not
                   * soften it into "below target" because the generic verdict said so.
                   */
                  const v: Verdict = g.breached
                    ? 'bad'
                    : verdictOf(g.value, g.target, null, g.direction, g.started);
                  // These two are headcounts, not rates — no % suffix on either.
                  const isCount = g.key === 'not_loaded' || g.key === 'gained';
                  return (
                    <TableRow key={g.key} hover>
                      <TableCell sx={{ fontSize: 13, fontWeight: 600 }}>
                        {g.label}
                        {/*
                          The period, under every row. Retention and coverage follow the
                          renewal weeks selected above; the §08 deliverability guards are a
                          rolling window across all sending. Two different periods in one
                          table is fine — leaving which is which unsaid is not.
                        */}
                        <Typography sx={{ display: 'block', fontSize: 11, color: '#6b7280', fontWeight: 400 }}>
                          {g.scope}
                        </Typography>
                        {g.needsAttention && (
                          <Typography sx={{ display: 'block', fontSize: 11, color: '#8a5a00', fontWeight: 600, mt: 0.25 }}>
                            {g.needsAttention}
                          </Typography>
                        )}
                      </TableCell>
                      <TableCell align="right" sx={{ fontSize: 13, fontWeight: 700, color: VERDICT_COLOUR[v] }}>
                        {!g.started ? '—' : isCount ? fmtNum(g.value ?? 0) : fmtPct(g.value)}
                      </TableCell>
                      <TableCell align="right" sx={{ fontSize: 12 }}>
                        {g.target == null ? '—' : isCount ? fmtNum(g.target) : fmtPct(g.target)}
                      </TableCell>
                      {/*
                        The number that stops a send, in its own column. It was previously
                        folded into "target", which reported a campaign sitting exactly on
                        the pause line as having met its goal.
                      */}
                      <TableCell align="right" sx={{ fontSize: 12, color: g.pauseAt == null ? 'inherit' : '#8a5a00' }}>
                        {g.pauseAt == null ? '—' : fmtPct(g.pauseAt)}
                      </TableCell>
                      <TableCell>
                        {g.started ? (
                          <Chip
                            size="small" variant="outlined"
                            icon={v === 'none' ? undefined
                              : v === 'ok'
                                ? <CheckCircleOutlineIcon sx={{ fontSize: 14 }} />
                                : <WarningAmberIcon sx={{ fontSize: 14 }} />}
                            label={g.breached ? 'PAUSE' : GUARDRAIL_LABEL[v]}
                            sx={{ height: 20, fontSize: 11, fontWeight: 700, color: VERDICT_COLOUR[v], borderColor: VERDICT_COLOUR[v] }}
                          />
                        ) : (
                          <Chip size="small" label="Not measured yet" variant="outlined"
                            sx={{ height: 20, fontSize: 11, color: '#6b7280' }} />
                        )}
                      </TableCell>
                      <TableCell sx={{ fontSize: 12, color: g.pause ? '#8a5a00' : '#6b7280' }}>
                        {g.pause ?? '—'}
                      </TableCell>
                      <TableCell sx={{ fontSize: 12, color: '#6b7280' }}>{g.definition}</TableCell>
                    </TableRow>
                  );
                })}
              </TableBody>
            </Table>
            </Box>
          </Paper>

          {/* ── Per renewal week ───────────────────────────────────────────── */}
          <Paper variant="outlined" sx={{ mb: 2, overflowX: 'auto' }}>
            <Box sx={{ px: 2, pt: 2, pb: 1 }}>
              <Typography variant="subtitle1" sx={{ fontWeight: 700 }}>By renewal week</Typography>
              <Typography variant="caption" color="text.secondary">
                The same ladder per cohort, so a week that is drifting shows up before the
                average hides it.
              </Typography>
            </Box>
            <Divider />
            <Table size="small" stickyHeader>
              <TableHead>
                <TableRow>
                  {COHORT_COLUMNS.map((c) => (
                    <ColumnHeader
                      key={c.header}
                      label={c.header}
                      help={c.help}
                      align={c.numeric ? 'right' : 'left'}
                    />
                  ))}
                </TableRow>
              </TableHead>
              <TableBody>
                {data.byCohort.map((r) => (
                  <TableRow key={r.cohort} hover>
                    {COHORT_COLUMNS.map((c) => {
                      const val = c.value(r);
                      return (
                        <TableCell
                          key={c.header}
                          align={c.numeric ? 'right' : 'left'}
                          sx={{
                            fontSize: 12,
                            whiteSpace: c.header === 'Renewal week' ? 'nowrap' : undefined,
                            fontWeight: ['Renewal week', 'Grade A at pull', 'Kept', 'Worked', 'Bound'].includes(c.header) ? 700 : 400,
                            color: c.numeric && val === 0 ? '#9ca3af' : 'inherit',
                          }}
                        >
                          {c.numeric ? fmtNum(Number(val)) : (val || '—')}
                        </TableCell>
                      );
                    })}
                  </TableRow>
                ))}
              </TableBody>
            </Table>
            <Box sx={{ p: 1.5, borderTop: '1px solid #e6e8eb' }}>
              <Typography variant="caption" color="text.secondary">
                Built {new Date(data.generatedAt).toLocaleString()}. Counts are live — Grade A
                moves as producers work the cards, so a figure quoted from this screen should
                carry the time it was read at.
              </Typography>
            </Box>
          </Paper>

          {/*
            The rest of Sec 10.7: the three channel funnels, the cross-channel decision
            view, response time, deliverability per mailbox, band accuracy and lost
            analysis. Everything above this point answers "is the list ready to send";
            everything below answers "how is each channel doing".
          */}
          {data.channels && (
            <ChannelSections
              channels={data.channels}
              bandAccuracy={data.bandAccuracy}
              losses={data.losses}
            />
          )}
        </>
      )}
    </Container>
  );
}
