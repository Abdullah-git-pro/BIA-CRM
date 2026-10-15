'use client';

import React, { useCallback, useEffect, useRef, useState } from 'react';
import {
  Container, Box, Typography, Paper, Table, TableHead, TableRow, TableCell, TableBody,
  CircularProgress, Alert, Stack, Button, LinearProgress, Tooltip, ToggleButton,
  ToggleButtonGroup, Dialog, DialogTitle, DialogContent, DialogContentText, DialogActions,
} from '@mui/material';
import RefreshIcon from '@mui/icons-material/Refresh';
import { useRouter } from 'next/navigation';
import WarningAmberIcon from '@mui/icons-material/WarningAmber';

/**
 * The data pipeline, by cohort (Frank, 13 Oct 2026).
 *
 *     REAPI (the pull) → WIIP (the tax roll) → skip trace
 *
 * Frank's condition for agreeing to the new cadence was being able to see where a batch is
 * without asking: "before we do a mass whip, we need to understand how this functionality is
 * now working". This is that screen.
 *
 * ── Why "traced before the roll" is red and not grey ────────────────────────
 * A cohort can show every lead traced and still be the problem. 300 Grade A leads were skip
 * traced while the roll had never been consulted — searched for under a name nobody had
 * checked, which is exactly how the flipped-name card reached the meeting. Those are not
 * progress, so they are never counted inside the traced bar; they sit beside it as a
 * warning, because a full green bar over that population would be a lie.
 *
 * ── What this screen can start, and what it cannot ──────────────────────────
 * Two stages have buttons, one cohort at a time:
 *
 *   Run the roll        free — it asks municipal services, so never the whole book at once
 *   Verify contacts     charged per lookup — counts them and asks before spending anything
 *
 * The skip trace has no button and the endpoint refuses it. It is 15 credits a lead and it
 * is the one step that can be wrong in a way money cannot undo: a trace run on an unchecked
 * name buys the wrong person's details. It stays a deliberate run.
 *
 * Nothing here runs over more than one cohort either. Abdullah, 13 Oct: "Will do cohort by
 * cohort not once in all" — a single click that spends a five-figure budget is the thing
 * this shape exists to prevent.
 */

type Phase = 'pulled' | 'roll' | 'tracing' | 'complete';

type Cohort = {
  cohort: string; code: string | null; label: string; endsOn: string | null;
  grade: string; phase: Phase; total: number;
  rollChecked: number; rollMatch: number; rollPartial: number; rollMismatch: number;
  rollNotFound: number; rollAmbiguous: number; rollNeedsReview: number;
  coMatch: number; coNoneOnRoll: number; coNeedsReview: number;
  traced: number; tracedBeforeRoll: number;
  contactsCards: number; contactsNotTheirs: number;
};

type Totals = {
  total: number; rollChecked: number; rollNeedsReview: number;
  coNeedsReview: number; traced: number; tracedBeforeRoll: number;
  contactsCards: number; contactsNotTheirs: number;
};

const PHASE_LABEL: Record<Phase, string> = {
  pulled: 'Pulled — roll not run',
  roll: 'Checking the roll',
  tracing: 'Skip tracing',
  complete: 'Complete',
};

const PHASE_COLOR: Record<Phase, string> = {
  pulled: '#9aa4b2',
  roll: '#2a6fd6',
  tracing: '#c98a00',
  complete: '#16794c',
};

const TONE = {
  good: '#16794c',
  warn: '#b4690e',
  bad: '#c5221f',
  muted: '#9aa4b2',
} as const;

/**
 * A bar that reports its own denominator — a bare percentage hides how big the job is.
 *
 * The fraction sits BESIDE the bar rather than under it, and the percentage is gone. Three
 * stacked lines per cell was what made every row a different height, and the percentage was
 * the least useful of the three: nobody acts on 78%, they act on "40 left".
 */
