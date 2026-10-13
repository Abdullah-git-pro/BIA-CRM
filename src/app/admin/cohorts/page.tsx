'use client';

import React, { useCallback, useEffect, useRef, useState } from 'react';
import {
  Container, Box, Typography, Paper, Button, Chip, Table, TableHead, TableRow,
  TableCell, TableBody, CircularProgress, Alert, Stack, TextField, Tabs, Tab, Tooltip,
} from '@mui/material';
import SwapVertIcon from '@mui/icons-material/SwapVert';
import DownloadIcon from '@mui/icons-material/Download';
import { useStickyState } from '@/hooks/useStickyState';
import { LEDGER_COLUMNS, type LedgerRow } from '@/components/ledgerColumns';
import { stickyFirstColumn, scrollableTable } from '@/lib/stickyColumn';
// Zero imports in that file, so a client component can read it safely.
import { cohortCode } from '@/services/cohort';

/**
 * The cohort ledgers, on their own screen.
 *
 * ── Why it left QC Reports ──────────────────────────────────────────────────
 * QC is a set of data-quality checks somebody opens when they suspect something is wrong.
 * The ledger is the opposite: it is the standing measure of the whole pipeline, the thing
 * Frank reads first, and it was the default tab of a screen called "Data Validation". A
 * number you look at every day should not live behind a name that implies something is
 * broken.
 *
 * ── Why two tabs and not one table with a grade column ──────────────────────
 * The two funnels have almost no columns in common. Grade A measures RETENTION — at pull,
 * downgraded, low point, regained, now — against a 5% loss target. Grade B measures REACH —
 * in the roof band, queued, traced, address found, verified. Merged, every row would carry
 * five empty cells and the one number that matters for that grade would be somewhere in the
 * middle of them.
 */

/**
 * Taken from CohortLedgerRow, field for field.
 *
 * The first version was typed from the column HEADINGS on the old screen — "Climbed in",
 * "To call", "Mailable %" — none of which are field names. TypeScript could not catch it
 * because the rows arrive as JSON from a fetch, so the page compiled and then threw
 * "Cannot read properties of undefined" on the first render.
 *
 * The real names, and what the headings meant:
 *   Climbed in  = gainedOther   (Grade A today, not at pull)
 *   To call     = unverified    (mailable minus verified)
 *   Mailable %  = derived, mailable / aNow
 */
type GradeARow = {
  cohort: string; label: string; total: number; aAtPull: number; downgraded: number;
  trough: number; recovered: number; aNow: number; gainedOther: number;
  emailRecovered: number; mailable: number; verified: number; unverified: number;
  lostPct: number | null;
};
type GradeBRow = {
  cohort: string; code: string | null; label: string; total: number; inBand: number;
  queued: number; traced: number; withEmail: number; verified: number; failed: number;
  mailable: number; noContact: number;
  emailed: number; opened: number;
  coWithEmail: number; coVerified: number; coOnly: number;
};

/**
 * Guards against a missing field rather than throwing on one.
 *
 * A field name that does not exist arrives as undefined — the rows come from a fetch, so
 * nothing type-checks them — and `undefined.toLocaleString()` takes the whole page down
 * with a stack trace that names this function rather than the column that is wrong. An
 * em dash in one cell is a bug somebody reports; a blank screen is a bug that looks like
 * an outage.
 */
const num = (n: number | null | undefined) => (typeof n === 'number' ? n.toLocaleString() : '—');

