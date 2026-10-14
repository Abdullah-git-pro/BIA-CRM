'use client';

import React, { useCallback, useEffect, useRef, useState } from 'react';
import { useParams, useRouter, useSearchParams } from 'next/navigation';
import {
  Container, Box, Typography, Paper, Table, TableHead, TableRow, TableCell, TableBody,
  Chip, CircularProgress, Alert, Stack, Button, Tooltip,
} from '@mui/material';
import ArrowBackIcon from '@mui/icons-material/ArrowBack';
import RefreshIcon from '@mui/icons-material/Refresh';
import Link from 'next/link';

/**
 * One renewal week's leads, and what the tax roll said about each.
 *
 * The summary screen says "6 to review"; this is where the six are. The buckets use the same
 * words as the chips that led here — confirmed / to review / not on roll — because a drill-in
 * that renames the thing you clicked makes you check whether it is the same number.
 *
 * Clicking a bucket filters to it. Everything needing a person sorts to the top, so the work
 * is at the top of the page rather than somewhere inside 179 rows of surnames.
 */

type Bucket = 'confirmed' | 'review' | 'not_on_roll' | 'not_checked';

type Lead = {
  leadId: string; propertyId: string | null; owner: string | null; coInsured: string | null;
  address: string | null; rollName: string | null; rollStatus: string | null;
  detail: string | null; bucket: Bucket; coStatus: string | null; coRollName: string | null;
  traced: boolean; tracedBeforeRoll: boolean;
};

type Counts = {
  total: number; confirmed: number; review: number;
  notOnRoll: number; notChecked: number; tracedBeforeRoll: number;
};

const BUCKET_CHIP: Record<Bucket, { label: string; bg: string; fg: string }> = {
  confirmed:   { label: 'confirmed',   bg: '#e7f5ec', fg: '#166534' },
  review:      { label: 'to review',   bg: '#fff3d6', fg: '#8a5a00' },
  not_on_roll: { label: 'not on roll', bg: '#f1f3f5', fg: '#5c6b78' },
  not_checked: { label: 'not checked', bg: '#eef2ff', fg: '#3949ab' },
};

