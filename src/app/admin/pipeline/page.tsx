'use client';

import React, { useCallback, useEffect, useRef, useState } from 'react';
import {
  Container, Box, Typography, Paper, Table, TableHead, TableRow, TableCell, TableBody,
  Chip, CircularProgress, Alert, Stack, Button, LinearProgress, Tooltip, ToggleButton,
  ToggleButtonGroup,
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
 * ── Nothing on this screen starts anything ──────────────────────────────────
 * No run buttons. The roll is a small municipal service and traces cost credits, and the
 * rule is that neither moves without somebody deciding. A screen built to be watched should
 * not also be the place a mass run is one mis-click away.
 */

type Phase = 'pulled' | 'roll' | 'tracing' | 'complete';

type Cohort = {
  cohort: string; code: string | null; label: string; endsOn: string | null;
  grade: string; phase: Phase; total: number;
  rollChecked: number; rollMatch: number; rollPartial: number; rollMismatch: number;
  rollNotFound: number; rollAmbiguous: number; rollNeedsReview: number;
  coMatch: number; coNoneOnRoll: number; coNeedsReview: number;
  traced: number; tracedBeforeRoll: number;
};

type Totals = {
  total: number; rollChecked: number; rollNeedsReview: number;
  coNeedsReview: number; traced: number; tracedBeforeRoll: number;
};

const PHASE_LABEL: Record<Phase, string> = {
  pulled: 'Pulled — roll not run',
  roll: 'Checking the roll',
  tracing: 'Skip tracing',
  complete: 'Complete',
};

const PHASE_COLOR: Record<Phase, { bg: string; fg: string }> = {
  pulled: { bg: '#f1f3f5', fg: '#5c6b78' },
  roll: { bg: '#e3f2fd', fg: '#1565c0' },
  tracing: { bg: '#fff3d6', fg: '#8a5a00' },
  complete: { bg: '#dcfce7', fg: '#166534' },
};

/** A bar that reports its own denominator — a bare percentage hides how big the job is. */
function Progress({ done, total, color }: { done: number; total: number; color?: string }) {
  const pct = total > 0 ? Math.round((done / total) * 100) : 0;
  return (
    <Box sx={{ minWidth: 120 }}>
      <Box sx={{ fontSize: 12, fontWeight: 700, lineHeight: 1.2 }}>{pct}%</Box>
      <LinearProgress
        variant="determinate"
        value={Math.min(100, pct)}
        sx={{ height: 6, borderRadius: 3, mt: 0.25,
          '& .MuiLinearProgress-bar': color ? { backgroundColor: color } : undefined }}
      />
      <Box sx={{ fontSize: 10, color: '#8a94a6', mt: 0.25 }}>
        {done.toLocaleString()} of {total.toLocaleString()}
      </Box>
    </Box>
  );
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

      {totals && (
        <Stack direction="row" spacing={2} sx={{ mb: 2, flexWrap: 'wrap', gap: 2 }}>
          {[
            { label: 'Leads in the book', value: totals.total },
            { label: 'Checked on the roll', value: totals.rollChecked },
            { label: 'Skip traced', value: totals.traced },
            { label: 'Roll needs a person', value: totals.rollNeedsReview, warn: true },
            { label: 'Co-insured needs a person', value: totals.coNeedsReview, warn: true },
          ].map((s) => (
            <Paper key={s.label} variant="outlined" sx={{ px: 2, py: 1.25, minWidth: 170 }}>
              <Typography sx={{ fontSize: 24, fontWeight: 700, lineHeight: 1.1,
                color: s.warn && s.value ? '#8a5a00' : undefined }}>
                {s.value.toLocaleString()}
              </Typography>
              <Typography variant="caption" sx={{ color: '#5a6675' }}>{s.label}</Typography>
            </Paper>
          ))}
        </Stack>
      )}

      <Paper variant="outlined" sx={{ overflowX: 'auto' }}>
        <Table size="small" stickyHeader>
          <TableHead>
            <TableRow>
              {['Week', 'Phase', 'Leads', '2 · Tax roll', 'Roll outcome', 'Co-insured', '3 · Skip trace']
                .map((h) => (
                  <TableCell key={h} sx={{ fontWeight: 700, whiteSpace: 'nowrap' }}>{h}</TableCell>
                ))}
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
                  <TableCell sx={{ whiteSpace: 'nowrap' }}>
                    <Box sx={{ fontWeight: 700, fontSize: 13, color: '#1565c0' }}>{c.code ?? c.cohort}</Box>
                    <Box sx={{ fontSize: 11, color: '#8a94a6' }}>{c.label}</Box>
                  </TableCell>
                  <TableCell>
                    <Chip label={PHASE_LABEL[c.phase]} size="small"
                      sx={{ height: 20, fontSize: 11, bgcolor: pc.bg, color: pc.fg, fontWeight: 600 }} />
                  </TableCell>
                  <TableCell sx={{ fontWeight: 700 }}>{c.total.toLocaleString()}</TableCell>
                  <TableCell><Progress done={c.rollChecked} total={c.total} /></TableCell>
                  <TableCell sx={{ fontSize: 12, whiteSpace: 'nowrap' }}>
                    {c.rollChecked === 0 ? <span style={{ color: '#8a94a6' }}>—</span> : (
                      <Stack direction="row" spacing={0.5} sx={{ flexWrap: 'wrap', gap: 0.5 }}>
                        <Chip size="small" label={`${c.rollMatch} confirmed`} sx={{ height: 19, fontSize: 10.5, bgcolor: '#e7f5ec', color: '#166534' }} />
                        {!!c.rollNeedsReview && (
                          <Tooltip title="Partial, mismatched or ambiguous — the roll could not settle it on its own">
                            <Chip size="small" label={`${c.rollNeedsReview} to review`} sx={{ height: 19, fontSize: 10.5, bgcolor: '#fff3d6', color: '#8a5a00' }} />
                          </Tooltip>
                        )}
                        {!!c.rollNotFound && (
                          <Tooltip title="Every roll answered and none of them holds this address">
                            <Chip size="small" variant="outlined" label={`${c.rollNotFound} not on roll`} sx={{ height: 19, fontSize: 10.5 }} />
                          </Tooltip>
                        )}
                      </Stack>
                    )}
                  </TableCell>
                  <TableCell sx={{ fontSize: 12, whiteSpace: 'nowrap' }}>
                    {c.rollChecked === 0 ? <span style={{ color: '#8a94a6' }}>—</span> : (
                      <Stack direction="row" spacing={0.5} sx={{ flexWrap: 'wrap', gap: 0.5 }}>
                        <Chip size="small" label={`${c.coMatch} named`} sx={{ height: 19, fontSize: 10.5, bgcolor: '#e7f5ec', color: '#166534' }} />
                        {!!c.coNoneOnRoll && (
                          <Tooltip title="The roll lists a single owner — it names no co-insured, which is not the same as there being none">
                            <Chip size="small" variant="outlined" label={`${c.coNoneOnRoll} none listed`} sx={{ height: 19, fontSize: 10.5 }} />
                          </Tooltip>
                        )}
                        {!!c.coNeedsReview && (
                          <Chip size="small" label={`${c.coNeedsReview} to review`} sx={{ height: 19, fontSize: 10.5, bgcolor: '#fff3d6', color: '#8a5a00' }} />
                        )}
                      </Stack>
                    )}
                  </TableCell>
                  <TableCell>
                    <Progress done={c.traced} total={c.total} />
                    {!!c.tracedBeforeRoll && (
                      <Tooltip title="Traced before the roll was consulted — the old order, on an unchecked name">
                        <Chip size="small" label={`${c.tracedBeforeRoll} before the roll`}
                          sx={{ mt: 0.5, height: 19, fontSize: 10.5, bgcolor: '#fdeaea', color: '#b3261e', fontWeight: 600 }} />
                      </Tooltip>
                    )}
                  </TableCell>
                </TableRow>
              );
            })}
            {!cohorts.length && !loading && (
              <TableRow>
                <TableCell colSpan={7} sx={{ textAlign: 'center', py: 4, color: '#888' }}>
                  No cohorts at this grade.
                </TableCell>
              </TableRow>
            )}
          </TableBody>
        </Table>
      </Paper>
    </Container>
  );
}