function Bar({ done, total, color = '#2a6fd6' }: { done: number; total: number; color?: string }) {
  const pct = total > 0 ? Math.round((done / total) * 100) : 0;
  return (
    <Stack direction="row" sx={{ alignItems: 'center', gap: 1 }}>
      <LinearProgress
        variant="determinate"
        value={Math.min(100, pct)}
        sx={{ width: 54, height: 5, borderRadius: 3, flexShrink: 0,
          bgcolor: '#e9edf3', '& .MuiLinearProgress-bar': { backgroundColor: color } }}
      />
      <Box sx={{ fontSize: 12, color: '#4a5568', fontVariantNumeric: 'tabular-nums', whiteSpace: 'nowrap' }}>
        <Box component="span" sx={{ fontWeight: 700, color: '#1a2230' }}>{done.toLocaleString()}</Box>
        {' / '}{total.toLocaleString()}
      </Box>
    </Stack>
  );
}

/**
 * One line of a breakdown: a right-aligned number, then its label.
 *
 * Every breakdown renders the same lines in the same order whether or not the count is zero,
 * which is the whole point. The chips these replaced wrapped differently on every row — C8
 * put "2 not on roll" on a second line while C7 fitted three across — so the eye could not
 * run down a column and compare, and no two rows were the same height. A zero shows as a
 * muted dash rather than vanishing, because a column that keeps its shape can be read at a
 * glance and one that reflows cannot.
 */
/** One button shape for the row actions, so the two never sit at different heights. */
const BTN = { fontSize: 11.5, py: 0.4, textTransform: 'none', fontWeight: 600, whiteSpace: 'nowrap' } as const;
/** The metered action: distinguishable from the free one, without shouting. */
const BTN_PAID = {
  ...BTN,
  color: '#5b3fa8', borderColor: '#cfc3ea', bgcolor: '#faf8ff',
  '&:hover': { borderColor: '#5b3fa8', bgcolor: '#f3eeff' },
} as const;

/** The stage captions in the upper header row. */
const STAGE_HEAD = {
  fontSize: 10.5, fontWeight: 700, letterSpacing: 0.7, textTransform: 'uppercase',
  color: '#8a94a6', whiteSpace: 'nowrap',
} as const;

/** The rule that marks where one stage's columns end and the next begin. */
const GROUP_EDGE = { borderLeft: '1px solid #e2e8f0' } as const;

function Line({ n, label, tone = 'muted', title }: {
  n: number; label: string; tone?: keyof typeof TONE; title?: string;
}) {
  const body = (
    <Stack direction="row" sx={{ alignItems: 'baseline', gap: 0.75, lineHeight: 1.45 }}>
      <Box sx={{ width: 26, textAlign: 'right', fontSize: 12.5, fontWeight: 700,
        fontVariantNumeric: 'tabular-nums', color: n ? TONE[tone] : '#c3cad4' }}>
        {n || '–'}
      </Box>
      <Box sx={{ fontSize: 11.5, color: n ? '#5a6675' : '#b4bcc7', whiteSpace: 'nowrap' }}>{label}</Box>
    </Stack>
  );
  return title ? <Tooltip title={title} placement="right"><span>{body}</span></Tooltip> : body;
}