export default function PipelineCohortPage() {
  const { cohort } = useParams<{ cohort: string }>();
  const search = useSearchParams();
  const router = useRouter();
  const grade = search.get('grade') || 'A';

  const [leads, setLeads] = useState<Lead[]>([]);
  const [counts, setCounts] = useState<Counts | null>(null);
  const [meta, setMeta] = useState<{ code: string | null; label: string } | null>(null);
  const [filter, setFilter] = useState<Bucket | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const seqRef = useRef(0);

  const load = useCallback(async () => {
    const seq = ++seqRef.current;
    setLoading(true);
    setError(null);
    try {
      const res = await fetch(`/api/admin/pipeline/${cohort}?grade=${encodeURIComponent(grade)}`);
      const json = await res.json();
      if (!res.ok) throw new Error(json.error || 'Could not load the week');
      if (seq !== seqRef.current) return;
      setLeads(json.leads ?? []);
      setCounts(json.counts ?? null);
      setMeta({ code: json.code ?? null, label: json.label ?? '' });
    } catch (err) {
      if (seq !== seqRef.current) return;
      setError(err instanceof Error ? err.message : 'Something went wrong');
    } finally {
      if (seq === seqRef.current) setLoading(false);
    }
  }, [cohort, grade]);

  useEffect(() => { load(); }, [load]);

  const shown = filter ? leads.filter((l) => l.bucket === filter) : leads;

  return (
    <Container maxWidth="xl" sx={{ py: 4 }}>
      <Button size="small" startIcon={<ArrowBackIcon />} onClick={() => router.push('/admin/pipeline')} sx={{ mb: 1 }}>
        All weeks
      </Button>

      <Box sx={{ mb: 2 }}>
        <Typography variant="h4" component="h1" sx={{ fontWeight: 'bold', mb: 0.5 }}>
          {meta?.code ?? cohort} · Grade {grade}
        </Typography>
        <Typography variant="body2" color="text.secondary">
          {meta?.label} — what the municipal tax roll says about each lead in this week
        </Typography>
      </Box>

      <Stack direction="row" sx={{ alignItems: 'center', gap: 1, mb: 2 }}>
        <Button size="small" variant="outlined" startIcon={<RefreshIcon />} onClick={load} disabled={loading}>
          Refresh
        </Button>
        {loading && <CircularProgress size={16} />}
      </Stack>

      {error && <Alert severity="error" sx={{ mb: 2 }}>{error}</Alert>}

      {/* The same four words as the chips on the summary, and each one filters the list. */}
      {counts && (
        <Stack direction="row" spacing={2} sx={{ mb: 2, flexWrap: 'wrap', gap: 2 }}>
          {([
            { key: null, label: 'All leads', value: counts.total },
            { key: 'confirmed' as Bucket, label: 'Confirmed on the roll', value: counts.confirmed },
            { key: 'review' as Bucket, label: 'Needs a person', value: counts.review },
            { key: 'not_on_roll' as Bucket, label: 'Not on the roll', value: counts.notOnRoll },
            { key: 'not_checked' as Bucket, label: 'Roll not run yet', value: counts.notChecked },
          ]).map((s) => {
            const active = filter === s.key;
            return (
              <Paper
                key={s.label}
                variant="outlined"
                onClick={() => setFilter(s.key)}
                sx={{
                  px: 2, py: 1.25, minWidth: 165, cursor: 'pointer',
                  borderColor: active ? '#1565c0' : undefined,
                  borderWidth: active ? 2 : 1,
                  bgcolor: active ? '#f5f9ff' : undefined,
                }}
              >
                <Typography sx={{ fontSize: 24, fontWeight: 700, lineHeight: 1.1,
                  color: s.key === 'review' && s.value ? '#8a5a00' : undefined }}>
                  {s.value.toLocaleString()}
                </Typography>
                <Typography variant="caption" sx={{ color: '#5a6675' }}>{s.label}</Typography>
              </Paper>
            );
          })}
        </Stack>
      )}

      {!!counts?.tracedBeforeRoll && (
        <Alert severity="warning" sx={{ mb: 2 }}>
          {counts.tracedBeforeRoll} of these were skip traced before the roll was consulted —
          searched for under a name nobody had checked.
        </Alert>
      )}

      <Paper variant="outlined" sx={{ overflowX: 'auto' }}>
        <Table size="small" stickyHeader>
          <TableHead>
            <TableRow>
              {['Status', 'Insured (card)', 'The roll says', 'Why', 'Co-insured (card)', 'Co-insured (roll)', 'Address', 'Traced']
                .map((h) => (
                  <TableCell key={h} sx={{ fontWeight: 700, whiteSpace: 'nowrap' }}>{h}</TableCell>
                ))}
            </TableRow>
          </TableHead>
          <TableBody>
            {shown.map((l) => {
              const b = BUCKET_CHIP[l.bucket];
              return (
                <TableRow key={l.leadId} hover>
                  <TableCell>
                    <Chip size="small" label={b.label}
                      sx={{ height: 20, fontSize: 11, bgcolor: b.bg, color: b.fg, fontWeight: 600 }} />
                  </TableCell>
                  <TableCell sx={{ fontSize: 13, fontWeight: 600, whiteSpace: 'nowrap' }}>
                    {l.propertyId
                      ? <Link href={`/leads/${l.propertyId}`} style={{ color: '#1565c0', textDecoration: 'none' }}>{l.owner ?? l.propertyId}</Link>
                      : (l.owner ?? '—')}
                  </TableCell>
                  {/* Verbatim, including the roll's own punctuation — it is evidence, not a label. */}
                  <TableCell sx={{ fontSize: 12, fontFamily: 'ui-monospace, monospace' }}>{l.rollName ?? '—'}</TableCell>
                  <TableCell sx={{ fontSize: 12, color: '#5a6675', maxWidth: 320 }}>
                    {l.detail ? (
                      <Tooltip title={l.detail}>
                        <span>{l.detail.length > 70 ? `${l.detail.slice(0, 69)}…` : l.detail}</span>
                      </Tooltip>
                    ) : '—'}
                  </TableCell>
                  <TableCell sx={{ fontSize: 12 }}>{l.coInsured ?? '—'}</TableCell>
                  <TableCell sx={{ fontSize: 12 }}>
                    {l.coRollName ?? <span style={{ color: '#8a94a6' }}>{l.coStatus === 'none_on_roll' ? 'none listed' : '—'}</span>}
                  </TableCell>
                  <TableCell sx={{ fontSize: 12, color: '#5a6675' }}>{l.address ?? '—'}</TableCell>
                  <TableCell sx={{ whiteSpace: 'nowrap' }}>
                    {l.tracedBeforeRoll
                      ? <Tooltip title="Traced before the roll was consulted — on an unchecked name">
                          <Chip size="small" label="before the roll" sx={{ height: 19, fontSize: 10.5, bgcolor: '#fdeaea', color: '#b3261e', fontWeight: 600 }} />
                        </Tooltip>
                      : l.traced
                        ? <Chip size="small" label="traced" sx={{ height: 19, fontSize: 10.5, bgcolor: '#e7f5ec', color: '#166534' }} />
                        : <span style={{ color: '#8a94a6', fontSize: 12 }}>not traced</span>}
                  </TableCell>
                </TableRow>
              );
            })}
            {!shown.length && !loading && (
              <TableRow>
                <TableCell colSpan={8} sx={{ textAlign: 'center', py: 4, color: '#888' }}>
                  {filter ? 'Nothing in this bucket.' : 'No leads in this week at this grade.'}
                </TableCell>
              </TableRow>
            )}
          </TableBody>
        </Table>
      </Paper>
    </Container>
  );
}
