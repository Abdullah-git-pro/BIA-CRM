'use client';

import React, { useCallback, useEffect, useState } from 'react';
import {
  Box, Paper, Typography, Stack, Chip, Button, Alert, CircularProgress,
  Table, TableHead, TableRow, TableCell, TableBody,
} from '@mui/material';
import RefreshIcon from '@mui/icons-material/Refresh';
import Link from 'next/link';

/**
 * The bounces for THIS campaign.
 *
 * The analytics card above reports "0.4% — 1 bounced" and stops there, which is the one
 * number that cannot be acted on: it does not say which address died, whether the failure
 * was permanent, or whether anything stopped mailing it. This is that bounce, in the
 * campaign that produced it, so the rate and the detail are read in the same place.
 *
 * Built from the webhook records we already keep. The platform has its own Bounces tab but
 * exposes no endpoint behind it — /campaigns/{id}/bounces and /bounces both 404 — so this
 * reads our own database and keeps working when the platform does not.
 */

type BounceRow = {
  bouncedAt: string; type: 'hard' | 'soft' | 'unknown'; reason: string | null;
  email: string; sentFrom: string | null; step: number | null; person: string | null;
  cohort: string | null; owner: string | null; propertyId: string | null; suppressed: boolean;
};

type Counts = { total: number; hard: number; soft: number; unknown: number; hardNotSuppressed: number };

export default function CampaignBouncesPanel({ campaignId }: { campaignId: string }) {
  const [rows, setRows] = useState<BounceRow[]>([]);
  const [counts, setCounts] = useState<Counts | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const res = await fetch(`/api/lead-campaigns/bounces?campaignId=${encodeURIComponent(campaignId)}`);
      const json = await res.json();
      if (!res.ok) throw new Error(json.error || 'Could not load bounces');
      setRows(json.data ?? []);
      setCounts(json.counts ?? null);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Something went wrong');
    } finally {
      setLoading(false);
    }
  }, [campaignId]);

  useEffect(() => { load(); }, [load]);

  return (
    <Box>
      <Stack direction="row" sx={{ alignItems: 'center', gap: 1, mb: 1.5 }}>
        <Button size="small" variant="outlined" startIcon={<RefreshIcon />} onClick={load} disabled={loading}>
          Refresh
        </Button>
        {loading && <CircularProgress size={16} />}
      </Stack>

      {error && <Alert severity="error" sx={{ mb: 2 }}>{error}</Alert>}

      {/*
        Hard and soft are shown apart, never totalled.

        One is a dead address that must stop being mailed, the other a full mailbox or a
        momentary server fault. The platform's own tab separates them for the same reason,
        and a single "bounces" number hides the only distinction that matters.
      */}
      <Stack direction="row" spacing={2} sx={{ mb: 2, flexWrap: 'wrap', gap: 2 }}>
        {[
          { label: 'Total', value: counts?.total ?? 0 },
          { label: 'Hard — address is dead', value: counts?.hard ?? 0, bad: true },
          { label: 'Soft — try again later', value: counts?.soft ?? 0 },
          { label: 'Unclassified', value: counts?.unknown ?? 0, warn: true },
        ].map((s) => (
          <Paper key={s.label} variant="outlined" sx={{ px: 2, py: 1.25, minWidth: 170 }}>
            <Typography sx={{ fontSize: 24, fontWeight: 700, lineHeight: 1.1,
              color: s.bad && s.value ? '#b3261e' : s.warn && s.value ? '#8a5a00' : undefined }}>
              {s.value}
            </Typography>
            <Typography variant="caption" sx={{ color: '#5a6675' }}>{s.label}</Typography>
          </Paper>
        ))}
      </Stack>

      {/*
        The one thing the platform's own screen cannot tell you: whether the bounce
        actually did anything. Our first real bounce was stored as soft because the payload
        carried no type, so it never suppressed and the address stayed in the sequence. A
        count alone would not have shown that.
      */}
      {!!counts?.hardNotSuppressed && (
        <Alert severity="error" sx={{ mb: 2 }}>
          {counts.hardNotSuppressed} hard {counts.hardNotSuppressed === 1 ? 'bounce has' : 'bounces have'}
          {' '}not suppressed the address. Those are still being mailed.
        </Alert>
      )}

      <Paper variant="outlined" sx={{ overflowX: 'auto' }}>
        <Table size="small">
          <TableHead>
            <TableRow>
              {['When', 'Address', 'Owner', 'Type', 'Reason', 'Sent from', 'Step', 'Week', 'Suppressed']
                .map((h) => (
                  <TableCell key={h} sx={{ fontWeight: 700, whiteSpace: 'nowrap' }}>{h}</TableCell>
                ))}
            </TableRow>
          </TableHead>
          <TableBody>
            {rows.map((b, i) => (
              <TableRow key={`${b.email}-${i}`} hover>
                <TableCell sx={{ whiteSpace: 'nowrap', fontSize: 12 }}>
                  {new Date(b.bouncedAt).toLocaleString('en-GB', { dateStyle: 'short', timeStyle: 'short' })}
                </TableCell>
                <TableCell sx={{ fontSize: 12 }}>{b.email}</TableCell>
                <TableCell sx={{ fontSize: 12 }}>
                  {b.propertyId
                    ? <Link href={`/leads/${b.propertyId}`} style={{ color: '#1565c0', textDecoration: 'none' }}>{b.owner ?? b.propertyId}</Link>
                    : (b.owner ?? '—')}
                </TableCell>
                <TableCell>
                  <Chip size="small" label={b.type}
                    color={b.type === 'hard' ? 'error' : b.type === 'soft' ? 'warning' : 'default'}
                    variant={b.type === 'unknown' ? 'outlined' : 'filled'} />
                </TableCell>
                <TableCell sx={{ fontSize: 12, color: '#5a6675' }}>{b.reason ?? '—'}</TableCell>
                <TableCell sx={{ fontSize: 12, color: '#5a6675' }}>{b.sentFrom ?? '—'}</TableCell>
                <TableCell sx={{ fontSize: 12 }}>{b.step ?? '—'}</TableCell>
                <TableCell sx={{ fontSize: 12 }}>{b.cohort ?? '—'}</TableCell>
                <TableCell>
                  {b.suppressed
                    ? <Chip size="small" label="yes" sx={{ bgcolor: '#e7f5ec', color: '#166534' }} />
                    : <Chip size="small" label="NO" color={b.type === 'hard' ? 'error' : 'default'}
                        variant={b.type === 'hard' ? 'filled' : 'outlined'} />}
                </TableCell>
              </TableRow>
            ))}
            {!rows.length && !loading && (
              <TableRow>
                <TableCell colSpan={9} sx={{ textAlign: 'center', py: 4, color: '#888' }}>
                  No bounces on this campaign. That is the number you want.
                </TableCell>
              </TableRow>
            )}
          </TableBody>
        </Table>
      </Paper>
    </Box>
  );
}