export default function PipelinePage() {
  const router = useRouter();
  const [grade, setGrade] = useState('A');
  const [cohorts, setCohorts] = useState<Cohort[]>([]);
  const [totals, setTotals] = useState<Totals | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  /** Only the newest load may write: a superseded request must not paint a stale error. */
  const seqRef = useRef(0);

  /**
   * The cohort currently being run, and how far through it is.
   *
   * A roll lookup costs seconds, not milliseconds, so a cohort takes minutes and the person
   * who clicked needs to see it moving or they will click again. `stop` is a ref rather than
   * state because the loop reads it between chunks and must see the latest value, not the
   * one captured when the loop started.
   */
  const [running, setRunning] = useState<
    { cohort: string; stage: 'roll' | 'contacts'; done: number; total: number } | null
  >(null);
  const stopRef = useRef(false);

  /**
   * The quote: what the contact check would cost, before it is allowed to cost it.
   *
   * Abdullah's rule from 13 Oct is that nothing spends credits without permission, and a
   * button labelled "verify" over a cohort of 159 cards is not permission — the person
   * clicking it has no way to know whether that is 40 lookups or 600. So the click asks the
   * endpoint with dry=1, which counts the work without doing any of it, and the number goes
   * in front of them in a dialog they have to answer. Only that answer starts the run.
   */
  const [quote, setQuote] = useState<
    { cohort: string; label: string; pending: number; numbers: number; emails: number } | null
  >(null);
  const [quoting, setQuoting] = useState<string | null>(null);

  const load = useCallback(async (g: string) => {
    const seq = ++seqRef.current;
    setLoading(true);
    setError(null);
    try {
      const res = await fetch(`/api/admin/pipeline?grade=${encodeURIComponent(g)}`);
      const json = await res.json();
      if (!res.ok) throw new Error(json.error || 'Could not load the pipeline');
      if (seq !== seqRef.current) return;
      setCohorts(json.cohorts ?? []);
      setTotals(json.totals ?? null);
    } catch (err) {
      if (seq !== seqRef.current) return;
      setError(err instanceof Error ? err.message : 'Something went wrong');
    } finally {
      if (seq === seqRef.current) setLoading(false);
    }
  }, []);

  useEffect(() => { load(grade); }, [grade, load]);

  /**
   * Run the tax-roll stage over one cohort, a few leads per request.
   *
   * The loop lives here rather than on the server because a cohort of 159 cannot finish
   * inside a serverless budget — each chunk is its own request and the endpoint is
   * resumable, so closing the tab stops the run rather than breaking it. Nothing is lost:
   * every lead's verdict is written as it is decided.
   */
  const runStage = useCallback(async (
    stage: 'roll' | 'contacts',
    cohort: string,
    total: number,
  ) => {
    stopRef.current = false;
    setRunning({ cohort, stage, done: 0, total });
    setError(null);
    try {
      let guard = 0;
      for (;;) {
        if (stopRef.current) break;
        // A ceiling on iterations, not on leads: a bug that stopped `remaining` falling
        // would otherwise hammer the municipal roll — or the metered provider — until
        // somebody noticed.
        if (++guard > 2000) throw new Error('Stopped after 2,000 chunks — something is not finishing.');
        const chunk = stage === 'contacts' ? 15 : 3;
        const res = await fetch(
          `/api/admin/pipeline/run?cohort=${encodeURIComponent(cohort)}&grade=${grade}&stage=${stage}&chunk=${chunk}`,
          { method: 'POST' },
        );
        const json = await res.json();
        if (!res.ok) throw new Error(json.error || 'The run failed');
        setRunning((r) => (r ? { ...r, done: r.done + (json.processed ?? 0), total: r.done + (json.processed ?? 0) + (json.remaining ?? 0) } : r));
        /**
         * A used-up allowance stops the run and says so.
         *
         * When the trial ran out mid-batch every remaining lookup came back 429, and a loop
         * that kept going would have written 201 numbers off as unverifiable when the truth
         * was that we had stopped being allowed to ask.
         */
        if (json.quota) throw new Error('The verification allowance is used up — the rest of the cohort was left unchecked, not marked bad.');
        if (json.done || !json.processed) break;
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : 'The run failed');
    } finally {
      setRunning(null);
      load(grade);
    }
  }, [grade, load]);

  /** Ask what the contact check would cost over one cohort. Spends nothing. */
  const askContacts = useCallback(async (cohort: string, label: string) => {
    setQuoting(cohort);
    setError(null);
    try {
      const res = await fetch(
        `/api/admin/pipeline/run?cohort=${encodeURIComponent(cohort)}&grade=${grade}&stage=contacts&dry=1`,
        { method: 'POST' },
      );
      const json = await res.json();
      if (!res.ok) throw new Error(json.error || 'Could not count the lookups');
      setQuote({
        cohort, label,
        pending: json.pending ?? 0, numbers: json.numbers ?? 0, emails: json.emails ?? 0,
      });
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not count the lookups');
    } finally {
      setQuoting(null);
    }
  }, [grade]);

  return (
    <Container maxWidth="xl" sx={{ py: 4 }}>
      <Box sx={{ mb: 3 }}>
        <Typography variant="h4" component="h1" sx={{ fontWeight: 'bold', mb: 0.5 }}>
          Data pipeline
        </Typography>
        <Typography variant="body2" color="text.secondary">
          Where each renewal week stands: pulled from the property API → checked against the
          municipal tax roll → skip traced on the checked name
        </Typography>
      </Box>

      <Stack direction="row" sx={{ alignItems: 'center', gap: 1.5, mb: 2, flexWrap: 'wrap' }}>
        <ToggleButtonGroup
          size="small" exclusive value={grade}
          onChange={(_e, v) => { if (v) setGrade(v); }}
        >
          {['A', 'B', 'C', 'D'].map((g) => (
            <ToggleButton key={g} value={g} sx={{ px: 2 }}>Grade {g}</ToggleButton>
          ))}
        </ToggleButtonGroup>
        <Button size="small" variant="outlined" startIcon={<RefreshIcon />} onClick={() => load(grade)} disabled={loading}>
          Refresh
        </Button>
        {loading && <CircularProgress size={16} />}
      </Stack>

      {error && <Alert severity="error" sx={{ mb: 2 }}>{error}</Alert>}

      {/*
        The one number that a progress bar cannot say: cards that are "done" the wrong way
        round. Shown above the table because it is a fact about the book, not about one week.
      */}
      {!!totals?.tracedBeforeRoll && (
        <Alert severity="warning" icon={<WarningAmberIcon />} sx={{ mb: 2 }}>
          <strong>{totals.tracedBeforeRoll.toLocaleString()}</strong> Grade {grade} leads were
          skip traced before the tax roll was ever consulted — searched for under a name
          nobody had checked. They read as traced, but they were done under the old order.
        </Alert>
      )}

      {/*
        One strip, not six floating cards.

        The four progress counts read left to right in the order the work happens, and the
        two "needs a person" counts are separated off to the right, because they are the only
        two that are asking somebody to do something.
      */}
      {totals && (
        <Paper variant="outlined" sx={{ mb: 2, display: 'flex', flexWrap: 'wrap',
          borderColor: '#e4e9f0', overflow: 'hidden' }}>
          {[
            { label: 'Leads in the book', value: totals.total, of: null },
            { label: 'Checked on the roll', value: totals.rollChecked, of: totals.total },
            { label: 'Skip traced', value: totals.traced, of: totals.total },
            { label: 'Contacts checked', value: totals.contactsCards, of: totals.total },
            { label: 'Roll needs a person', value: totals.rollNeedsReview, of: null, warn: true, split: true },
            { label: 'Co-insured needs a person', value: totals.coNeedsReview, of: null, warn: true },
          ].map((s) => (
            <Box key={s.label} sx={{
              px: 2.5, py: 1.5, flex: '1 1 150px',
              borderLeft: '1px solid #eef1f5',
              ...(s.split ? { ml: 'auto', borderLeft: '2px solid #e4e9f0' } : {}),
              '&:first-of-type': { borderLeft: 'none' },
            }}>
              <Box sx={{ display: 'flex', alignItems: 'baseline', gap: 0.75 }}>
                <Typography sx={{ fontSize: 23, fontWeight: 700, lineHeight: 1.1,
                  fontVariantNumeric: 'tabular-nums',
                  color: s.warn ? (s.value ? TONE.warn : '#c3cad4') : '#1a2230' }}>
                  {s.value.toLocaleString()}
                </Typography>
                {s.of != null && (
                  <Typography sx={{ fontSize: 12, color: '#9aa4b2', fontVariantNumeric: 'tabular-nums' }}>
                    / {s.of.toLocaleString()}
                  </Typography>
                )}
              </Box>
              <Typography sx={{ fontSize: 11.5, color: '#5a6675', mt: 0.25 }}>{s.label}</Typography>
            </Box>
          ))}
        </Paper>
      )}

      <Paper variant="outlined" sx={{ overflowX: 'auto' }}>
        <Table size="small" stickyHeader sx={{
          '& td': { borderColor: '#eef1f5', py: 1.25 },
          '& tbody tr:hover': { bgcolor: '#f7f9fc' },
          /**
           * The stage groups are drawn as column rules, not left to the caption's position.
           *
           * A caption sitting above the first column of a three-column span tells you nothing
           * about where the span ends — "2 · Tax roll" read as a label for "Checked" alone,
           * and the gaps between captions looked like a mistake. Ruling the boundaries makes
           * the grouping visible in every row rather than only in the header.
           */
          [`& td:nth-of-type(3), & td:nth-of-type(6),
            & td:nth-of-type(7), & td:nth-of-type(8)`]: { borderLeft: '1px solid #eef1f5' },
        }}>
          {/*
            Four stages across two header rows.

            Stage 1 is the REAPI pull, and its output is the lead count — so Week and Leads
            are captioned rather than left blank. Without it the header began at "2", which
            reads as a missing column rather than as a step that happens elsewhere.
          */}
          <TableHead>
            <TableRow sx={{ '& th': { bgcolor: '#f4f6f9', borderBottom: 'none', pt: 1.25, pb: 0.25 } }}>
              <TableCell colSpan={2} sx={STAGE_HEAD}>1 · The pull</TableCell>
              <TableCell colSpan={3} sx={{ ...STAGE_HEAD, ...GROUP_EDGE }}>2 · Tax roll</TableCell>
              <TableCell sx={{ ...STAGE_HEAD, ...GROUP_EDGE }}>3 · Skip trace</TableCell>
              <TableCell sx={{ ...STAGE_HEAD, ...GROUP_EDGE }}>4 · Contacts</TableCell>
              <TableCell sx={GROUP_EDGE} />
            </TableRow>
            <TableRow sx={{ '& th': { bgcolor: '#f4f6f9', fontWeight: 600, fontSize: 11.5,
              color: '#4a5568', whiteSpace: 'nowrap', pt: 0.25, pb: 1.25,
              borderBottom: '1px solid #dde3ec' } }}>
              <TableCell>Week</TableCell>
              <TableCell align="right">Leads</TableCell>
              <TableCell sx={GROUP_EDGE}>Checked</TableCell>
              <TableCell>The insured</TableCell>
              <TableCell>The co-insured</TableCell>
              <TableCell sx={GROUP_EDGE}>Traced</TableCell>
              <TableCell sx={GROUP_EDGE}>Identity checked</TableCell>
              <TableCell sx={GROUP_EDGE} />
            </TableRow>
          </TableHead>
          <TableBody>
            {cohorts.map((c) => {
              const pc = PHASE_COLOR[c.phase];
              return (
                <TableRow
                  key={c.cohort}
                  hover
                  // The whole row, not just the week: every cell raises the same question —
                  // which of them — and the answer is one page away.
                  onClick={() => router.push(`/admin/pipeline/${c.cohort}?grade=${grade}`)}
                  sx={{ cursor: 'pointer' }}
                >
                  {/*
                    The phase is a dot beside the week, not a column of its own.

                    It was a wide chip saying "Checking the roll" on seven rows out of eight
                    — a column's width spent on a word the progress bars next to it already
                    said. As a dot it still answers "where is this one" at a glance and
                    costs nothing.
                  */}
                  <TableCell sx={{ whiteSpace: 'nowrap' }}>
                    <Stack direction="row" sx={{ alignItems: 'center', gap: 1 }}>
                      <Tooltip title={PHASE_LABEL[c.phase]}>
                        <Box sx={{ width: 8, height: 8, borderRadius: '50%', bgcolor: pc, flexShrink: 0 }} />
                      </Tooltip>
                      <Box>
                        <Box sx={{ fontWeight: 700, fontSize: 13.5, color: '#1565c0', lineHeight: 1.3 }}>
                          {c.code ?? c.cohort}
                        </Box>
                        <Box sx={{ fontSize: 11, color: '#8a94a6', lineHeight: 1.3 }}>{c.label}</Box>
                      </Box>
                    </Stack>
                  </TableCell>

                  <TableCell align="right" sx={{ fontWeight: 700, fontSize: 14,
                    fontVariantNumeric: 'tabular-nums' }}>
                    {c.total.toLocaleString()}
                  </TableCell>

                  <TableCell><Bar done={c.rollChecked} total={c.total} /></TableCell>

                  <TableCell>
                    {c.rollChecked === 0 ? <Box sx={{ color: '#c3cad4' }}>—</Box> : (
                      <Box>
                        <Line n={c.rollMatch} label="confirmed" tone="good"
                          title="The roll names the person on the card" />
                        <Line n={c.rollNeedsReview} label="to review" tone="warn"
                          title="Partial, mismatched or ambiguous — the roll could not settle it on its own" />
                        <Line n={c.rollNotFound} label="not on roll"
                          title="Every roll answered and none of them holds this address" />
                      </Box>
                    )}
                  </TableCell>

                  <TableCell>
                    {c.rollChecked === 0 ? <Box sx={{ color: '#c3cad4' }}>—</Box> : (
                      <Box>
                        <Line n={c.coMatch} label="named" tone="good"
                          title="The deed names a second owner and it matches the card" />
                        <Line n={c.coNoneOnRoll} label="none listed"
                          title="The roll lists a single owner — it names no co-insured, which is not the same as there being none" />
                        <Line n={c.coNeedsReview} label="to review" tone="warn"
                          title="The second name on the deed does not settle against the card" />
                      </Box>
                    )}
                  </TableCell>

                  <TableCell>
                    <Bar done={c.traced} total={c.total} />
                    {!!c.tracedBeforeRoll && (
                      <Tooltip title="Traced before the roll was consulted — the old order, on an unchecked name">
                        <Stack direction="row" sx={{ alignItems: 'center', gap: 0.5, mt: 0.5 }}>
                          <WarningAmberIcon sx={{ fontSize: 13, color: TONE.bad }} />
                          <Box sx={{ fontSize: 11.5, color: TONE.bad, fontWeight: 600, whiteSpace: 'nowrap' }}>
                            {c.tracedBeforeRoll} before the roll
                          </Box>
                        </Stack>
                      </Tooltip>
                    )}
                  </TableCell>

                  {/*
                    Cards graded, not contact points — and deliberately NOT a bar.

                    A card holds anything from one number to twenty-four, and it counts here
                    the moment one of them has a verdict. A bar would therefore run to full
                    while most of the cohort's numbers were still unchecked, which is the one
                    claim this column must not make. The honest count of what is left is the
                    lookup count, and that is asked for on demand — in the dialog, where it
                    is about to cost something.
                  */}
                  <TableCell>
                    {c.contactsCards === 0 ? <Box sx={{ color: '#c3cad4' }}>—</Box> : (
                      <Box>
                        <Tooltip title="Cards where at least one number or address has been put to the identity check. Not a completion bar: a card counts here as soon as one of its numbers has a verdict.">
                          <Box sx={{ fontSize: 12, color: '#4a5568', fontVariantNumeric: 'tabular-nums', whiteSpace: 'nowrap' }}>
                            <Box component="span" sx={{ fontWeight: 700, color: '#1a2230' }}>
                              {c.contactsCards.toLocaleString()}
                            </Box>
                            {' / '}{c.total.toLocaleString()} cards
                          </Box>
                        </Tooltip>
                        {!!c.contactsNotTheirs && (
                          <Tooltip title="Cards holding a number the provider says is not the insured's. Those numbers are withheld from dialling, not deleted.">
                            <Stack direction="row" sx={{ alignItems: 'center', gap: 0.5, mt: 0.5 }}>
                              <WarningAmberIcon sx={{ fontSize: 13, color: TONE.bad }} />
                              <Box sx={{ fontSize: 11.5, color: TONE.bad, fontWeight: 600, whiteSpace: 'nowrap' }}>
                                {c.contactsNotTheirs} with a bad number
                              </Box>
                            </Stack>
                          </Tooltip>
                        )}
                      </Box>
                    )}
                  </TableCell>

                  {/*
                    The two stages that can be started from here, and nothing else.

                    The roll spends nothing — but it leans on small municipal services, so it
                    is one cohort at a time and never the whole book. The contact check is
                    metered, so its button counts first and asks second.

                    The skip trace deliberately has none. It is the step that can be wrong in
                    a way money cannot undo, and it stays a deliberate run.

                    stopPropagation because the row itself navigates into the week; clicking
                    a button that also opens a page is how somebody starts a run by accident.
                  */}
                  <TableCell sx={{ whiteSpace: 'nowrap', width: 150 }} onClick={(e) => e.stopPropagation()}>
                    {running?.cohort === c.cohort ? (
                      <Stack direction="row" spacing={1} sx={{ alignItems: 'center', justifyContent: 'flex-end' }}>
                        <CircularProgress size={14} />
                        <Box sx={{ fontSize: 11.5, color: '#5a6675', fontVariantNumeric: 'tabular-nums' }}>
                          {running.stage === 'contacts' ? 'checking' : 'rolling'}{' '}
                          {running.done.toLocaleString()} of {running.total.toLocaleString()}
                        </Box>
                        <Button size="small" color="inherit" sx={BTN} onClick={() => { stopRef.current = true; }}>
                          Stop
                        </Button>
                      </Stack>
                    ) : (
                      <Stack spacing={0.5} sx={{ alignItems: 'stretch', width: 134, ml: 'auto' }}>
                        {c.rollChecked >= c.total ? (
                          <Box sx={{ fontSize: 11.5, color: '#9aa4b2', textAlign: 'center', py: 0.4 }}>
                            roll done
                          </Box>
                        ) : (
                          <Tooltip arrow placement="left" title={`Check the remaining ${(c.total - c.rollChecked).toLocaleString()} against the tax roll. No credits — this step is free. Keep this tab open while it runs.`}>
                            <span>
                              <Button
                                fullWidth size="small" variant="outlined" sx={BTN}
                                disabled={!!running || !!quoting}
                                onClick={() => runStage('roll', c.cohort, c.total - c.rollChecked)}
                              >
                                Run the roll
                              </Button>
                            </span>
                          </Tooltip>
                        )}
                        <Tooltip arrow placement="left" title="Put this week's numbers and email addresses to the identity check — the step C2 has already had. It will count the lookups and ask before spending anything.">
                          <span>
                            {/*
                              Outlined, not filled.

                              This is the button that spends money, and eight filled bars down
                              the right-hand side made the paid action the loudest thing on a
                              screen whose job is to be read. The gate is the dialog, not the
                              styling — but a metered action should not be the one the eye
                              lands on first either.
                            */}
                            <Button
                              fullWidth size="small" variant="outlined" sx={BTN_PAID}
                              disabled={!!running || !!quoting}
                              onClick={() => askContacts(c.cohort, c.code ?? c.cohort)}
                            >
                              {quoting === c.cohort ? 'Counting…' : 'Verify contacts'}
                            </Button>
                          </span>
                        </Tooltip>
                      </Stack>
                    )}
                  </TableCell>
                </TableRow>
              );
            })}
            {!cohorts.length && !loading && (
              <TableRow>
                <TableCell colSpan={9} sx={{ textAlign: 'center', py: 4, color: '#888' }}>
                  No cohorts at this grade.
                </TableCell>
              </TableRow>
            )}
          </TableBody>
        </Table>
      </Paper>

      {/*
        The cost, in front of the person about to spend it.

        It says the number of lookups and splits numbers from addresses, because those are
        two different jobs at the same price and somebody deciding whether 548 is worth it
        should be able to see that 302 of them are email. Already-graded contacts are not in
        the count — the endpoint skips them, so re-opening this dialog after a stopped run
        quotes only what is actually left.
      */}
      <Dialog open={!!quote} onClose={() => setQuote(null)} maxWidth="sm" fullWidth>
        <DialogTitle sx={{ fontWeight: 700 }}>
          Verify {quote?.label}&apos;s contacts?
        </DialogTitle>
        <DialogContent>
          <DialogContentText component="div">
            {quote?.pending === 0 ? (
              <Box>
                Nothing left to check — every number and address on this week&apos;s cards
                already has a verdict.
              </Box>
            ) : (
              <>
                <Box sx={{ fontSize: 15, mb: 1.5 }}>
                  This will make <strong>{quote?.pending.toLocaleString()}</strong> paid
                  lookups: <strong>{quote?.numbers.toLocaleString()}</strong> phone numbers
                  and <strong>{quote?.emails.toLocaleString()}</strong> email addresses.
                </Box>
                <Box sx={{ fontSize: 13.5, color: '#5a6675' }}>
                  Each one asks whether the contact point belongs to the person named on the
                  card. Numbers that come back as somebody else&apos;s are withheld from
                  dialling and shown as such — nothing is deleted. Contacts already checked
                  are skipped, so stopping and restarting costs nothing twice.
                </Box>
                <Box sx={{ fontSize: 13.5, color: '#5a6675', mt: 1 }}>
                  Keep this tab open while it runs. You can stop it at any point; every
                  verdict reached before you stop is kept.
                </Box>
              </>
            )}
          </DialogContentText>
        </DialogContent>
        <DialogActions>
          <Button color="inherit" onClick={() => setQuote(null)}>Cancel</Button>
          <Button
            variant="contained"
            disabled={!quote?.pending}
            onClick={() => {
              const q = quote;
              setQuote(null);
              if (q?.pending) runStage('contacts', q.cohort, q.pending);
            }}
          >
            Run {quote?.pending.toLocaleString()} lookups
          </Button>
        </DialogActions>
      </Dialog>
    </Container>
  );
}
