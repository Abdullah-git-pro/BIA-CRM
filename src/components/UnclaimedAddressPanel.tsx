'use client';

import React, { useCallback, useEffect, useState } from 'react';
import {
  Box, Paper, Stack, Typography, Button, Chip, Alert, CircularProgress,
} from '@mui/material';
import BlockIcon from '@mui/icons-material/Block';
import CheckCircleIcon from '@mui/icons-material/CheckCircle';

/**
 * Addresses this property's trace returned and attributed to nobody.
 *
 * ── Why this sits on the card as well as in the queue ───────────────────────
 * The Name check screen is where a short list gets cleared in one sitting. This is where
 * the question gets answered properly, because the answer depends on everything else on
 * the card — the other people the trace returned, the phone numbers, the name the tax roll
 * holds. Deciding whether waqasashraf78@gmail.com is Waqas Ashraf is a glance; deciding
 * whether svobodajoan@gmail.com is Charles Hulme needs the rest of the record in view.
 *
 * ── It appears only when there is something to decide ───────────────────────
 * A panel that renders an empty state on every lead is a panel people stop seeing. Most
 * cards have no unclaimed addresses and show nothing at all.
 */

type Candidate = {
  id: string;
  email: string;
  verdict: string;
  decision: 'approved' | 'rejected' | null;
  decidedBy: string | null;
};

export default function UnclaimedAddressPanel({
  leadId,
  onChanged,
}: {
  leadId: string;
  /** The approved address lands on the lead, so the card reloads to show it. */
  onChanged?: () => void;
}) {
  const [rows, setRows] = useState<Candidate[]>([]);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      const res = await fetch(`/api/admin/name-review?leadId=${encodeURIComponent(leadId)}&view=all`);
      const json = await res.json();
      if (!res.ok) throw new Error(json.error || 'Could not load the unclaimed addresses');
      setRows((json.rows ?? []).filter((r: Candidate) => r.verdict === 'pool_candidate'));
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not load the unclaimed addresses');
    } finally {
      setLoading(false);
    }
  }, [leadId]);

  useEffect(() => { void load(); }, [load]);

  const decide = async (row: Candidate, decision: 'approved' | 'rejected') => {
    setBusy(row.id);
    try {
      const res = await fetch('/api/admin/name-review', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ ids: [row.id], decision }),
      });
      const json = await res.json();
      if (!res.ok) throw new Error(json.error || 'Could not save that decision');
      await load();
      // Approving writes the address onto the lead, so the card above is now stale.
      if (decision === 'approved') onChanged?.();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not save that decision');
    } finally {
      setBusy(null);
    }
  };

  if (loading) {
    return null;   // Nothing to announce while we find out whether there is anything to show.
  }
  if (!rows.length) return null;

  const open = rows.filter((r) => !r.decision);

  return (
    <Paper variant="outlined" sx={{ p: 2.5, mt: 2, borderColor: '#f0b429', bgcolor: '#fffbf0' }}>
      <Stack direction="row" spacing={1} sx={{ alignItems: 'center', mb: 0.5, flexWrap: 'wrap' }}>
        <Typography variant="subtitle1" sx={{ fontWeight: 700 }}>
          Unclaimed addresses
        </Typography>
        <Chip size="small" color="warning" variant="outlined" label={`${open.length} to decide`} />
      </Stack>

      <Typography variant="body2" color="text.secondary">
        Skip tracing returned {rows.length === 1 ? 'this address' : `these ${rows.length} addresses`}
        {' '}for the property and attributed {rows.length === 1 ? 'it' : 'them'} to nobody, so the
        {' '}campaign will not use {rows.length === 1 ? 'it' : 'them'}.
        {/* "like" lives inside the expression on purpose: a space in the text immediately
            after a closing brace gets trimmed here, which rendered "They readlike". */}
        {' '}{rows.length === 1 ? 'It reads like' : 'They read like'}
        {' '}the insured&apos;s own name.
      </Typography>
      <Typography variant="caption" color="text.secondary" sx={{ display: 'block', mt: 0.5 }}>
        Approving puts the address on this lead and the campaign can use it. More than one may
        be theirs — approve each that is. Check the other people on this card first: the same
        pool carries relatives and previous owners.
      </Typography>

      {error && <Alert severity="error" sx={{ mt: 1.5 }}>{error}</Alert>}

      <Box sx={{ mt: 1.5 }}>
        {rows.map((r) => (
          <Stack
            key={r.id}
            direction={{ xs: 'column', sm: 'row' }}
            spacing={1.5}
            sx={{
              alignItems: { sm: 'center' }, justifyContent: 'space-between',
              py: 1.25, borderTop: '1px solid', borderColor: 'divider',
              opacity: busy === r.id ? 0.55 : 1,
            }}
          >
            <Typography sx={{ fontFamily: 'monospace', fontWeight: 600, wordBreak: 'break-all', minWidth: 0 }}>
              {r.email}
            </Typography>

            {r.decision ? (
              <Chip
                size="small"
                color={r.decision === 'approved' ? 'success' : 'default'}
                label={`${r.decision === 'approved' ? 'Added to this lead' : 'Not them'}`
                  + `${r.decidedBy ? ` · ${r.decidedBy}` : ''}`}
                sx={{ flexShrink: 0 }}
              />
            ) : (
              <Stack
                direction={{ xs: 'column', sm: 'row' }}
                spacing={1.5}
                sx={{ flexShrink: 0, width: { xs: '100%', sm: 'auto' } }}
              >
                <Button
                  size="small" variant="outlined" color="error"
                  disabled={busy === r.id}
                  startIcon={<BlockIcon />}
                  onClick={() => void decide(r, 'rejected')}
                  sx={{ minWidth: { sm: 120 }, width: { xs: '100%', sm: 'auto' } }}
                >
                  Not them
                </Button>
                <Button
                  size="small" variant="contained" color="success"
                  disabled={busy === r.id}
                  startIcon={busy === r.id ? <CircularProgress size={16} color="inherit" /> : <CheckCircleIcon />}
                  onClick={() => void decide(r, 'approved')}
                  sx={{ minWidth: { sm: 140 }, width: { xs: '100%', sm: 'auto' } }}
                >
                  Yes, it&apos;s them
                </Button>
              </Stack>
            )}
          </Stack>
        ))}
      </Box>
    </Paper>
  );
}
