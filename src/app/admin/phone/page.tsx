'use client';

import React, { useCallback, useEffect, useRef, useState } from 'react';
import {
  Container, Box, Typography, Paper, Button, Chip, Table, TableHead, TableRow,
  TableCell, TableBody, CircularProgress, Alert, Stack, Tooltip, TextField,
  MenuItem, LinearProgress,
} from '@mui/material';
import PhoneIcon from '@mui/icons-material/Phone';
import DownloadIcon from '@mui/icons-material/Download';
import Link from 'next/link';
import CallReminderList from '@/components/CallReminderList';
import Tabs from '@mui/material/Tabs';
import Tab from '@mui/material/Tab';
import { useStickyState } from '@/hooks/useStickyState';
import { stickyFirstColumn, scrollableTable } from '@/lib/stickyColumn';
/**
 * Type-only. The service reads @/lib/neon, and a value import would pull the database
 * client into this bundle — the failure the outreach page documents.
 */
import type { PhoneDashboard } from '@/services/phoneDashboard.service';

/**
 * The phone outreach dashboard (Frank, 25 Sep 2026).
 *
 * "Mirror email outreach dashboard; filter by cohort, date, and no-verified-email accounts
 *  ... C1-C3 total rated = 178, Total verified Insured email = 106, Non-verified = 72. We
 *  call these first and as soon as ready."
 *
 * ── Why it is a queue and not a report ──────────────────────────────────────
 * The email dashboard answers "how is the campaign doing". This answers "who does Ruben ring
 * next", and that is a list in an order, not a set of rates. The rates are here because
 * Frank will want them, but the table is the product.
 */

const COHORTS: Array<[string, string]> = [
  ['2026-10-05', 'C1 · 5 Oct'],
  ['2026-10-12', 'C2 · 12 Oct'],
  ['2026-10-19', 'C3 · 19 Oct'],
  ['2026-10-26', 'C4 · 26 Oct'],
  ['2026-11-02', 'C5 · 2 Nov'],
  ['2026-11-09', 'C6 · 9 Nov'],
  ['2026-11-16', 'C7 · 16 Nov'],
];

const STATUSES: Array<[string, string]> = [
  ['all', 'Any status'],
  ['not_attempted', 'Not attempted'],
  ['attempting', 'Attempting'],
  ['callback_due', 'Callback due'],
  ['quoting', 'Quoting'],
  ['not_interested', 'Not interested'],
  ['do_not_call', 'Do not call'],
  ['unreachable', 'Unreachable'],
];

