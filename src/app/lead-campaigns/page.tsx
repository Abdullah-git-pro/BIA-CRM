'use client';

import React, { useCallback, useEffect, useState } from 'react';
import {
  Container, Box, Typography, Paper, Tabs, Tab, Table, TableHead, TableRow, TableCell,
  TableBody, Chip, CircularProgress, Alert, Stack, Button, LinearProgress,
} from '@mui/material';
import CampaignIcon from '@mui/icons-material/Campaign';
import MarkEmailReadIcon from '@mui/icons-material/MarkEmailRead';
import RefreshIcon from '@mui/icons-material/Refresh';
import AddIcon from '@mui/icons-material/Add';
import { useRouter } from 'next/navigation';
import CampaignCreateDialog from '@/components/CampaignCreateDialog';
import MailboxRowActions from '@/components/MailboxRowActions';
import MailboxDetailDrawer from '@/components/MailboxDetailDrawer';
import { stickyFirstColumn, scrollableTable } from '@/lib/stickyColumn';

/**
 * Lead Campaigns — its own module.
 *
 * Deliberately separate from the Leads pages: the campaign platform is the system of
 * record for everything shown here, so this screen reads from the vendor rather than
 * from our database, and the numbers move for reasons no CRM edit explains. Mixing it
 * into the Leads table would blur that line.
 *
 * Each tab talks only to its own narrow route. There is no shared mega-component
 * holding all of this state, so a tab can be added later without touching the others.
 */

type TabKey = 'campaigns' | 'mailboxes';

type CampaignRow = {
  id: string; name: string; status: number; statusLabel: string;
  createdAt?: string | null;
  leads: number; leadsTruncated?: boolean; contacted: number; completed: number; sent: number; opens: number; replies: number;
  clicks: number; bounced: number; unsubscribed: number;
  openRate: number | null; replyRate: number | null; bounceRate: number | null;
};

type MailboxRow = {
  email: string; domain: string; name: string | null; active: boolean;
  warmingUp: boolean; warmupScore: number | null; dailyLimit: number; trackingDomain: string | null;
  status: number | null; setupPending: boolean; statusLabel: string;
};


const statusColor = (status: number): { bg: string; fg: string } =>
  status === 1 ? { bg: '#dcfce7', fg: '#166534' }      // active
  : status === 2 ? { bg: '#fff3d6', fg: '#8a5a00' }    // paused
  : status === 3 ? { bg: '#e8eaed', fg: '#5c6b78' }    // completed
  : { bg: '#e3f2fd', fg: '#1565c0' };                  // draft / other

const pct = (v: number | null) => (v == null ? '—' : `${v}%`);

