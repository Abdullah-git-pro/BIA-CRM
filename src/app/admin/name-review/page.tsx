'use client';

import React, { useCallback, useEffect, useRef, useState } from 'react';
import { useStickyState } from '@/hooks/useStickyState';
import {
  Container, Box, Typography, Paper, Button, Chip, CircularProgress, Alert, Stack,
  MenuItem, TextField, LinearProgress, Tooltip,
} from '@mui/material';
import CheckCircleIcon from '@mui/icons-material/CheckCircleOutlined';
import BlockIcon from '@mui/icons-material/BlockOutlined';
import RefreshIcon from '@mui/icons-material/Refresh';

/**
 * The surname review queue, as a person works it (Frank, 24 Sep 2026 · second email §7).
 *
 * "A surname match between every skip-trace-recovered address and the insured or
 *  co-insured. Failures go to a review list, not into a send."
 *
 * ── Why this screen exists ──────────────────────────────────────────────────
 * The rule has been enforced since it was written: the send list and the push both refuse a
 * held address. What did not exist was any way to CLEAR one. So "held pending review" meant
 * held forever, and on 29 Sep that was 683 addresses we had paid to recover sitting behind
 * a door with no handle on it.
 *
 * ── Why it is built wide rather than dense ──────────────────────────────────
 * Ruben works this, between calls, not in a long sitting. The decision is a glance —
 * "is mjgarcia@… Maria Garcia?" — and everything on the row exists to make that glance
 * possible without opening the lead. Both names, the property, and the matcher's own
 * reasoning, because "nothing in this matches" and "this is four letters of the surname"
 * are different questions even though both land here.
 *
 * ── Why there is no bulk approve ────────────────────────────────────────────
 * Rejecting in bulk is safe: it holds addresses that were already held. Approving in bulk is
 * how 600 rows get cleared in four clicks by somebody who has stopped reading, which is
 * precisely the failure the rule was written to prevent. Approving is one row at a time, on
 * purpose.
 */

type Row = {
  id: string;
  leadId: string;
  propertyId: string | null;
  cohort: string | null;
  personRole: 'insured' | 'coInsured';
  email: string;
  verdict: string;
  decision: 'approved' | 'rejected' | null;
  decidedBy: string | null;
  decidedAt: string | null;
  owner: string | null;
  coInsuredOwner: string | null;
  address: string | null;
  grade: string | null;
};

type Summary = {
  open: number; approved: number; rejected: number;
  byCohort: Array<{ cohort: string; open: number }>;
};

/** Plain English for the matcher's verdict — the raw word means nothing to a producer. */
const VERDICT_LABEL: Record<string, { text: string; colour: 'error' | 'warning' }> = {
  mismatch: { text: 'No part of the name is in this address', colour: 'error' },
  review: { text: 'Partly matches — worth a look', colour: 'warning' },
  no_name: { text: 'No owner name on the record to check against', colour: 'warning' },
  /**
   * The other direction entirely.
   *
   * Every other row here is an address the system WAS going to use and is holding back.
   * This one is an address nobody claimed: the trace returned it for the property without
   * attributing it to a person, so no send path offers it, and the card reads as having no
   * insured address while this sits on it. Approving puts it on the lead — see
   * poolAttribution.service — so "yes" here genuinely makes the lead mailable.
   */
  pool_candidate: { text: 'Unclaimed — looks like the insured’s own address', colour: 'warning' },
};