export default function PhoneDashboardPage() {
  const [data, setData] = useState<PhoneDashboard | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const [cohortFrom, setCohortFrom] = useStickyState('phone:from', '2026-10-05');
  const [cohortTo, setCohortTo] = useStickyState('phone:to', '2026-10-19');
  /** Defaults to the call-first list, because that is what this page is for. */
  const [reach, setReach] = useStickyState('phone:reach', 'unverified');
  const [status, setStatus] = useStickyState('phone:status', 'all');

  /**
   * ── Only the newest request is allowed to paint ──────────────────────────
   *
   * Frank Aug-2026 asked that filters survive leaving the page, and useStickyState does
   * keep them — but it restores in an effect, so every visit mounts with the DEFAULTS,
   * fires a request for those, then restores the saved filters and fires a second one.
   * Two are in flight, and whichever answers last wins. On a slow first and a fast second
   * the dropdowns read C7 · Everyone rated while the numbers underneath are C1–C3 ·
   * unverified — which looks exactly like the filters having reset themselves.
   *
   * A counter rather than a ref per filter: this page has four, and the cohorts screen
   * guarded only its grade for the same reason and left its two date fields exposed. One
   * counter covers every filter there will ever be.
   */
  const wanted = useRef(0);

  const load = useCallback(async () => {
    const mine = ++wanted.current;
    setLoading(true); setError(null);
    try {
      const u = new URL('/api/admin/phone-dashboard', window.location.origin);
      u.searchParams.set('cohortFrom', cohortFrom);
      u.searchParams.set('cohortTo', cohortTo);
      u.searchParams.set('reach', reach);
      u.searchParams.set('status', status);
      const j = await (await fetch(u.toString())).json();
      // A newer request has been sent since this one left. Its answer is the one that
      // matches what is on screen, so this reply is discarded rather than painted.
      if (mine !== wanted.current) return;
      if (!j.success) throw new Error(j.error || 'Could not load');
      setData(j as PhoneDashboard);
    } catch (e) {
      if (mine !== wanted.current) return;
      setError(e instanceof Error ? e.message : 'Could not load');
    } finally {
      if (mine === wanted.current) setLoading(false);
    }
  }, [cohortFrom, cohortTo, reach, status]);

  useEffect(() => { load(); }, [load]);

  const exportCsv = () => {
    if (!data) return;
    const cols = ['cohort', 'propertyId', 'owner', 'address', 'renewal', 'premium',
      'verifiedEmail', 'numbers', 'callableNumbers', 'dncNumbers', 'deadNumbers', 'reserveNumbers', 'callStatus',
      'attempts', 'attemptsToCoInsured', 'reachedVia',
      'coInsuredName', 'coInsuredNumbers', 'coInsuredLive', 'insuredLive'];
    const esc = (v: unknown) => `"${String(v ?? '').replace(/"/g, '""')}"`;
    const csv = [
      cols.map(esc).join(','),
      ...data.queue.map((q) => [
        q.cohortLabel, q.propertyId, q.owner, q.address, q.renewal, q.premium ?? '',
        q.verified ? 'yes' : 'no', q.numbers, q.callable, q.dncNumbers, q.deadNumbers, q.reserveNumbers,
        q.callStatusLabel, q.attempts,
      ].map(esc).join(',')),
    ].join('\r\n');
    const a = document.createElement('a');
    a.href = URL.createObjectURL(new Blob([csv], { type: 'text/csv' }));
    a.download = `phone-queue-${cohortFrom}-to-${cohortTo}.csv`;
    a.click();
  };

  /**
   * ── Two screens, not one column ─────────────────────────────────────────
   *
   * The call list and the reminders are different jobs. The list is "who do I ring next",
   * worked top to bottom; the reminders are "who did I promise to ring back", and they
   * arrive out of order. Stacked, the reminders pushed the filters and the queue down the
   * page on a screen somebody spends the whole shift in.
   *
   * Kept in sessionStorage rather than component state alone: opening a lead from the
   * reminders tab and coming back should return to the reminders, not to the call list.
   * Session rather than local, because the default view of this page is the call queue.
   */
  const [tab, setTab] = useStickyState<'queue' | 'reminders'>('phone:tab', 'queue');
  const [dueCount, setDueCount] = useState(0);

  return (
    <Container maxWidth="xl" sx={{ py: 3 }}>
      <Stack direction="row" spacing={1.5} sx={{ alignItems: 'center', mb: 0.5 }}>
        <PhoneIcon sx={{ color: '#1565c0' }} />
        <Typography variant="h5" sx={{ fontWeight: 800 }}>Phone outreach</Typography>
      </Stack>
      <Typography variant="body2" sx={{ color: '#5a6675', mb: 2 }}>
        Who to ring next, and how far through the list we are. Rated accounts only — an
        unrated one has no band price to talk about.
      </Typography>

      <Tabs
        value={tab}
        onChange={(_, v) => setTab(v)}
        sx={{ mb: 2, borderBottom: '1px solid #e3e6ea', minHeight: 40, '& .MuiTab-root': { minHeight: 40, textTransform: 'none', fontWeight: 700 } }}
      >
        <Tab value="queue" label="Call list" />
        <Tab
          value="reminders"
          label={
            /*
              The due count rides on the tab, because that is the whole risk of splitting
              these onto two screens: a reminder falling due while somebody is working the
              call list would otherwise be invisible until they thought to look. The toast
              still fires from anywhere; this is the standing count beside it.

              A Chip in the flow rather than a <Badge>. A badge is absolutely positioned
              outside its child, so on a tab it sat half over the edge and was clipped — the
              count read as a red smudge. This one takes its own space and cannot be cut off.
            */
            <Stack direction="row" spacing={0.75} sx={{ alignItems: 'center' }}>
              <span>Reminders</span>
              {dueCount > 0 && (
                <Box
                  component="span"
                  sx={{
                    bgcolor: '#b3261e', color: '#fff', fontSize: 11, fontWeight: 700,
                    lineHeight: '18px', minWidth: 18, px: 0.5, borderRadius: '9px',
                    textAlign: 'center',
                  }}
                >
                  {dueCount}
                </Box>
              )}
            </Stack>
          }
        />
      </Tabs>

      {/*
        Mounted on BOTH tabs and hidden with CSS rather than unmounted.
        Unmounting would restart its poll and lose the log's open/closed state every time
        somebody switched tabs — and it is what keeps dueCount current for the badge above,
        which has to stay right while the call list is the one on screen.
      */}
      <Box sx={{ display: tab === 'reminders' ? 'block' : 'none' }}>
        <CallReminderList onCounts={(c) => setDueCount(c.due)} />
      </Box>

      <Box sx={{ display: tab === 'queue' ? 'block' : 'none' }}>

      {/* ── Filters ── */}
      <Paper variant="outlined" sx={{ p: 2, mb: 2 }}>
        <Stack direction="row" spacing={1.5} sx={{ flexWrap: 'wrap', gap: 1.5, alignItems: 'center' }}>
          <TextField select size="small" label="From week" value={cohortFrom}
            onChange={(e) => setCohortFrom(e.target.value)} sx={{ minWidth: 150 }}>
            {COHORTS.map(([v, l]) => <MenuItem key={v} value={v}>{l}</MenuItem>)}
          </TextField>
          <TextField select size="small" label="To week" value={cohortTo}
            onChange={(e) => setCohortTo(e.target.value)} sx={{ minWidth: 150 }}>
            {COHORTS.map(([v, l]) => <MenuItem key={v} value={v}>{l}</MenuItem>)}
          </TextField>
          <TextField select size="small" label="Email reach" value={reach}
            onChange={(e) => setReach(e.target.value)} sx={{ minWidth: 220 }}
            helperText="Who email cannot reach is who the phone is for">
            <MenuItem value="unverified">No verified email — call first</MenuItem>
            <MenuItem value="verified">Has a verified email</MenuItem>
            <MenuItem value="all">Everyone rated</MenuItem>
          </TextField>
          <TextField select size="small" label="Call status" value={status}
            onChange={(e) => setStatus(e.target.value)} sx={{ minWidth: 170 }}>
            {STATUSES.map(([v, l]) => <MenuItem key={v} value={v}>{l}</MenuItem>)}
          </TextField>
          <Button variant="outlined" size="small" startIcon={<DownloadIcon />}
            onClick={exportCsv} disabled={!data?.queue.length}>
            Export
          </Button>
        </Stack>
      </Paper>

      {loading && <LinearProgress sx={{ mb: 2 }} />}
      {error && <Alert severity="error" sx={{ mb: 2 }}>{error}</Alert>}

      {data && (
        <>
          {/*
            The verification caveat, stated before the numbers rather than under them.

            Until a run lands, "verified" is zero and every rated account reads as
            call-first. That is the truth, but it looks like a catastrophic finding unless
            the reason is said first.
          */}
          {!data.verificationRun && (
            <Alert severity="info" sx={{ mb: 2 }}>
              No email verification has been imported yet, so nothing counts as verified and
              every rated account appears in the call-first list. These numbers become
              meaningful once the ZeroBounce results are in.
            </Alert>
          )}

          {/* ── Frank's three numbers ── */}
          <Stack direction="row" spacing={2} sx={{ mb: 2, flexWrap: 'wrap', gap: 2 }}>
            {[
              { label: 'Rated accounts', value: data.rated,
                help: 'Grade A with a producer-entered premium, in the selected weeks.' },
              { label: 'Verified email', value: data.verifiedEmail,
                help: 'An insured address a verifier confirmed exists. Email can reach these.' },
              { label: 'No verified email', value: data.nonVerified,
                help: 'Email cannot reach these. They are the reason this page exists.' },
              { label: 'Nothing works', value: data.unreachableAnyChannel,
                help: 'No verified email AND no callable number. Direct mail or nothing.' },
            ].map((c) => (
              <Tooltip key={c.label} arrow title={c.help}>
                <Paper variant="outlined" sx={{ p: 2, minWidth: 170, cursor: 'help' }}>
                  <Typography variant="caption" sx={{ color: '#5a6675', display: 'block' }}>{c.label}</Typography>
                  <Typography variant="h4" sx={{ fontWeight: 800 }}>{c.value.toLocaleString()}</Typography>
                </Paper>
              </Tooltip>
            ))}
          </Stack>

          {/* ── Progress through the list ── */}
          <Paper variant="outlined" sx={{ p: 2, mb: 2 }}>
            <Typography variant="subtitle2" sx={{ fontWeight: 700, mb: 1.5 }}>How far through</Typography>
            <Stack direction="row" spacing={3} sx={{ flexWrap: 'wrap', gap: 2 }}>
              {data.funnel.map((r) => (
                <Tooltip key={r.key} arrow title={r.note ?? ''}>
                  <Box sx={{ cursor: r.note ? 'help' : 'default' }}>
                    <Typography variant="caption" sx={{ color: '#5a6675', display: 'block' }}>{r.label}</Typography>
                    <Typography variant="h6" sx={{ fontWeight: 700 }}>{r.count.toLocaleString()}</Typography>
                  </Box>
                </Tooltip>
              ))}
            </Stack>
          </Paper>

          {/* ── Per week ── */}
          <Paper variant="outlined" sx={{ p: 2, mb: 2 }}>
            <Typography variant="subtitle2" sx={{ fontWeight: 700, mb: 1 }}>By renewal week</Typography>
            {/* Seven columns do not fit a phone. The table scrolls inside this box rather
                than pushing the whole page sideways, and the week stays pinned so a row
                keeps its name while the figures move. */}
            <Box sx={{ ...scrollableTable, mx: -2, px: 2 }}>
            <Table size="small" sx={stickyFirstColumn}>
              <TableHead>
                <TableRow>
                  {['Week', 'Rated', 'Verified email', 'To call', 'Called', 'Reached', 'No numbers'].map((h) => (
                    <TableCell key={h} sx={{ fontWeight: 700, fontSize: 12 }}
                      align={h === 'Week' ? 'left' : 'right'}>{h}</TableCell>
                  ))}
                </TableRow>
              </TableHead>
              <TableBody>
                {data.byCohort.map((c) => (
                  <TableRow key={c.cohort} hover>
                    <TableCell sx={{ fontWeight: 700 }}>{c.label}</TableCell>
                    <TableCell align="right">{c.rated}</TableCell>
                    <TableCell align="right">{c.verified || '—'}</TableCell>
                    <TableCell align="right" sx={{ fontWeight: 700 }}>{c.nonVerified}</TableCell>
                    <TableCell align="right">{c.called || '—'}</TableCell>
                    <TableCell align="right">{c.reached || '—'}</TableCell>
                    <TableCell align="right" sx={{ color: c.noNumbers ? '#b3261e' : undefined }}>
                      {c.noNumbers || '—'}
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
            </Box>
          </Paper>

          {/* ── The queue ── */}
          <Paper variant="outlined" sx={{ p: 2 }}>
            <Typography variant="subtitle2" sx={{ fontWeight: 700, mb: 0.5 }}>
              The call list
              <Box component="span" sx={{ fontWeight: 400, color: '#5a6675', ml: 0.75 }}>
                — never called first, then most live numbers, then soonest renewal
              </Box>
            </Typography>
            {/* The call list is the widest table on the screen. Same treatment: it scrolls
                on its own, and the renewal week stays pinned so Ruben can read across a row
                without losing which one he is on. */}
            <Box sx={{ ...scrollableTable, mx: -2, px: 2 }}>
            <Table size="small" sx={stickyFirstColumn}>
              <TableHead>
                <TableRow>
                  {[
                    ['Week', 'Which renewal week.'],
                    ['Owner', 'Click through to the card to dial and log.'],
                    ['Address', ''],
                    ['Renews', 'Sooner renewals are more urgent.'],
                    ['Premium', 'What the producer rated it at.'],
                    ['Numbers', 'Callable / total on the card. The gap is do-not-call flags.'],
                    ['Status', 'What the last call that reached somebody produced.'],
                    ['Attempts', ''],
                  ].map(([h, help]) => (
                    <TableCell key={h} sx={{ fontWeight: 700, fontSize: 12, whiteSpace: 'nowrap' }}>
                      {help ? (
                        <Tooltip arrow title={help}>
                          <span style={{ cursor: 'help', borderBottom: '1px dotted #b9c0cc' }}>{h}</span>
                        </Tooltip>
                      ) : h}
                    </TableCell>
                  ))}
                </TableRow>
              </TableHead>
              <TableBody>
                {data.queue.slice(0, 300).map((q) => (
                  <TableRow key={q.propertyId} hover>
                    <TableCell>{q.cohortLabel}</TableCell>
                    <TableCell>
                      <Link href={`/leads/${q.propertyId}?from=phone`} style={{ color: '#1565c0', textDecoration: 'none' }}>
                        {q.owner}
                      </Link>
                    </TableCell>
                    <TableCell sx={{ fontSize: 12, color: '#5a6675' }}>{q.address}</TableCell>
                    <TableCell sx={{ fontSize: 12 }}>{q.renewal}</TableCell>
                    <TableCell sx={{ fontSize: 12 }}>{q.premium ? `$${q.premium}` : '—'}</TableCell>
                    <TableCell>
                      {/*
                        Worth ringing, out of held — and the tooltip says what the gap is.

                        The left-hand figure used to subtract only do-not-call numbers, so
                        it still counted numbers Ruben had already logged as dead. Two C1
                        cards showed live numbers with nothing dialable at all, and this
                        column also orders the list, so those sorted to the top.
                      */}
                      <Tooltip arrow title={[
                        `${q.callable} of ${q.numbers} worth ringing`,
                        // Whose they are. "7 worth ringing" reads as seven ways to reach
                        // the homeowner; on 66 accounts every one of them is the
                        // co-insured's and the insured cannot be rung at all.
                        q.coInsuredLive
                          ? `${q.insuredLive} the insured's, ${q.coInsuredLive} the co-insured's`
                            + (q.coInsuredName ? ` (${q.coInsuredName})` : '')
                          : null,
                        q.dncNumbers ? `${q.dncNumbers} on the do-not-call list` : null,
                        q.deadNumbers ? `${q.deadNumbers} already logged as a bad number or wrong person` : null,
                        q.reserveNumbers
                          ? `${q.reserveNumbers} held in reserve — deep in the vendor's list, where nobody has yet reached anyone`
                          : null,
                      ].filter(Boolean).join(' · ')}>
                        <span style={{ cursor: 'help', fontWeight: 700, color: q.callable ? undefined : '#b3261e' }}>
                          {q.callable}/{q.numbers}
                          {q.coInsuredLive > 0 && (
                            <span style={{ color: '#6b4e00', fontWeight: 400, fontSize: 11 }}>
                              {' '}({q.insuredLive === 0 ? 'all co' : `${q.coInsuredLive} co`})
                            </span>
                          )}
                        </span>
                      </Tooltip>
                    </TableCell>
                    <TableCell>
                      <Chip size="small" label={q.callStatusLabel}
                        sx={{
                          height: 19, fontSize: 11, fontWeight: 700,
                          bgcolor: q.callStatus === 'quoting' ? '#e7f5ec'
                            : q.callStatus === 'callback_due' ? '#e8f0fe'
                              : q.callStatus === 'do_not_call' || q.callStatus === 'unreachable' ? '#fdecea'
                                : '#eef1f5',
                        }} />
                    </TableCell>
                    {/*
                      Attempts, and how many were to somebody other than the insured.

                      "5 attempts" reads as five calls to the homeowner. On Allyssa
                      Townsend one of them was to the co-insured, which is a different
                      conversation and a different person to ask for. The split was
                      recorded on every attempt and shown nowhere.
                    */}
                    <TableCell align="right" sx={{ fontSize: 12, whiteSpace: 'nowrap' }}>
                      <Tooltip arrow title={[
                        `${q.attempts} attempt${q.attempts === 1 ? '' : 's'}`,
                        q.coInsuredAttempts ? `${q.coInsuredAttempts} to the co-insured` : null,
                        q.reachedVia ? `reached on the ${q.reachedVia === 'co_insured' ? 'co-insured' : 'insured'}'s number` : null,
                      ].filter(Boolean).join(' · ')}>
                        <span style={{ cursor: q.attempts ? 'help' : 'default' }}>
                          {q.attempts || '—'}
                          {q.coInsuredAttempts > 0 && (
                            <span style={{ color: '#6b4e00', fontSize: 11 }}> · {q.coInsuredAttempts} co</span>
                          )}
                          {q.reachedVia === 'co_insured' && (
                            <span style={{ color: '#166534', fontSize: 11, fontWeight: 700 }}> ✓co</span>
                          )}
                        </span>
                      </Tooltip>
                    </TableCell>
                  </TableRow>
                ))}
                {!data.queue.length && (
                  <TableRow>
                    <TableCell colSpan={8} sx={{ textAlign: 'center', py: 4, color: '#888' }}>
                      Nothing matches those filters.
                    </TableCell>
                  </TableRow>
                )}
              </TableBody>
            </Table>
            </Box>
            {data.queue.length > 300 && (
              <Typography variant="caption" sx={{ color: '#5a6675', mt: 1, display: 'block' }}>
                Showing the first 300 of {data.queue.length}. Export for the rest.
              </Typography>
            )}
          </Paper>

          {/*
            ── The co-insured, on its own (Frank, 7 Oct 2026) ──────────────────

            Mixed into the main list this is invisible: a card reading "7 worth ringing"
            says nothing about whose numbers they are, and 66 accounts have NO live
            number for the insured at all — the co-insured is the only way in and the
            list gave no sign of it.

            Ordered by what is owed rather than by name: the accounts reachable only
            through the co-insured come first, never-called before called, then most
            numbers. That is the same logic as the main list, applied to this question.
          */}
          {(() => {
            /*
             * Everyone with a second person on the policy we have actually worked —
             * not only those who still have a number on the card.
             *
             * Filtering on coInsuredNumbers alone dropped 5 cards where the co-insured
             * WAS rung and the number was then retired as dead or a wrong person. Those
             * are 5 real calls Ruben made, and leaving them out both understated the
             * work and hid the answer: we tried her, that line is no good.
             */
            const withCo = data.queue.filter((q) => q.coInsuredName && (q.coInsuredNumbers > 0 || q.coInsuredAttempts > 0));
            if (!withCo.length) return null;
            const onlyCo = withCo.filter((q) => q.insuredLive === 0 && q.coInsuredLive > 0);
            const calls = withCo.reduce((a, q) => a + q.coInsuredAttempts, 0);
            // Every figure in the strip describes the rows underneath it, so this counts
            // the same population the table lists rather than the whole queue.
            const reached = withCo.filter((q) => q.reachedVia === 'co_insured').length;
            const rows = [...withCo].sort((a, b) =>
              Number(b.insuredLive === 0) - Number(a.insuredLive === 0)
              || Number(a.coInsuredAttempts > 0) - Number(b.coInsuredAttempts > 0)
              || b.coInsuredLive - a.coInsuredLive);

            return (
              <Paper variant="outlined" sx={{ p: 2, mt: 2 }}>
                <Typography sx={{ fontWeight: 700, fontSize: 15, mb: 0.25 }}>
                  The co-insured
                </Typography>
                <Typography variant="caption" sx={{ color: '#5a6675', display: 'block', mb: 1.5 }}>
                  The spouse or co-owner on the policy. Their numbers are on the card and are
                  rung like any other — this is the same work, counted separately so it can be
                  judged on its own.
                </Typography>

                <Stack direction="row" spacing={2} sx={{ mb: 2, flexWrap: 'wrap' }} useFlexGap>
                  {[
                    { label: 'Accounts with a co-insured number', value: withCo.length },
                    { label: 'Where they are the only way in', value: onlyCo.length, warn: true },
                    { label: 'Calls made to a co-insured', value: calls },
                    { label: 'Households reached that way', value: reached, good: true },
                  ].map((s) => (
                    <Box key={s.label} sx={{
                      px: 1.75, py: 1, borderRadius: 1, minWidth: 150,
                      border: '1px solid', borderColor: s.warn ? '#e0b84c' : s.good ? '#9bd4b0' : '#e0e4ea',
                      bgcolor: s.warn ? '#fdf7e7' : s.good ? '#f2faf5' : '#fff',
                    }}>
                      <Typography sx={{ fontSize: 22, fontWeight: 700, lineHeight: 1.1 }}>{s.value}</Typography>
                      <Typography sx={{ fontSize: 11, color: '#5a6675' }}>{s.label}</Typography>
                    </Box>
                  ))}
                </Stack>

                <Box sx={scrollableTable}>
                  <Table size="small">
                    <TableHead>
                      <TableRow>
                        {['Week', 'Insured', 'Co-insured', 'Their numbers', 'Insured numbers',
                          'Calls to them', 'Reached', 'Status'].map((h) => (
                          <TableCell key={h} sx={{ fontWeight: 700, fontSize: 12, whiteSpace: 'nowrap' }}>{h}</TableCell>
                        ))}
                      </TableRow>
                    </TableHead>
                    <TableBody>
                      {rows.slice(0, 300).map((q) => (
                        <TableRow key={q.propertyId} hover>
                          <TableCell sx={{ fontSize: 12 }}>{q.cohortLabel}</TableCell>
                          <TableCell sx={{ fontSize: 12 }}>
                            <Link href={`/leads/${q.propertyId}?from=phone`} style={{ color: '#1565c0', textDecoration: 'none' }}>
                              {q.owner}
                            </Link>
                          </TableCell>
                          <TableCell sx={{ fontSize: 12, fontWeight: 600 }}>{q.coInsuredName ?? '—'}</TableCell>
                          <TableCell sx={{ fontSize: 12, fontVariantNumeric: 'tabular-nums' }}>
                            {q.coInsuredNumbers === 0
                              ? <span style={{ color: '#8a8f98' }} title="Every number we had for them has been retired as dead or a wrong person.">all dead</span>
                              : <>{q.coInsuredLive}/{q.coInsuredNumbers}</>}
                          </TableCell>
                          {/* Zero here is the point of the table: nobody else to ring. */}
                          <TableCell sx={{
                            fontSize: 12, fontVariantNumeric: 'tabular-nums',
                            color: q.insuredLive === 0 ? '#b3261e' : undefined,
                            fontWeight: q.insuredLive === 0 ? 700 : undefined,
                          }}>
                            {q.insuredLive === 0 ? 'none' : q.insuredLive}
                          </TableCell>
                          <TableCell sx={{ fontSize: 12, fontVariantNumeric: 'tabular-nums' }}>
                            {q.coInsuredAttempts || '—'}
                          </TableCell>
                          <TableCell>
                            {q.reachedVia === 'co_insured' && (
                              <Chip label="on their number" size="small"
                                sx={{ height: 19, fontSize: 11, fontWeight: 700, bgcolor: '#e7f5ec', color: '#166534' }} />
                            )}
                          </TableCell>
                          <TableCell sx={{ fontSize: 12 }}>{q.callStatusLabel}</TableCell>
                        </TableRow>
                      ))}
                    </TableBody>
                  </Table>
                </Box>
                {rows.length > 300 && (
                  <Typography variant="caption" sx={{ color: '#5a6675', mt: 1, display: 'block' }}>
                    Showing the first 300 of {rows.length}. Export for the rest.
                  </Typography>
                )}
              </Paper>
            );
          })()}
        </>
      )}
      {!loading && !data && !error && <CircularProgress />}
      </Box>
    </Container>
  );
}