export default function CohortsPage() {
  const [grade, setGrade] = useStickyState<'A' | 'B'>('cohorts:grade', 'A');
  const [effFrom, setEffFrom] = useStickyState('cohorts:from', '2026-10-05');
  const [effTo, setEffTo] = useStickyState('cohorts:to', '2026-11-29');
  const [rows, setRows] = useState<Array<GradeARow | GradeBRow>>([]);
  const [shownGrade, setShownGrade] = useState<'A' | 'B'>('A');
  const [targetPct, setTargetPct] = useState<number | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  /**
   * The grade currently selected, readable from inside an in-flight request.
   *
   * useStickyState restores from sessionStorage in an effect, so a page opened on Grade B
   * mounts as A, fires a request for A, restores to B and fires a second one. Two are then
   * in flight, and whichever answers LAST paints the table — which on a slow A and a fast B
   * leaves the Grade B tab selected above a Grade A table.
   *
   * A ref rather than the state value: `grade` inside run() is whatever it was when that
   * callback was built, which is always the grade that request asked for, so comparing the
   * two would always match and prove nothing.
   */
  const wantedGrade = useRef<'A' | 'B'>(grade);
  useEffect(() => { wantedGrade.current = grade; }, [grade]);

  /**
   * The same race, for the filters the grade check cannot see.
   *
   * wantedGrade compares the grade a response carries against the grade now selected, which
   * catches a stale GRADE and nothing else. Change the date window and two requests for the
   * same grade are in flight; both pass that check, and the slower one paints. The dates
   * restore from sessionStorage in an effect exactly as the grade does, so this fires on
   * every ordinary visit to the page, not just on a fast click.
   *
   * A counter covers every filter at once, including any added later.
   */
  const wanted = useRef(0);

  const run = useCallback(async () => {
    const mine = ++wanted.current;
    setLoading(true);
    setError(null);
    try {
      const u = new URL('/api/admin/cohort-ledger', window.location.origin);
      u.searchParams.set('grade', grade);
      if (effFrom) u.searchParams.set('effFrom', effFrom);
      if (effTo) u.searchParams.set('effTo', effTo);
      const j = await (await fetch(u.toString())).json();
      if (mine !== wanted.current) return;
      if (!j.success) throw new Error(j.error || 'Could not build the ledger');

      /**
       * Drop a response for a grade that is no longer selected.
       *
       * The server echoes the grade back precisely so this check is possible. Without it the
       * last response to land wins regardless of what the tabs say, and the two tables have
       * entirely different columns — so the mismatch is not a subtle one.
       */
      if ((j.grade === 'B' ? 'B' : 'A') !== wantedGrade.current) return;

      setRows(j.data ?? []);
      setTargetPct(j.targetPct ?? null);
      /**
       * Which grade the rows on screen actually describe.
       *
       * Drawing Grade A columns over Grade B rows shows empty cells under headings that
       * sound right, so the table is rendered from what came BACK rather than from the
       * toggle — the two differ for as long as a request is in flight.
       */
      setShownGrade(j.grade === 'B' ? 'B' : 'A');
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Could not build the ledger');
      setRows([]);
    } finally {
      // Only the request that is still wanted clears the spinner; a dropped one leaving it
      // up would look like the page had hung.
      if (grade === wantedGrade.current) setLoading(false);
    }
  }, [grade, effFrom, effTo]);

  useEffect(() => {
    let alive = true;
    (async () => { if (alive) await run(); })();
    return () => { alive = false; };
  }, [run]);

  const exportCsv = () => {
    const esc = (v: unknown) => `"${String(v ?? '').replace(/"/g, '""')}"`;
    /**
     * Grade A exports through LEDGER_COLUMNS, so the file and the table always carry the
     * same columns.
     *
     * A hand-listed subset here is how "the export gave me different numbers" happens: the
     * file describes a narrower report than the page it came from, and the only clue is a
     * column somebody expected and cannot find.
     */
    const csv = shownGrade === 'A'
      ? [
          LEDGER_COLUMNS.map((c) => esc(c.header)).join(','),
          ...rows.map((r) => LEDGER_COLUMNS.map((c) => esc(c.value(r as LedgerRow))).join(',')),
        ].join('\r\n')
      : (() => {
          const cols = ['cohort', 'code', 'label', 'total', 'inBand', 'queued', 'traced',
            'withEmail', 'verified', 'failed', 'mailable', 'noContact'];
          return [
            cols.map(esc).join(','),
            ...rows.map((r) => cols.map((c) => esc((r as Record<string, unknown>)[c])).join(',')),
          ].join('\r\n');
        })();
    const a = document.createElement('a');
    a.href = URL.createObjectURL(new Blob([csv], { type: 'text/csv' }));
    a.download = `cohort-ledger-grade-${shownGrade}-${effFrom}-to-${effTo}.csv`;
    a.click();
  };

  return (
    <Container maxWidth="xl" sx={{ py: 3 }}>
      <Stack direction="row" spacing={1.5} sx={{ alignItems: 'center', mb: 0.5 }}>
        <SwapVertIcon sx={{ color: '#1565c0' }} />
        <Typography variant="h5" sx={{ fontWeight: 800 }}>Cohorts</Typography>
      </Stack>
      <Typography variant="body2" sx={{ color: '#5a6675', mb: 2 }}>
        One row per renewal week. Grade A is measured on whether we kept the grade; Grade B on
        whether we can reach them at all.
      </Typography>

      <Tabs
        value={grade}
        onChange={(_, v) => setGrade(v)}
        sx={{ mb: 2, borderBottom: '1px solid #e3e6ea', minHeight: 40, '& .MuiTab-root': { minHeight: 40, textTransform: 'none', fontWeight: 700 } }}
      >
        <Tab value="A" label="Grade A — retention" />
        <Tab value="B" label="Grade B — reach" />
      </Tabs>

      <Paper variant="outlined" sx={{ p: 2, mb: 2 }}>
        <Stack direction="row" spacing={1.5} sx={{ flexWrap: 'wrap', gap: 1.5, alignItems: 'center' }}>
          {/* slotProps, not InputLabelProps — MUI v7 removed the latter. */}
          <TextField size="small" type="date" label="Eff from" slotProps={{ inputLabel: { shrink: true } }}
            value={effFrom} onChange={(e) => setEffFrom(e.target.value)} />
          <TextField size="small" type="date" label="Eff to" slotProps={{ inputLabel: { shrink: true } }}
            value={effTo} onChange={(e) => setEffTo(e.target.value)} />
          <Button variant="contained" size="small" onClick={run} disabled={loading}>Run</Button>
          <Box sx={{ flexGrow: 1 }} />
          <Button variant="outlined" size="small" startIcon={<DownloadIcon />}
            onClick={exportCsv} disabled={!rows.length}>Export CSV</Button>
        </Stack>
      </Paper>

      {error && <Alert severity="error" sx={{ mb: 2 }}>{error}</Alert>}
      {loading && <CircularProgress size={22} />}

      {!loading && !rows.length && !error && (
        <Typography variant="body2" sx={{ color: '#8a8f98' }}>
          No renewal weeks in that range.
        </Typography>
      )}

      {!loading && rows.length > 0 && shownGrade === 'B' && (
        /* The Grade A ledger beside this one already scrolled; this one did not, which only
           went unnoticed because Grade A is the tab that opens by default. */
        <Paper variant="outlined">
          {/* Named for the same reason as the Grade A ledger: there is a co-insured table
              underneath it now, and an untitled table beside a named one reads as the whole
              of which the other is a part. Outside the scroll box so it cannot slide away. */}
          <Box sx={{ px: 2, pt: 2, pb: 1 }}>
            <Typography sx={{ fontWeight: 700, fontSize: 15 }}>The insured</Typography>
            <Typography variant="caption" sx={{ color: '#5a6675', display: 'block' }}>
              The person named on the policy. Has an address, Verified, Refused and Mailable
              all count their addresses only.
            </Typography>
          </Box>
          <Box sx={scrollableTable}>
          <Table size="small" sx={stickyFirstColumn}>
            <TableHead>
              <TableRow>
                {['Cohort', 'Renewal week', 'Grade B', 'In the roof band', 'Queued', 'Traced',
                  'Has an address', 'Verified', 'Refused', 'Mailable', 'Emailed', 'Opened', 'No contact at all']
                  .map((h, i) => (
                    <TableCell key={h} align={i > 1 ? 'right' : 'left'} sx={{ fontWeight: 700 }}>{h}</TableCell>
                  ))}
              </TableRow>
            </TableHead>
            <TableBody>
              {(rows as GradeBRow[]).map((r) => (
                <TableRow key={r.cohort}>
                  <TableCell>
                    {r.code
                      ? <Chip size="small" label={r.code} sx={{ height: 19, fontSize: 11, fontWeight: 700, bgcolor: '#fff4e5', color: '#b26a00' }} />
                      : <span style={{ color: '#c2c7d0' }}>—</span>}
                  </TableCell>
                  <TableCell>{r.label}</TableCell>
                  <TableCell align="right">{num(r.total)}</TableCell>
                  <TableCell align="right" sx={{ fontWeight: 700 }}>{num(r.inBand)}</TableCell>
                  <TableCell align="right">{r.queued || <span style={{ color: '#c2c7d0' }}>—</span>}</TableCell>
                  <TableCell align="right">{r.traced || <span style={{ color: '#c2c7d0' }}>—</span>}</TableCell>
                  <TableCell align="right">{r.withEmail || <span style={{ color: '#c2c7d0' }}>—</span>}</TableCell>
                  <TableCell align="right" sx={{ color: r.verified ? '#1b6b2f' : undefined, fontWeight: r.verified ? 700 : 400 }}>
                    {r.verified || <span style={{ color: '#c2c7d0' }}>—</span>}
                  </TableCell>
                  <TableCell align="right" sx={{ color: r.failed ? '#b3261e' : undefined }}>
                    {r.failed || <span style={{ color: '#c2c7d0' }}>—</span>}
                  </TableCell>
                  <TableCell align="right" sx={{ fontWeight: 700 }}>{num(r.mailable)}</TableCell>
                  <TableCell align="right">{r.emailed || <span style={{ color: '#c2c7d0' }}>—</span>}</TableCell>
                  {/* Nought opened out of a hundred mailed is a finding; nought mailed is not. */}
                  <TableCell align="right" sx={{
                    color: r.emailed && !r.opened ? '#b3261e' : r.opened ? '#1b6b2f' : undefined,
                    fontWeight: r.opened || (r.emailed && !r.opened) ? 700 : 400,
                  }}>
                    {r.emailed
                      ? <>{r.opened}<span style={{ color: '#8a94a6', fontWeight: 400, fontSize: 11 }}>{' '}· {Math.round(r.opened / r.emailed * 100)}%</span></>
                      : <span style={{ color: '#c2c7d0' }}>—</span>}
                  </TableCell>
                  <TableCell align="right" sx={{ color: '#8a5a00' }}>{num(r.noContact)}</TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
          </Box>
          <Box sx={{ p: 1.5 }}>
            <Typography variant="caption" sx={{ display: 'block', color: '#5a6675' }}>
              Grade B → in the roof band (homes 21–76, roof unconfirmed) → queued for the
              skip-trace blast → traced → an address for the insured → verified by ZeroBounce
              → <strong>mailable</strong>.
            </Typography>
            <Typography variant="caption" sx={{ display: 'block', color: '#8a5a00', mt: 0.5 }}>
              There is no band price on these, so the email is the only thing that can start a
              conversation — which is why reach, not retention, is what this measures.
            </Typography>
          </Box>
        </Paper>
      )}

      {!loading && rows.length > 0 && shownGrade === 'A' && (
        <Paper variant="outlined">
          {/*
            Named, because there is now a co-insured table underneath it.

            Untitled it read as "the ledger"; beside a table called The co-insured it has
            to say which person it counts, or the pair looks like a whole and a part. The
            heading sits OUTSIDE the scrolling box — the table is twenty-odd columns wide
            and a title that slides away as you scroll right is worse than none.
          */}
          <Box sx={{ px: 2, pt: 2, pb: 1 }}>
            <Typography sx={{ fontWeight: 700, fontSize: 15 }}>The insured</Typography>
            <Typography variant="caption" sx={{ color: '#5a6675', display: 'block' }}>
              The person named on the policy — who email 1 of every cadence is written to.
              Mailable and Verified below count their addresses only.
            </Typography>
          </Box>
          <Box sx={{ overflowX: 'auto' }}>
          {/*
            Driven by LEDGER_COLUMNS, the same list the QC screen used.

            The first version of this page hand-wrote thirteen columns from the headings
            visible in a screenshot. That is not a smaller table — it is a different report
            wearing the same name, silently missing Call queue, Direct mail, No insured
            contact, Unworked A, Lost, Workable lost % and six more, along with the tooltips
            that explain the numbers people have argued about.
          */}
          {/* Twenty-odd columns, so this is the table that most needs its anchor: scrolled
              three columns right, a row of figures with no renewal week beside it belongs to
              nobody. */}
          <Table size="small" sx={stickyFirstColumn}>
            <TableHead>
              <TableRow>
                {LEDGER_COLUMNS.map((c) => (
                  <TableCell
                    key={c.header}
                    align={c.numeric ? 'right' : 'left'}
                    sx={{ fontWeight: 700, whiteSpace: 'nowrap' }}
                  >
                    {c.header}
                  </TableCell>
                ))}
              </TableRow>
            </TableHead>
            <TableBody>
              {(rows as LedgerRow[]).map((r) => (
                <TableRow key={String(r.cohort)}>
                  {LEDGER_COLUMNS.map((c) => (
                    <TableCell
                      key={c.header}
                      align={c.numeric ? 'right' : 'left'}
                      sx={{ whiteSpace: 'nowrap' }}
                    >
                      {c.cell ? c.cell(r) : c.value(r)}
                    </TableCell>
                  ))}
                </TableRow>
              ))}
            </TableBody>
          </Table>
          </Box>
          <Box sx={{ p: 1.5 }}>
            <Typography variant="caption" sx={{ display: 'block', color: '#5a6675' }}>
              Grade A at pull → downgraded → low point → regained Grade A → Grade A now →
              <strong> mailable</strong> (of those, how many have an insured email).
              {targetPct != null && ` Target is a loss of ${targetPct}% or less.`}
              {' '}↑ marks leads that were not Grade A at pull and are now.
            </Typography>
            <Typography variant="caption" sx={{ display: 'block', color: '#5a6675', mt: 0.5 }}>
              Rows are whole renewal weeks (Monday–Sunday). A date range is widened to the
              weeks it touches, so these totals will not match a report that starts or ends
              mid-week.
            </Typography>
          </Box>
        </Paper>
      )}

      {/*
        ── The co-insured, counted on its own (Abdullah, 9 Oct 2026) ───────────

        The ledger above reports the INSURED — insuredEmails() excludes everything
        belonging to the second person, so the co-insured had no number on this screen at
        all. There is no table for the insured here because the ledger already is one.

        It is not a fallback audience: it is mailed in its own right, with its own subject
        line and ask, and its verification sheets already come back split by role. The
        first thing it shows is the gap — C4 onward hold 488 co-insured addresses between
        them and one is confirmed, which is invisible while only the insured is reported.
      */}
      {!loading && rows.length > 0 && (() => {
        /*
         * One table, both tabs.
         *
         * The two ledgers name the same figure differently — the Grade A row calls it
         * coMailable, the Grade B row coWithEmail — so it is read through one accessor
         * rather than branching the whole table. Everything below is identical for both,
         * because the question is.
         */
        type CoRow = { cohort: string; coVerified: number; coOnly: number };
        const holds = (r: CoRow) => (r as unknown as { coMailable?: number; coWithEmail?: number }).coMailable
          ?? (r as unknown as { coWithEmail?: number }).coWithEmail ?? 0;
        const weeks = (rows as unknown as CoRow[]).filter((r) => holds(r) > 0);
        if (!weeks.length) return null;
        const sum = (f: (r: CoRow) => number) => weeks.reduce((a, r) => a + f(r), 0);
        const pct = (n: number, d: number) => (d ? `${Math.round((n / d) * 100)}%` : '—');
        const held = sum(holds);
        const ok = sum((r) => r.coVerified);

        const cell = (n: number, sx: object = {}) => (
          <TableCell align="right" sx={sx}>{n || <span style={{ color: '#c2c7d0' }}>—</span>}</TableCell>
        );

        return (
          <Paper variant="outlined" sx={{ mt: 2 }}>
            {/* Heading outside the scrolling box, same as The insured above it, so the
                pair reads as a pair at any window width. */}
            <Box sx={{ px: 2, pt: 2, pb: 1 }}>
              <Typography sx={{ fontWeight: 700, fontSize: 15 }}>The co-insured</Typography>
              <Typography variant="caption" sx={{ color: '#5a6675', display: 'block' }}>
                The spouse or co-owner on the policy, mailed in their own right with their own
                subject line and ask. The ledger above counts the insured only, so these
                accounts appear nowhere else.
              </Typography>
            </Box>
            <Box sx={{ overflowX: 'auto', px: 2, pb: 2 }}>
            <Table size="small" sx={stickyFirstColumn}>
              <TableHead>
                <TableRow>
                  {[
                    ['Week', ''],
                    ['Hold an address', 'We have an email address for the co-insured.'],
                    ['Confirmed', 'A verifier said that address exists.'],
                    ['Confirmed %', 'Of the addresses we hold for them, how many are confirmed.'],
                    ['Not confirmed', 'We hold an address but nobody has checked it, or it failed.'],
                    [
                      'Insured has none',
                      'The co-insured is confirmed and the insured is not — so the spouse’s address is '
                      + 'the only confirmed email on the account. Mail only the insured and these are never reached.',
                    ],
                  ].map(([h, help], i) => (
                    <TableCell key={h} align={i === 0 ? 'left' : 'right'} sx={{ fontWeight: 700, whiteSpace: 'nowrap' }}>
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
                {weeks.map((r) => (
                  <TableRow key={r.cohort} hover>
                    <TableCell sx={{ whiteSpace: 'nowrap' }}>{cohortCode(r.cohort) ?? r.cohort}</TableCell>
                    {cell(holds(r))}
                    {cell(r.coVerified, { color: r.coVerified ? '#1b6b2f' : undefined, fontWeight: r.coVerified ? 700 : 400 })}
                    {/* Never a dash: nought confirmed out of a hundred held is the finding. */}
                    <TableCell align="right" sx={{
                      color: r.coVerified ? '#5a6675' : '#b3261e',
                      fontWeight: r.coVerified ? 400 : 700,
                    }}>
                      {pct(r.coVerified, holds(r))}
                    </TableCell>
                    {cell(holds(r) - r.coVerified)}
                    {cell(r.coOnly, { color: r.coOnly ? '#8a5a00' : undefined, fontWeight: r.coOnly ? 700 : 400 })}
                  </TableRow>
                ))}
                <TableRow>
                  <TableCell sx={{ fontWeight: 700 }}>All</TableCell>
                  <TableCell align="right" sx={{ fontWeight: 700 }}>{held}</TableCell>
                  <TableCell align="right" sx={{ fontWeight: 700 }}>{ok}</TableCell>
                  <TableCell align="right" sx={{ fontWeight: 700 }}>{pct(ok, held)}</TableCell>
                  <TableCell align="right" sx={{ fontWeight: 700 }}>{held - ok}</TableCell>
                  <TableCell align="right" sx={{ fontWeight: 700 }}>{sum((r) => r.coOnly)}</TableCell>
                </TableRow>
              </TableBody>
            </Table>
            </Box>
          </Paper>
        );
      })()}
    </Container>
  );
}