export default function LeadCampaignsPage() {
  const [tab, setTab] = useState<TabKey>('campaigns');
  const [campaigns, setCampaigns] = useState<CampaignRow[]>([]);
  const [mailboxes, setMailboxes] = useState<MailboxRow[]>([]);
  const [mailboxTotals, setMailboxTotals] = useState<{ totalMailboxes: number; totalDailyCapacity: number; missingTrackingDomain: number } | null>(null);
  const [loading, setLoading] = useState(false);
  const [createOpen, setCreateOpen] = useState(false);
  const router = useRouter();
  const [error, setError] = useState<string | null>(null);
  const [openMailbox, setOpenMailbox] = useState<string | null>(null);

  const load = useCallback(async (which: TabKey) => {
    setLoading(true);
    setError(null);
    try {
      if (which === 'campaigns') {
        const res = await fetch('/api/lead-campaigns/overview');
        const json = await res.json();
        if (!res.ok) throw new Error(json.error || 'Could not load campaigns');
        setCampaigns(json.data ?? []);
      } else {
        const res = await fetch('/api/lead-campaigns/accounts');
        const json = await res.json();
        if (!res.ok) throw new Error(json.error || 'Could not load mailboxes');
        setMailboxes(json.mailboxes ?? []);
        setMailboxTotals({
          totalMailboxes: json.totalMailboxes ?? 0,
          totalDailyCapacity: json.totalDailyCapacity ?? 0,
          missingTrackingDomain: json.missingTrackingDomain ?? 0,
        });
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Something went wrong');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { load(tab); }, [tab, load]);

  return (
    <Container maxWidth="xl" sx={{ py: 4 }}>
      <Box sx={{ mb: 3 }}>
        <Typography variant="h4" component="h1" sx={{ fontWeight: 'bold', mb: 0.5 }}>
          Lead Campaigns
        </Typography>
        <Typography variant="body2" color="text.secondary">
          Outbound email sequences and the mailboxes that send them — managed on the campaign
          platform, surfaced here
        </Typography>
      </Box>

      <Paper variant="outlined" sx={{ mb: 2 }}>
        <Tabs value={tab} onChange={(_e, v: TabKey) => setTab(v)} sx={{ px: 1 }}>
          <Tab value="campaigns" label="Campaigns" icon={<CampaignIcon />} iconPosition="start" sx={{ minHeight: 52 }} />
          <Tab value="mailboxes" label="Sending Mailboxes" icon={<MarkEmailReadIcon />} iconPosition="start" sx={{ minHeight: 52 }} />
        </Tabs>
      </Paper>

      <Stack direction="row" sx={{ alignItems: 'center', gap: 1, mb: 1.5 }}>
        <Button size="small" variant="outlined" startIcon={<RefreshIcon />} onClick={() => load(tab)} disabled={loading}>
          Refresh
        </Button>
        {tab === 'campaigns' && (
          <Button size="small" variant="contained" startIcon={<AddIcon />} onClick={() => setCreateOpen(true)}>
            New campaign
          </Button>
        )}
        {loading && <CircularProgress size={16} />}
      </Stack>

      {error && <Alert severity="error" sx={{ mb: 2 }}>{error}</Alert>}

      {tab === 'campaigns' && (
        <Paper variant="outlined" sx={scrollableTable}>
          {/* Eleven columns. The campaign name stays put while the counters scroll. */}
          <Table size="small" stickyHeader sx={stickyFirstColumn}>
            <TableHead>
              <TableRow>
                {['Campaign', 'Status', 'Created', 'Progress', 'Leads', 'Sent', 'Opens', 'Replies', 'Clicks', 'Bounced', 'Unsub'].map((h) => (
                  <TableCell key={h} sx={{ fontWeight: 700, whiteSpace: 'nowrap' }}>{h}</TableCell>
                ))}
              </TableRow>
            </TableHead>
            <TableBody>
              {campaigns.map((c) => {
                const sc = statusColor(c.status);
                return (
                  <TableRow key={c.id} hover>
                    <TableCell
                      sx={{ fontWeight: 600, color: '#1565c0', cursor: 'pointer' }}
                      onClick={() => router.push(`/lead-campaigns/${c.id}`)}
                    >
                      {c.name}
                    </TableCell>
                    <TableCell>
                      <Chip label={c.statusLabel} size="small" sx={{ height: 20, fontSize: 11, bgcolor: sc.bg, color: sc.fg, fontWeight: 600 }} />
                    </TableCell>
                    <TableCell sx={{ whiteSpace: 'nowrap', color: '#5c6b78', fontSize: 13 }}>
                      {c.createdAt
                        ? new Date(c.createdAt).toLocaleDateString('en-GB', { day: '2-digit', month: 'short', year: 'numeric' })
                        : '—'}
                    </TableCell>
                    {/*
                      How far through the sequence, the same measure the platform shows.

                      Counted on people who have finished it, not on emails sent. A two-step
                      campaign sends twice per person, so Sent passes the lead count halfway
                      through — 53 leads against 93 sent on 2 Oct — and reads as more than
                      done. Progress answers the question that number raises.
                    */}
                    <TableCell sx={{ minWidth: 118 }}>
                      {c.leads > 0 ? (
                        <Box>
                          <Box sx={{ fontSize: 12, fontWeight: 700, lineHeight: 1.2 }}>
                            {Math.round((c.completed / c.leads) * 100)}%
                          </Box>
                          <LinearProgress
                            variant="determinate"
                            value={Math.min(100, Math.round((c.completed / c.leads) * 100))}
                            sx={{ height: 6, borderRadius: 3, mt: 0.25 }}
                          />
                          <Box sx={{ fontSize: 10, color: '#8a94a6', mt: 0.25 }}>
                            {c.completed.toLocaleString()} of {c.leads.toLocaleString()} finished
                          </Box>
                        </Box>
                      ) : <Box sx={{ color: '#8a94a6' }}>—</Box>}
                    </TableCell>
                    <TableCell sx={{ fontVariantNumeric: 'tabular-nums' }}>
                      {c.leads.toLocaleString()}{c.leadsTruncated && c.leads > 0 ? '+' : ''}
                    </TableCell>
                    <TableCell sx={{ fontVariantNumeric: 'tabular-nums' }}>{c.sent.toLocaleString()}</TableCell>
                    <TableCell sx={{ fontVariantNumeric: 'tabular-nums' }}>
                      {c.opens.toLocaleString()} <span style={{ color: '#8a94a6', fontSize: 12 }}>{pct(c.openRate)}</span>
                    </TableCell>
                    <TableCell sx={{ fontVariantNumeric: 'tabular-nums' }}>
                      {c.replies.toLocaleString()} <span style={{ color: '#8a94a6', fontSize: 12 }}>{pct(c.replyRate)}</span>
                    </TableCell>
                    <TableCell sx={{ fontVariantNumeric: 'tabular-nums' }}>{c.clicks.toLocaleString()}</TableCell>
                    <TableCell sx={{ fontVariantNumeric: 'tabular-nums', color: c.bounced > 0 ? '#b3261e' : undefined }}>
                      {c.bounced.toLocaleString()} <span style={{ color: '#8a94a6', fontSize: 12 }}>{pct(c.bounceRate)}</span>
                    </TableCell>
                    <TableCell sx={{ fontVariantNumeric: 'tabular-nums' }}>{c.unsubscribed.toLocaleString()}</TableCell>
                  </TableRow>
                );
              })}
              {!loading && campaigns.length === 0 && !error && (
                <TableRow>
                  <TableCell colSpan={11} sx={{ textAlign: 'center', py: 4, color: '#888' }}>
                    No campaigns on the platform yet.
                  </TableCell>
                </TableRow>
              )}
            </TableBody>
          </Table>
        </Paper>
      )}

      {tab === 'mailboxes' && (
        <>
          {mailboxTotals && (
            <Paper variant="outlined" sx={{ p: 2, mb: 2 }}>
              <Stack direction="row" spacing={1} useFlexGap sx={{ flexWrap: 'wrap', alignItems: 'center' }}>
                <Chip size="small" label={`${mailboxTotals.totalMailboxes} mailboxes`} sx={{ height: 22, fontWeight: 600 }} />
                <Chip size="small" label={`${mailboxTotals.totalDailyCapacity.toLocaleString()} sends/day capacity`} sx={{ height: 22, bgcolor: '#dcfce7', color: '#166534', fontWeight: 600 }} />
                {mailboxTotals.missingTrackingDomain > 0 && (
                  <Chip size="small" label={`${mailboxTotals.missingTrackingDomain} without a tracking domain`} sx={{ height: 22, bgcolor: '#fee2e2', color: '#b3261e', fontWeight: 600 }} />
                )}
              </Stack>
              {mailboxTotals.missingTrackingDomain > 0 && (
                <Alert severity="warning" sx={{ mt: 1.5 }}>
                  Mailboxes without their own tracking domain fall back to the platform&apos;s shared
                  one. On a cold send that is a deliverability risk — a tracking domain should be a
                  subdomain of the domain doing the sending.
                </Alert>
              )}
            </Paper>
          )}

          <Paper variant="outlined" sx={{ overflowX: 'auto' }}>
            <Table size="small" stickyHeader>
              <TableHead>
                <TableRow>
                  {['Mailbox', 'Name', 'Sending domain', 'Status', 'Warmup', 'Sends/day', 'Tracking domain', ''].map((h, n) => (
                    <TableCell key={h || n} sx={{ fontWeight: 700, whiteSpace: 'nowrap' }}>{h}</TableCell>
                  ))}
                </TableRow>
              </TableHead>
              <TableBody>
                {mailboxes.map((m, i) => {
                  // A rule between domains: mailboxes on one domain share its reputation
                  // and its tracking domain, so the grouping carries real meaning.
                  const newDomain = i > 0 && mailboxes[i - 1].domain !== m.domain;
                  return (
                    <TableRow
                      key={m.email} hover
                      sx={newDomain ? { '& td': { borderTop: '2px solid', borderTopColor: 'divider' } } : undefined}
                    >
                      <TableCell
                        sx={{ fontWeight: 600, whiteSpace: 'nowrap', color: '#1565c0', cursor: 'pointer' }}
                        onClick={() => setOpenMailbox(m.email)}
                      >
                        {m.email}
                      </TableCell>
                      <TableCell sx={{ whiteSpace: 'nowrap' }}>{m.name ?? '—'}</TableCell>
                      <TableCell sx={{ color: '#5c6b78' }}>{m.domain}</TableCell>
                      <TableCell>
                        {/* Paused and errored both mean "not sending", but only one is
                            something to act on here, so they are not collapsed. */}
                        <Chip
                          size="small"
                          label={m.statusLabel ?? (m.active ? 'Active' : 'Setting up')}
                          sx={{
                            height: 20, fontSize: 11, fontWeight: 600,
                            ...(m.statusLabel === 'Active' ? { bgcolor: '#dcfce7', color: '#166534' }
                              : m.statusLabel === 'Paused' ? { bgcolor: '#fff3d6', color: '#8a5a00' }
                                : m.statusLabel === 'Error' ? { bgcolor: '#fee2e2', color: '#b3261e' }
                                  : { bgcolor: '#e8eaed', color: '#5c6b78' }),
                          }}
                        />
                      </TableCell>
                      <TableCell sx={{ fontVariantNumeric: 'tabular-nums', whiteSpace: 'nowrap' }}>
                        {m.warmingUp ? (m.warmupScore ?? '—') : <span style={{ color: '#b3261e' }}>off</span>}
                      </TableCell>
                      <TableCell sx={{ fontVariantNumeric: 'tabular-nums' }}>{m.dailyLimit}</TableCell>
                      <TableCell>
                        {m.trackingDomain
                          ? <Chip size="small" label={m.trackingDomain} sx={{ height: 20, fontSize: 11, bgcolor: '#dcfce7', color: '#166534', fontWeight: 600 }} />
                          : <Chip size="small" label="none — uses shared" sx={{ height: 20, fontSize: 11, bgcolor: '#fee2e2', color: '#b3261e', fontWeight: 600 }} />}
                      </TableCell>
                      <TableCell align="right" sx={{ whiteSpace: 'nowrap' }}>
                        <MailboxRowActions
                          mailbox={m}
                          onChanged={() => load('mailboxes')}
                        />
                      </TableCell>
                    </TableRow>
                  );
                })}
                {!loading && mailboxes.length === 0 && !error && (
                  <TableRow>
                    <TableCell colSpan={8} sx={{ textAlign: 'center', py: 4, color: '#888' }}>
                      No sending mailboxes configured.
                    </TableCell>
                  </TableRow>
                )}
              </TableBody>
            </Table>
          </Paper>
        </>
      )}
      <MailboxDetailDrawer
        key={openMailbox ?? 'none'}
        email={openMailbox}
        open={!!openMailbox}
        onClose={() => setOpenMailbox(null)}
        onChanged={() => load('mailboxes')}
      />

      {createOpen && (
        <CampaignCreateDialog
          open
          onClose={() => setCreateOpen(false)}
          onCreated={(c) => router.push(`/lead-campaigns/${c.id}`)}
        />
      )}
    </Container>
  );
}