export default function NameReviewPage() {
  const [rows, setRows] = useState<Row[]>([]);
  const [summary, setSummary] = useState<Summary | null>(null);
  /**
   * Filters survive leaving the page (Frank Aug-2026).
   *
   * This queue is worked in short bursts between calls, and opening a lead from a row and
   * coming back is the single most common thing anyone does on it. Losing the week and the
   * grade on the way back means re-setting both every time, on a list of 732.
   *
   * The stale-response race that comes with restoring in an effect is already handled by
   * the `wanted` counter below.
   */
  const [cohort, setCohort] = useStickyState<string>('nameReview:cohort', '');
  const [view, setView] = useStickyState<'open' | 'decided' | 'all'>('nameReview:view', 'open');
  /**
   * Grade B addresses are mailed by EMAIL ONLY — there is no producer on a phone to notice
   * a stranger before the send — so being able to work that book on its own matters more
   * here than it does on most screens.
   */
  const [grade, setGrade] = useStickyState<string>('nameReview:grade', '');
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  /** Rows currently being written, so a row cannot be double-clicked into two decisions. */
  const [busyIds, setBusyIds] = useState<Set<string>>(new Set());
  const [justDone, setJustDone] = useState<{ n: number; decision: string } | null>(null);

  /**
   * Which request the screen is actually waiting for.
   *
   * Changing the cohort filter twice quickly fires two loads, and the slower one can land
   * last and paint results for a filter nobody is looking at any more. The same race put
   * the Grade A table under the Grade B tab on the cohorts screen last week.
   */
  const wanted = useRef(0);

  const load = useCallback(async () => {
    const mine = ++wanted.current;
    setLoading(true);
    setError(null);
    try {
      const qs = new URLSearchParams();
      qs.set('view', view);
      if (cohort) qs.set('cohort', cohort);
      if (grade) qs.set('grade', grade);
      const res = await fetch(`/api/admin/name-review?${qs.toString()}`);
      const json = await res.json();
      if (mine !== wanted.current) return;
      if (!json.success) throw new Error(json.error || 'Could not load the queue');
      setRows(json.rows as Row[]);
      setSummary(json.summary as Summary);
    } catch (err) {
      if (mine !== wanted.current) return;
      setError(err instanceof Error ? err.message : 'Could not load the queue');
    } finally {
      if (mine === wanted.current) setLoading(false);
    }
  }, [cohort, view, grade]);

  useEffect(() => { void load(); }, [load]);

  const decide = async (row: Row, decision: 'approved' | 'rejected') => {
    setBusyIds((s) => new Set(s).add(row.id));
    setError(null);
    try {
      const res = await fetch('/api/admin/name-review', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ ids: [row.id], decision }),
      });
      const json = await res.json();
      if (!json.success) throw new Error(json.error || 'Could not record that');
      // Drop it from the open list rather than reloading: the queue is long and a reload
      // would lose the reader's place after every single decision.
      // In the open view the row is finished with, so it goes. In the others it stays and
      // shows what was decided, which is the whole point of looking at them.
      if (view === 'open') setRows((r) => r.filter((x) => x.id !== row.id));
      else setRows((r) => r.map((x) => (x.id === row.id ? { ...x, decision } : x)));
      setSummary(json.summary as Summary);
      setJustDone({ n: json.decided, decision });
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not record that');
    } finally {
      setBusyIds((s) => { const n = new Set(s); n.delete(row.id); return n; });
    }
  };

  const total = (summary?.open ?? 0) + (summary?.approved ?? 0) + (summary?.rejected ?? 0);
  const done = (summary?.approved ?? 0) + (summary?.rejected ?? 0);

  return (
    <Container maxWidth="lg" sx={{ py: 4 }}>
      <Typography variant="h4" gutterBottom sx={{ fontWeight: 700 }}>
        Name check
      </Typography>
      <Typography color="text.secondary" sx={{ mb: 3 }}>
        Skip tracing found these email addresses, but the name in the address does not look like
        the people on the policy. Anything left here is not being emailed.
      </Typography>

      {/* ── Where we are ──────────────────────────────────────────────────── */}
      <Paper variant="outlined" sx={{ p: 2.5, mb: 3 }}>
        <Stack direction={{ xs: 'column', sm: 'row' }} spacing={3} sx={{ alignItems: { sm: 'center' } }}>
          {/*
            * The big number counts what is on screen.
            *
            * It used to be the whole queue regardless of the filter, so picking a renewal
            * week showed "655 left to check" above a list of 29 — two populations stacked on
            * top of each other, and the one in large type was the one you were not looking at.
            */}
          <Box sx={{ minWidth: 150 }}>
            <Typography variant="h3" sx={{ fontWeight: 700, lineHeight: 1 }}>
              {loading ? '—' : (view === 'open' ? rows.length : rows.filter((r) => !r.decision).length)}
            </Typography>
            {/*
              * The label names every filter the number is under.
              *
              * It read "left to check this week" while the week picker beside it offered
              * "2026-10-12 (43)" and this said 39 — both true, the difference being a grade
              * filter two boxes away that the label never mentioned. A number that does not
              * say what it is counting is a number somebody reconciles by guessing.
              */}
            <Typography variant="body2" color="text.secondary">
              left to check
              {grade ? ` in Grade ${grade}` : ''}
              {cohort ? ' this week' : ''}
            </Typography>
          </Box>
          <Box sx={{ flex: 1, width: '100%' }}>
            <LinearProgress
              variant="determinate"
              value={total ? (done / total) * 100 : 0}
              sx={{ height: 10, borderRadius: 5, mb: 1 }}
            />
            <Typography variant="body2" color="text.secondary">
              {done} of {total} decided
              {summary ? ` — ${summary.approved} kept, ${summary.rejected} blocked` : ''}
            </Typography>
          </Box>
          {/* Three fixed-width pickers and a button come to roughly 480px, which is wider
              than a phone. They wrap onto as many lines as they need rather than pushing
              the page sideways — each one keeps its own minimum width so the labels stay
              readable. */}
          <Stack direction="row" spacing={1} useFlexGap sx={{ flexWrap: 'wrap' }}>
            <TextField
              select size="small" label="Renewal week" value={cohort}
              onChange={(e) => setCohort(e.target.value)}
              sx={{ minWidth: 180 }}
              slotProps={{ inputLabel: { shrink: true } }}
            >
              <MenuItem value="">All weeks</MenuItem>
              {(summary?.byCohort ?? []).map((c) => (
                <MenuItem key={c.cohort} value={c.cohort}>{c.cohort} ({c.open})</MenuItem>
              ))}
            </TextField>
            {/*
              * Three named views rather than one toggle.
              *
              * The toggle read "Showing decided" while returning everything, so the button
              * said one thing, the query did another, and the only way to notice was to count
              * the rows. A view you can point at cannot drift from its own label.
              */}
            <TextField
              select size="small" label="Show" value={view}
              onChange={(e) => setView(e.target.value as 'open' | 'decided' | 'all')}
              sx={{ minWidth: 150 }}
              slotProps={{ inputLabel: { shrink: true } }}
            >
              <MenuItem value="open">Still to check</MenuItem>
              <MenuItem value="decided">Already decided</MenuItem>
              <MenuItem value="all">Everything</MenuItem>
            </TextField>
            <TextField
              select size="small" label="Grade" value={grade}
              onChange={(e) => setGrade(e.target.value)}
              sx={{ minWidth: 120 }}
              slotProps={{ inputLabel: { shrink: true } }}
            >
              <MenuItem value="">All grades</MenuItem>
              <MenuItem value="A">Grade A</MenuItem>
              <MenuItem value="B">Grade B</MenuItem>
            </TextField>
            <Tooltip title="Reload">
              <Button size="small" variant="outlined" onClick={() => void load()}>
                <RefreshIcon fontSize="small" />
              </Button>
            </Tooltip>
          </Stack>
        </Stack>
      </Paper>

      {error && <Alert severity="error" sx={{ mb: 2 }} onClose={() => setError(null)}>{error}</Alert>}
      {justDone && (
        <Alert severity="success" sx={{ mb: 2 }} onClose={() => setJustDone(null)}>
          {justDone.decision === 'approved'
            ? 'Kept — this address will be emailed.'
            : 'Blocked — this address will never be emailed.'}
        </Alert>
      )}

      {loading && <Box sx={{ textAlign: 'center', py: 6 }}><CircularProgress /></Box>}

      {!loading && !rows.length && (
        <Paper variant="outlined" sx={{ p: 6, textAlign: 'center' }}>
          <CheckCircleIcon color="success" sx={{ fontSize: 48, mb: 1 }} />
          <Typography variant="h6">
            {view === 'decided' ? 'Nothing decided yet' : 'Nothing left to check'}
          </Typography>
          <Typography color="text.secondary">
            {view === 'decided'
              ? 'Addresses you keep or block will show up here.'
              : cohort
                ? 'Nothing outstanding for that week.'
                : 'The whole queue has been decided.'}
          </Typography>
        </Paper>
      )}

      {/* ── The queue ─────────────────────────────────────────────────────── */}
      <Stack spacing={2}>
        {/*
          * Unclaimed addresses are grouped by LEAD, one card per household.
          *
          * The rest of this queue is one row per address because each is an independent
          * question: this address was going to be used, hold it or release it. These are a
          * different question — "which of these is the policyholder's?" — and the first
          * version rendered them the same way, so Waqas Ashraf filled three cards that
          * repeated his name, his address and his renewal week, and asked what looked like
          * the same question three times.
          *
          * Several CAN be right at once: Frank, 28 Sep — "individual emails sent to each of
          * the insured's verified emails — we are not sure which will be primary so we must
          * outreach all." So each address keeps its own decision; what changes is that the
          * household is asked about once, with its candidates side by side, which is also
          * the only way to see that one is a personal address and two are work ones.
          */}
        {(() => {
          const groups = new Map<string, typeof rows>();
          for (const r of rows) {
            if (r.verdict !== 'pool_candidate') continue;
            const a = groups.get(r.leadId) ?? [];
            a.push(r);
            groups.set(r.leadId, a);
          }
          return [...groups.values()].map((group) => {
            const head = group[0];
            const open = group.filter((g) => !g.decision);
            return (
              <Paper key={`pool-${head.leadId}`} variant="outlined" sx={{ p: 2.5 }}>
                <Typography sx={{ fontWeight: 600 }}>
                  Policy is in the name of <strong>{head.owner || 'no name on the record'}</strong>
                  {head.coInsuredOwner && <> and <strong>{head.coInsuredOwner}</strong></>}
                </Typography>
                <Typography variant="body2" color="text.secondary">
                  {head.address || 'no property address'}
                  {head.cohort ? ` · renews week of ${head.cohort}` : ''}
                </Typography>
                <Typography variant="body2" color="text.secondary" sx={{ mt: 1 }}>
                  Skip tracing returned {group.length === 1 ? 'this address' : `these ${group.length} addresses`}
                  {' '}for the property and attributed {group.length === 1 ? 'it' : 'them'} to nobody.
                  {' '}
                  {/* The {' '} is load-bearing: JSX drops the newline between an expression
                      and the text after it, which rendered "They readlike the insured". */}
                  {group.length === 1 ? 'It reads' : 'They read'}
                  {' '}like the insured&apos;s own name, so this lead has no address the
                  {' '}campaign will use until one is approved.
                </Typography>
                <Typography variant="caption" color="text.secondary" sx={{ display: 'block', mt: 0.5 }}>
                  Approving puts the address on the lead. More than one may be theirs — approve each that is.
                </Typography>
                <Box sx={{ mt: 1.5 }}>
                  {group.map((g) => {
                    const busy = busyIds.has(g.id);
                    return (
                      <Stack
                        key={g.id}
                        direction={{ xs: 'column', sm: 'row' }}
                        spacing={1.5}
                        sx={{
                          alignItems: { sm: 'center' }, justifyContent: 'space-between',
                          py: 1.25, borderTop: '1px solid', borderColor: 'divider',
                          opacity: busy ? 0.55 : 1,
                        }}
                      >
                        <Typography
                          component="a"
                          href={`/leads/${g.leadId}`}
                          target="_blank"
                          rel="noopener"
                          sx={{
                            fontFamily: 'monospace', fontSize: '1.05rem', fontWeight: 600,
                            wordBreak: 'break-all', minWidth: 0,
                          }}
                        >
                          {g.email}
                        </Typography>
                        {g.decision ? (
                          <Chip
                            size="small"
                            color={g.decision === 'approved' ? 'success' : 'default'}
                            label={`${g.decision === 'approved' ? 'Kept' : 'Blocked'}`
                              + `${g.decidedBy ? ` by ${g.decidedBy}` : ''}`}
                            sx={{ flexShrink: 0 }}
                          />
                        ) : (
                          <Stack
                            direction={{ xs: 'column', sm: 'row' }}
                            spacing={1.5}
                            sx={{ flexShrink: 0, width: { xs: '100%', sm: 'auto' } }}
                          >
                            <Button
                              variant="outlined" color="error" size="small" disabled={busy}
                              startIcon={<BlockIcon />}
                              onClick={() => void decide(g, 'rejected')}
                              sx={{ minWidth: { sm: 130 }, width: { xs: '100%', sm: 'auto' } }}
                            >
                              Not them
                            </Button>
                            <Button
                              variant="contained" color="success" size="small" disabled={busy}
                              startIcon={<CheckCircleIcon />}
                              onClick={() => void decide(g, 'approved')}
                              sx={{ minWidth: { sm: 130 }, width: { xs: '100%', sm: 'auto' } }}
                            >
                              Yes, it&apos;s them
                            </Button>
                          </Stack>
                        )}
                      </Stack>
                    );
                  })}
                </Box>
                {open.length === 0 && (
                  <Typography variant="caption" color="text.secondary" sx={{ display: 'block', mt: 1 }}>
                    All decided.
                  </Typography>
                )}
              </Paper>
            );
          });
        })()}

        {rows.filter((r) => r.verdict !== 'pool_candidate').map((r) => {
          const busy = busyIds.has(r.id);
          const label = VERDICT_LABEL[r.verdict] ?? { text: r.verdict, colour: 'warning' as const };
          return (
            <Paper key={r.id} variant="outlined" sx={{ p: 2.5, opacity: busy ? 0.55 : 1 }}>
              <Stack
                direction={{ xs: 'column', md: 'row' }}
                spacing={2}
                sx={{ alignItems: { md: 'center' }, justifyContent: 'space-between' }}
              >
                <Box sx={{ minWidth: 0, flex: 1 }}>
                  {/*
                    * The address links to the lead.
                    *
                    * Most rows are decided from what is on them, but the ones that are not
                    * are exactly the ones that matter — and without this the only way to see
                    * the card was to search the Leads page for a name, which is enough
                    * friction that the hard rows get guessed at instead.
                    *
                    * Opens in a new tab so a reviewer keeps their place in a queue of 655.
                    */}
                  <Typography
                    component="a"
                    href={`/leads/${r.leadId}`}
                    target="_blank"
                    rel="noopener"
                    /**
                     * Colour and underline are left to globals.css, which styles
                     * `a:not(.MuiButtonBase-root)` outside any CSS layer and therefore beats
                     * anything set here — the same rule that turned the "Call now" button
                     * blue-on-blue last week. Setting a colour on this sx would read as
                     * deliberate and do nothing, so it says nothing instead. Blue is the
                     * right answer for a link regardless.
                     */
                    sx={{
                      fontFamily: 'monospace', fontSize: '1.15rem', fontWeight: 600,
                      wordBreak: 'break-all', display: 'inline-block',
                    }}
                  >
                    {r.email}
                  </Typography>
                  {/*
                    * Both names, because the check compares the address against both.
                    *
                    * Naming only the insured on a co-insured row asked the reviewer about a
                    * person the address was never compared with — and on a household where
                    * the two have different surnames, that is the difference between a
                    * stranger and a spouse.
                    */}
                  <Typography sx={{ mt: 0.5 }}>
                    Policy is in the name of{' '}
                    <strong>{r.owner || 'no name on the record'}</strong>
                    {r.coInsuredOwner && <> and <strong>{r.coInsuredOwner}</strong></>}
                  </Typography>
                  <Typography variant="body2" color="text.secondary">
                    {/*
                      * Where the address came from — and the two rows here mean opposite
                      * things.
                      *
                      * An ordinary row is an address the TRACE attributed to this person
                      * and the surname check then held back. A pool candidate is the
                      * reverse: the trace attributed it to nobody, and it is here because
                      * the local part reads like the insured's own name.
                      *
                      * This line said "skip tracing attributed this address to the insured"
                      * on both. On a pool candidate that is the opposite of what happened,
                      * and it is the one sentence on the row that speaks to how much the
                      * address can be trusted — so it would have talked a reviewer into
                      * approving on evidence that does not exist.
                      */}
                    {r.verdict === 'pool_candidate' ? (
                      <>
                        Skip tracing returned this address for the property and attributed it
                        to nobody. It is here because it reads like the insured&apos;s own name.
                      </>
                    ) : (
                      <>
                        Skip tracing attributed this address to the{' '}
                        {r.personRole === 'coInsured' ? 'co-insured' : 'insured'}.
                      </>
                    )}
                    {/*
                      Grade B says how the decision lands, so it belongs on the row.

                      Grade A gets a phone call as well, which is a second chance to notice
                      the address belongs to somebody else. Grade B is email only — approving
                      one here IS the last check there will be.
                    */}
                    {r.grade === 'B' && (
                      <Box component="span" sx={{ color: '#8a5a00', fontWeight: 600 }}>
                        {' '}Grade B — email only, so nobody will speak to this household first.
                      </Box>
                    )}
                    {r.grade && r.grade !== 'A' && r.grade !== 'B' && (
                      <Box component="span" sx={{ color: '#5a6675' }}>
                        {' '}This lead is Grade {r.grade} now and is not being mailed.
                      </Box>
                    )}
                  </Typography>
                  <Typography variant="body2" color="text.secondary">
                    {r.address || 'no property address'}
                    {r.cohort ? ` · renews week of ${r.cohort}` : ''}
                  </Typography>
                  <Chip size="small" color={label.colour} variant="outlined" label={label.text} sx={{ mt: 1 }} />
                  {r.decision && (
                    <Chip
                      size="small"
                      sx={{ mt: 1, ml: 1 }}
                      color={r.decision === 'approved' ? 'success' : 'default'}
                      label={
                        `${r.decision === 'approved' ? 'Kept' : 'Blocked'}`
                        + `${r.decidedBy ? ` by ${r.decidedBy}` : ''}`
                      }
                    />
                  )}
                </Box>

                {/* Side by side where there is room; stacked and full width on a phone.
                    These are the two decisions the screen exists for, so on a small screen
                    they get the whole width rather than being squeezed to fit — Ruben works
                    this between calls and a mis-tap here approves a stranger's address. */}
                {!r.decision && (
                  <Stack
                    direction={{ xs: 'column', sm: 'row' }}
                    spacing={1.5}
                    sx={{ flexShrink: 0, width: { xs: '100%', sm: 'auto' } }}
                  >
                    <Button
                      variant="outlined" color="error" size="large" disabled={busy}
                      startIcon={<BlockIcon />}
                      onClick={() => void decide(r, 'rejected')}
                      sx={{ minWidth: { sm: 150 }, width: { xs: '100%', sm: 'auto' } }}
                    >
                      Not them
                    </Button>
                    <Button
                      variant="contained" color="success" size="large" disabled={busy}
                      startIcon={<CheckCircleIcon />}
                      onClick={() => void decide(r, 'approved')}
                      sx={{ minWidth: { sm: 150 }, width: { xs: '100%', sm: 'auto' } }}
                    >
                      Yes, it&apos;s them
                    </Button>
                  </Stack>
                )}
              </Stack>
            </Paper>
          );
        })}
      </Stack>
    </Container>
  );
}
