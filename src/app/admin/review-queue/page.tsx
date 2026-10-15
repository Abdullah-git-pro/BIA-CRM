'use client';

import React, { useCallback, useEffect, useRef, useState } from 'react';
import {
  Container, Box, Typography, Paper, Table, TableHead, TableRow, TableCell, TableBody,
  Chip, CircularProgress, Alert, Stack, Button, Tooltip,
} from '@mui/material';
import RefreshIcon from '@mui/icons-material/Refresh';
import Link from 'next/link';

/**
 * The human review queue (Abdullah, 14 Oct 2026).
 *
 * ── Why the question is the first column ────────────────────────────────────
 * Every row here is a decision somebody has to take, and the decisions are not alike. "A
 * relative is on the deed" and "the property appears to have been sold" are both a name
 * disagreement and need completely different handling. A queue that said only "needs review"
 * would make a reviewer rediscover which one it is on every row, so each row states the
 * question it is actually asking and carries the evidence to answer it.
 *
 * ── Ordered by answerability, not volume ────────────────────────────────────
 * The questions that can be settled in seconds come first; the ones needing a phone call or
 * a town id someone has to go and find come last. Sorting by size instead would open with
 * "not on any roll", which is the thing a reviewer can do least about.
 *
 * ── Deliberately read-only ──────────────────────────────────────────────────
 * Nothing is decided here. The card already holds the evidence and the override tools, and a
 * second place that can change a name is a second set of rules to keep in step. This screen
 * finds the work and hands it over.
 */

type ReviewKind =
  | 'owner_same_household' | 'owner_different' | 'unit_ambiguous' | 'not_on_roll'
  | 'coinsured_disagrees' | 'no_reachable_number';

type Item = {
  leadId: string; propertyId: string | null; cohort: string | null; code: string | null;
  label: string; kind: ReviewKind; question: string;
  owner: string | null; coInsured: string | null; address: string | null;
  rollName: string | null; coRollName: string | null; detail: string | null;
};

const KIND_LABEL: Record<ReviewKind, string> = {
  owner_same_household: 'A relative may be on the deed',
  owner_different: 'The owner looks like a different person',
  unit_ambiguous: 'Which unit is ours',
  not_on_roll: 'Not on any roll we can reach',
  coinsured_disagrees: 'The co-insured disagrees with the roll',
  no_reachable_number: 'No number reaches this household',
};

/** How to settle it — written once here rather than repeated on every row. */
const KIND_HOW: Record<ReviewKind, string> = {
  owner_same_household: 'Same surname, different given name. Usually a spouse or parent on title — the policyholder is still ours.',
  owner_different: 'No part of the name matches. Often a sale the policy has not caught up with.',
  unit_ambiguous: 'The building is on the roll but several units came back. Pick ours or leave it.',
  not_on_roll: 'The address was already retried with every spelling and every town we hold.',
  coinsured_disagrees: 'The card and the deed name different second people.',
  no_reachable_number: 'Every checked number belongs to somebody else. Post is the remaining channel.',
};

const KIND_COLOUR: Record<ReviewKind, { bg: string; fg: string }> = {
  owner_same_household: { bg: '#fff3d6', fg: '#8a5a00' },
  coinsured_disagrees: { bg: '#fff3d6', fg: '#8a5a00' },
  unit_ambiguous: { bg: '#e3f2fd', fg: '#1565c0' },
  owner_different: { bg: '#fdeaea', fg: '#b3261e' },
  no_reachable_number: { bg: '#fdeaea', fg: '#b3261e' },
  not_on_roll: { bg: '#f1f3f5', fg: '#5c6b78' },
};

