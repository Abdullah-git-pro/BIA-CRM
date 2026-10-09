'use client';

import React, { useCallback, useEffect, useState } from 'react';
import {
  Container, Box, Typography, Paper, Button, Chip, CircularProgress, Alert, Stack, Divider,
  MenuItem, TextField, LinearProgress,
} from '@mui/material';
import RefreshIcon from '@mui/icons-material/Refresh';
// Safe from a client component: services/cohort.ts has no imports at all, so nothing
// server-only rides in with it. That is why the cohort rules live there.
import { numberedCohorts, cohortCode, cohortEnd } from '@/services/cohort';

/**
 * What has actually been dialled, and what has not.
 *
 * ── Why per number ──────────────────────────────────────────────────────────
 * A card with six numbers and one voicemail looks worked on every per-card measure, and is
 * not. That is how "we called them" and "we reached nobody" were both true of C1 at once.
 * On 1 Oct the cohort held 326 numbers and 15 had an outcome, with 55 of 62 cards never
 * touched — and nothing in the CRM said so, through two weeks of calling and two rounds of
 * questions about why contact rates were low.
 *
 * ── A worklist before it is a report ────────────────────────────────────────
 * Untouched cards sort first and each one lists its own numbers in dialling order, so the
 * answer to "what do I call next" is on the same screen as "how much is left". A report that
 * only counts would have to be read beside the queue instead of replacing a trip to it.
 */

type NumberRow = {
  number: string; role: 'insured' | 'co_insured'; label: string;
  dnc: boolean; rank: number | null; type: string | null;
  outcome: string | null; attemptedAt: string | null;
};
type Card = {
  leadId: string; propertyId: string | null; owner: string; cohort: string | null;
  held: number; worked: number; numbers: NumberRow[];
  lastAttemptAt: string | null; days: number;
  state: 'untouched' | 'partial' | 'complete' | 'no_numbers';
};
type Summary = {
  cards: number; cardsUntouched: number; cardsPartial: number; cardsComplete: number;
  cardsNoNumbers: number; numbersHeld: number; numbersWorked: number;
  byOutcome: Record<string, number>;
};

/**
 * The weeks this screen can filter to, counted forward rather than listed.
 *
 * ── Why this is not a list any more ─────────────────────────────────────────
 * It was seven hand-written lines ending at C7, so the week of 23 Nov — 702 leads, 165 of
 * them Grade A — could not be selected. The data had an eighth week; the dropdown did
 * not, and said nothing about it.
 *
 * That is the same failure three times over: COHORT_LABEL hit it on the cohort ledger,
 * where C8 drew a dash, and the phone screen's own copy hit it this week. cohort.ts
 * already replaced the ledger's list with arithmetic for exactly this reason, so the
 * dates here come from it rather than from a fourth copy — COHORT_ONE_MONDAY is the
 * anchor every other count starts from, cohortCode numbers the week, cohortEnd closes it.
 *
 * Only the formatting is local. cohortLabel() would read "Oct 5 – 11, 2026", and the year
 * is noise in a dropdown where every option is 2026; the compact range is what was on
 * screen before and what fits the control.
 */
const COHORTS: Array<{ value: string; label: string }> = numberedCohorts().map((value) => {
  const monday = new Date(`${value}T00:00:00Z`);
  const end = new Date(`${cohortEnd(value)}T00:00:00Z`);
  const mon = (d: Date) => d.toLocaleDateString('en-US', { month: 'short', timeZone: 'UTC' });
  // "Oct 5–11" within a month; "Oct 26–Nov 1" across one.
  const range = mon(monday) === mon(end)
    ? `${mon(monday)} ${monday.getUTCDate()}–${end.getUTCDate()}`
    : `${mon(monday)} ${monday.getUTCDate()}–${mon(end)} ${end.getUTCDate()}`;
  return { value, label: `${cohortCode(value)} — ${range}` };
});

const STATE_COLOUR: Record<Card['state'], { bg: string; fg: string; label: string }> = {
  untouched: { bg: '#fdecea', fg: '#b3261e', label: 'not started' },
  partial: { bg: '#fff4e0', fg: '#8a5a00', label: 'part worked' },
  complete: { bg: '#e7f5ec', fg: '#166534', label: 'every number tried' },
  no_numbers: { bg: '#eef0f3', fg: '#5a6675', label: 'no number on file' },
};