export default function ReviewQueuePage() {
  const [items, setItems] = useState<Item[]>([]);
  const [counts, setCounts] = useState<Record<string, number>>({});
  const [cohorts, setCohorts] = useState<Array<{ cohort: string; code: string | null; label: string; count: number }>>([]);
  const [blocked, setBlocked] = useState<{ total: number; byZip: Array<{ zip: string; city: string | null; count: number }> } | null>(null);
  const [filter, setFilter] = useState<ReviewKind | null>(null);
  /**
   * The week filter is independent of the kind filter, so the two combine: "the co-insured
   * questions in C7" is the shape of an afternoon's work, and either alone is not.
   */
  const [week, setWeek] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const seqRef = useRef(0);

  const load = useCallback(async () => {
    const seq = ++seqRef.current;
    setLoading(true);
    setError(null);
    try {
      const res = await fetch('/api/admin/review-queue?grade=A');
      const json = await res.json();
      if (!res.ok) throw new Error(json.error || 'Could not load the queue');
      if (seq !== seqRef.current) return;
      setItems(json.items ?? []);
      setCounts(json.counts ?? {});
      setCohorts(json.cohorts ?? []);
      setBlocked(json.blocked ?? null);
    } catch (err) {
      if (seq !== seqRef.current) return;
      setError(err instanceof Error ? err.message : 'Something went wrong');
    } finally {
      if (seq === seqRef.current) setLoading(false);
    }
  }, []);

  useEffect(() => { load(); }, [load]);

  const shown = items.filter((i) => (!filter || i.kind === filter) && (!week || i.cohort === week));
  const order = Object.keys(KIND_LABEL) as ReviewKind[];

  return (
    <Container maxWidth="xl" sx={{ py: 4 }}>
      <Box sx={{ mb: 3 }}>
        <Typography variant="h4" component="h1" sx={{ fontWeight: 'bold', mb: 0.5 }}>
          Needs a person
        </Typography>
        <Typography variant="body2" color="text.secondary">
          Grade A, C1–C8 — every card the tax roll or the identity check could not settle on
          its own. Each row says what the decision is; the card holds the tools to make it.
        </Typography>
      </Box>

      <Stack direction="row" sx={{ alignItems: 'center', gap: 1, mb: 2 }}>
        <Button size="small" variant="outlined" startIcon={<RefreshIcon />} onClick={load} disabled={loading}>
          Refresh
        </Button>
        {loading && <CircularProgress size={16} />}
      </Stack>

      {error && <Alert severity="error" sx={{ mb: 2 }}>{error}</Alert>}

      <Stack direction="row" spacing={1.5} sx={{ mb: 2, flexWrap: 'wrap', gap: 1.5 }}>
        <Paper
          variant="outlined"
          onClick={() => setFilter(null)}
          sx={{ px: 2, py: 1.25, minWidth: 120, cursor: 'pointer',
            borderColor: filter === null ? '#1565c0' : undefined, borderWidth: filter === null ? 2 : 1 }}
        >
          <Typography sx={{ fontSize: 24, fontWeight: 700, lineHeight: 1.1 }}>{items.length}</Typography>
          <Typography variant="caption" sx={{ color: '#5a6675' }}>Everything</Typography>
        </Paper>
        {order.filter((k) => (counts[k] ?? 0) > 0).map((k) => {
          const active = filter === k;
          const c = KIND_COLOUR[k];
          return (
            <Paper
              key={k}
              variant="outlined"
              onClick={() => setFilter(k)}
              sx={{ px: 2, py: 1.25, minWidth: 170, cursor: 'pointer',
                borderColor: active ? '#1565c0' : undefined, borderWidth: active ? 2 : 1,
                bgcolor: active ? '#f5f9ff' : undefined }}
            >
              <Typography sx={{ fontSize: 24, fontWeight: 700, lineHeight: 1.1, color: c.fg }}>
                {counts[k]}
              </Typography>
              <Typography variant="caption" sx={{ color: '#5a6675' }}>{KIND_LABEL[k]}</Typography>
            </Paper>
          );
        })}
      </Stack>

      {/*
        Weeks as chips rather than a dropdown: there are at most eight, the counts are the
        useful part, and a dropdown hides which weeks carry the work.
      */}
      {cohorts.length > 1 && (
        <Stack direction="row" spacing={0.75} sx={{ mb: 2, flexWrap: 'wrap', gap: 0.75, alignItems: 'center' }}>
          <Typography variant="caption" sx={{ color: '#5a6675', mr: 0.5 }}>Week</Typography>
          <Chip
            size="small" label={`All (${items.length})`}
            onClick={() => setWeek(null)}
            variant={week === null ? 'filled' : 'outlined'}
            sx={week === null
              ? { bgcolor: '#1565c0', color: '#fff', fontWeight: 700 }
              : { borderColor: '#1565c0', color: '#1565c0' }}
          />
          {cohorts.map((c) => {
            // Counted against the kind filter, so the chips say what clicking will actually
            // give you rather than the week's total.
            const n = filter ? items.filter((i) => i.cohort === c.cohort && i.kind === filter).length : c.count;
            const active = week === c.cohort;
            return (
              <Chip
                key={c.cohort}
                size="small"
                label={`${c.code ?? c.cohort} · ${n}`}
                onClick={() => setWeek(active ? null : c.cohort)}
                variant={active ? 'filled' : 'outlined'}
                disabled={n === 0}
                sx={active
                  ? { bgcolor: '#1565c0', color: '#fff', fontWeight: 700 }
                  : { borderColor: '#c6ccd6', color: n === 0 ? '#c6ccd6' : '#334' }}
              />
            );
          })}
        </Stack>
      )}

      {/*
        Shown apart from the queue, not in it.

        Old Bridge, Matawan and Aberdeen each run their tax portal on a different system, so
        there is no roll to read and no id anybody can fetch. A reviewer opening one of these
        can do nothing with it, and a queue that keeps offering them teaches people to scroll
        past the whole screen. The count still has to be visible — it is real work, it just
        needs a data source rather than a decision.
      */}
      {!!blocked?.total && (
        <Alert severity="info" sx={{ mb: 2 }}>
          <strong>{blocked.total} cards cannot be checked at all</strong> — these townships do
          not publish a roll on a system we can read, so there is nothing for a reviewer to
          decide. They need a data extract from the town, not a look.
          <Box sx={{ mt: 0.5, fontSize: 12.5 }}>
            {blocked.byZip.map((b) => `${b.city ?? b.zip} (${b.zip}) — ${b.count}`).join(' · ')}
          </Box>
        </Alert>
      )}

      {filter && (
        <Alert severity="info" sx={{ mb: 2 }}>{KIND_HOW[filter]}</Alert>
      )}

      <Paper variant="outlined" sx={{ overflowX: 'auto' }}>
        <Table size="small" stickyHeader>
          <TableHead>
            <TableRow>
              {['Week', 'Card', 'The question', 'The card says', 'The roll says', 'Why']
                .map((h) => (
                  <TableCell key={h} sx={{ fontWeight: 700, whiteSpace: 'nowrap' }}>{h}</TableCell>
                ))}
            </TableRow>
          </TableHead>
          <TableBody>
            {shown.map((i, idx) => {
              const c = KIND_COLOUR[i.kind];
              return (
                <TableRow key={`${i.leadId}-${i.kind}-${idx}`} hover>
                  <TableCell sx={{ whiteSpace: 'nowrap' }}>
                    <Box sx={{ fontWeight: 700, fontSize: 13 }}>{i.code ?? i.cohort}</Box>
                    <Box sx={{ fontSize: 10.5, color: '#8a94a6' }}>{i.label}</Box>
                  </TableCell>
                  <TableCell sx={{ whiteSpace: 'nowrap' }}>
                    {i.propertyId
                      ? <Link href={`/leads/${i.propertyId}`} style={{ color: '#1565c0', textDecoration: 'none', fontWeight: 600 }}>{i.owner ?? i.propertyId}</Link>
                      : (i.owner ?? '—')}
                    <Box sx={{ fontSize: 11, color: '#8a94a6' }}>{i.address}</Box>
                  </TableCell>
                  <TableCell sx={{ maxWidth: 360 }}>
                    <Chip size="small" label={KIND_LABEL[i.kind]}
                      sx={{ height: 19, fontSize: 10.5, bgcolor: c.bg, color: c.fg, fontWeight: 600, mb: 0.4 }} />
                    <Box sx={{ fontSize: 12.5 }}>{i.question}</Box>
                  </TableCell>
                  <TableCell sx={{ fontSize: 12 }}>
                    {i.owner ?? '—'}
                    {i.coInsured ? <Box sx={{ fontSize: 11, color: '#5a6675' }}>+ {i.coInsured}</Box> : null}
                  </TableCell>
                  {/* Verbatim: it is the evidence, and our reading of it is what is in question. */}
                  <TableCell sx={{ fontSize: 12, fontFamily: 'ui-monospace, monospace' }}>
                    {i.rollName ?? '—'}
                    {i.coRollName ? <Box sx={{ fontSize: 11 }}>+ {i.coRollName}</Box> : null}
                  </TableCell>
                  <TableCell sx={{ fontSize: 11.5, color: '#5a6675', maxWidth: 300 }}>
                    {i.detail ? (
                      <Tooltip title={i.detail}>
                        <span>{i.detail.length > 90 ? `${i.detail.slice(0, 89)}…` : i.detail}</span>
                      </Tooltip>
                    ) : '—'}
                  </TableCell>
                </TableRow>
              );
            })}
            {!shown.length && !loading && (
              <TableRow>
                <TableCell colSpan={6} sx={{ textAlign: 'center', py: 4, color: '#888' }}>
                  Nothing waiting. That is the number you want.
                </TableCell>
              </TableRow>
            )}
          </TableBody>
        </Table>
      </Paper>
    </Container>
  );
}