export default function CallCoveragePage() {
  const [cohort, setCohort] = useState('2026-10-05');
  const [summary, setSummary] = useState<Summary | null>(null);
  const [cards, setCards] = useState<Card[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [open, setOpen] = useState<string | null>(null);

  const load = useCallback(async (c: string) => {
    setLoading(true); setError(null);
    try {
      const j = await (await fetch(`/api/admin/call-coverage?cohorts=${c}&grade=A`)).json();
      if (!j.success) throw new Error(j.error || 'Could not read coverage');
      setSummary(j.summary); setCards(j.cards);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Could not read coverage');
    } finally { setLoading(false); }
  }, []);

  useEffect(() => { void load(cohort); }, [load, cohort]);

  const pct = summary && summary.numbersHeld
    ? Math.round((summary.numbersWorked / summary.numbersHeld) * 100) : 0;

  return (
    <Container maxWidth="lg" sx={{ py: 4 }}>
      <Stack direction="row" sx={{ alignItems: 'center', justifyContent: 'space-between', mb: 1 }}>
        <Typography variant="h5" sx={{ fontWeight: 800 }}>Call coverage</Typography>
        <Stack direction="row" sx={{ gap: 1 }}>
          <TextField
            select size="small" value={cohort} onChange={(e) => setCohort(e.target.value)}
            sx={{ minWidth: 190 }}
          >
            {COHORTS.map((c) => <MenuItem key={c.value} value={c.value}>{c.label}</MenuItem>)}
          </TextField>
          <Button size="small" variant="outlined" onClick={() => void load(cohort)} disabled={loading}>
            <RefreshIcon fontSize="small" />
          </Button>
        </Stack>
      </Stack>
      <Typography color="text.secondary" sx={{ mb: 3 }}>
        Every number on every Grade A card, and whether it has been dialled. Counted per
        number rather than per card — a card with six numbers and one voicemail is not a
        worked card.
      </Typography>

      {error && <Alert severity="error" sx={{ mb: 2 }} onClose={() => setError(null)}>{error}</Alert>}
      {loading && <Box sx={{ textAlign: 'center', py: 6 }}><CircularProgress /></Box>}

      {!loading && summary && (
        <Paper variant="outlined" sx={{ p: 2, mb: 3 }}>
          <Stack direction="row" sx={{ gap: 3, flexWrap: 'wrap', mb: 1.5 }}>
            <Box>
              <Typography variant="h4" sx={{ fontWeight: 800 }}>
                {summary.numbersWorked}<Box component="span" sx={{ fontSize: 20, color: '#5a6675' }}> / {summary.numbersHeld}</Box>
              </Typography>
              <Typography variant="caption" sx={{ color: '#5a6675' }}>numbers dialled</Typography>
            </Box>
            <Box>
              <Typography variant="h4" sx={{ fontWeight: 800, color: '#b3261e' }}>{summary.cardsUntouched}</Typography>
              <Typography variant="caption" sx={{ color: '#5a6675' }}>cards not started</Typography>
            </Box>
            <Box>
              <Typography variant="h4" sx={{ fontWeight: 800, color: '#8a5a00' }}>{summary.cardsPartial}</Typography>
              <Typography variant="caption" sx={{ color: '#5a6675' }}>part worked</Typography>
            </Box>
            <Box>
              <Typography variant="h4" sx={{ fontWeight: 800, color: '#166534' }}>{summary.cardsComplete}</Typography>
              <Typography variant="caption" sx={{ color: '#5a6675' }}>every number tried</Typography>
            </Box>
            {/*
              Shown even at zero, so the four figures always add up to the cohort.
              Without it the tiles read 55 + 5 + 1 against 62 cards and the reader is left
              hunting a card that is not missing — it simply has no number to dial.
            */}
            <Box>
              <Typography variant="h4" sx={{ fontWeight: 800, color: '#5a6675' }}>{summary.cardsNoNumbers}</Typography>
              <Typography variant="caption" sx={{ color: '#5a6675' }}>no number on file</Typography>
            </Box>
          </Stack>
          <LinearProgress variant="determinate" value={pct} sx={{ height: 8, borderRadius: 4 }} />
          <Stack direction="row" sx={{ gap: 1, flexWrap: 'wrap', mt: 1.5 }}>
            {Object.entries(summary.byOutcome).sort((a, b) => b[1] - a[1]).map(([k, v]) => (
              <Chip key={k} size="small" variant="outlined" sx={{ height: 22, fontSize: 11 }}
                label={`${k.replace(/_/g, ' ')} ${v}`} />
            ))}
            {!Object.keys(summary.byOutcome).length && (
              <Typography variant="caption" sx={{ color: '#5a6675' }}>No outcomes logged yet.</Typography>
            )}
          </Stack>
        </Paper>
      )}

      <Stack spacing={1}>
        {cards.map((c) => {
          const s = STATE_COLOUR[c.state];
          const isOpen = open === c.leadId;
          return (
            <Paper key={c.leadId} variant="outlined" sx={{ p: 1.5 }}>
              <Stack
                direction="row"
                sx={{ alignItems: 'center', gap: 1, flexWrap: 'wrap', cursor: 'pointer' }}
                onClick={() => setOpen(isOpen ? null : c.leadId)}
              >
                <Chip size="small" label={s.label}
                  sx={{ height: 20, fontSize: 11, fontWeight: 700, minWidth: 128, bgcolor: s.bg, color: s.fg }} />
                <Box component="a" href={`/leads/${c.propertyId ?? c.leadId}`} target="_blank" rel="noopener"
                  sx={{ fontWeight: 700 }} onClick={(e) => e.stopPropagation()}>
                  {c.owner || c.leadId}
                </Box>
                <Typography variant="body2" sx={{ color: '#5a6675' }}>
                  {c.worked} of {c.held} numbers
                  {c.days ? ` · ${c.days} day${c.days === 1 ? '' : 's'}` : ''}
                  {c.lastAttemptAt ? ` · last ${c.lastAttemptAt.slice(0, 10)}` : ''}
                </Typography>
                {/*
                  The next number to ring, on the row itself.
                  numbersOnCard already sorts by what predicts a useful call — not DNC, on
                  the card before found by a trace, then vendor rank — so the first one is
                  the answer to "what do I dial". Leaving it behind a click meant opening
                  every card to find out, which is the trip to the queue this screen was
                  meant to replace.
                */}
                {(() => {
                  const next = c.numbers.find((n) => !n.outcome);
                  if (!next) return null;
                  return (
                    <Typography variant="body2" sx={{ ml: 'auto', color: '#1b4332' }}>
                      next&nbsp;
                      <Box component="span" sx={{ fontFamily: 'monospace', fontWeight: 700 }}>{next.number}</Box>
                      <Box component="span" sx={{ color: '#8a8f98', fontSize: 12 }}>
                        &nbsp;{next.role === 'insured' ? 'insured' : 'co-insured'}
                        {next.dnc ? ' · DNC' : ''}
                      </Box>
                    </Typography>
                  );
                })()}
              </Stack>

              {isOpen && !!c.numbers.length && (
                <>
                  <Divider sx={{ my: 1 }} />
                  <Stack spacing={0.5}>
                    {c.numbers.map((n) => (
                      <Stack key={n.number} direction="row" sx={{ gap: 1, alignItems: 'baseline', flexWrap: 'wrap' }}>
                        <Box sx={{ fontFamily: 'monospace', minWidth: 110 }}>{n.number}</Box>
                        <Chip size="small" variant="outlined" sx={{ height: 18, fontSize: 10 }}
                          label={n.role === 'insured' ? 'insured' : 'co-insured'} />
                        <Typography variant="caption" sx={{ color: '#8a8f98' }}>{n.label}</Typography>
                        {n.dnc && <Chip size="small" sx={{ height: 18, fontSize: 10, bgcolor: '#fdecea', color: '#b3261e' }} label="DNC" />}
                        {n.rank != null && <Typography variant="caption" sx={{ color: '#8a8f98' }}>rank {n.rank}</Typography>}
                        <Typography variant="body2" sx={{ ml: 'auto', fontWeight: n.outcome ? 700 : 400, color: n.outcome ? '#166534' : '#b3261e' }}>
                          {n.outcome ? n.outcome.replace(/_/g, ' ') : 'never dialled'}
                        </Typography>
                      </Stack>
                    ))}
                  </Stack>
                </>
              )}
            </Paper>
          );
        })}
      </Stack>
    </Container>
  );
}
