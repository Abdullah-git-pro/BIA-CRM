'use client';

import React, { useCallback, useEffect, useRef, useState } from 'react';
import { useParams, useRouter } from 'next/navigation';
import {
  Container, Box, Typography, Paper, Table, TableHead, TableRow, TableCell, TableBody,
  Chip, CircularProgress, Alert, Stack, Button, TextField, Dialog, DialogTitle,
  DialogContent, DialogActions, Tooltip, Tabs, Tab, Badge,
} from '@mui/material';
import ArrowBackIcon from '@mui/icons-material/ArrowBack';
import PlayArrowIcon from '@mui/icons-material/PlayArrow';
import PauseIcon from '@mui/icons-material/Pause';
import ContentCopyIcon from '@mui/icons-material/ContentCopy';
import DeleteOutlineIcon from '@mui/icons-material/DeleteOutlined';
import PersonAddAlt1Icon from '@mui/icons-material/PersonAddAlt1';
import RefreshIcon from '@mui/icons-material/Refresh';
import GroupAddIcon from '@mui/icons-material/GroupAdd';
import UploadFileIcon from '@mui/icons-material/UploadFile';
import CampaignPushDialog from '@/components/CampaignPushDialog';
import CampaignCsvImportDialog from '@/components/CampaignCsvImportDialog';
import CampaignMailboxPanel from '@/components/CampaignMailboxPanel';
import CampaignSettingsPanel from '@/components/CampaignSettingsPanel';
import CampaignCopyCheck from '@/components/CampaignCopyCheck';
import CampaignSequencePanel from '@/components/CampaignSequencePanel';
import CampaignAnalyticsPanel from '@/components/CampaignAnalyticsPanel';
import CampaignRepliesPanel from '@/components/CampaignRepliesPanel';
import CampaignBouncesPanel from '@/components/CampaignBouncesPanel';

/**
 * One campaign, managed from the CRM.
 *
 * The four working areas are tabs rather than dialogs: writing a sequence or picking
 * mailboxes is editing the campaign, not a side errand, and a modal hides the campaign
 * you are editing. Lifecycle actions that apply to the whole campaign — activate,
 * duplicate, delete — stay above the tabs, because they are not one area's concern.
 *
 * The cost of inline editing is that there is no Cancel to bail out with, so each panel
 * reports whether it holds unsaved edits and the tab switch is guarded.
 */

type Detail = {
  id: string; name: string; status: number; statusLabel: string;
  dailyLimit: number | null; stopOnReply: boolean | null; unsubscribeHeader: boolean | null;
  linkTracking: boolean | null; openTracking: boolean | null;
  mailboxes: string[]; steps: number; firstSubject: string | null;
  schedule: { from: string; to: string; days: Record<string, boolean>; timezone: string | null } | null;
  sequence: Array<{ delay: number; subject: string; body: string }>;
};

type LeadRow = {
  id: string; email: string; status: number | null; opens: number; replies: number;
  clicks: number; lastContact: string | null; lastReply: string | null;
  firstName: string | null; lastName: string | null;
  propertyId: string | null;
};

const ACTIVE = 1;

const TAB_ANALYTICS = 0;
const TAB_LEADS = 1;
const TAB_SEQUENCE = 2;
const TAB_MAILBOXES = 3;
// Replies sits beside the mailboxes because that is where the conversation physically
// lives — a reply arrives in one of those inboxes, and the two are read together.
const TAB_REPLIES = 4;
/**
 * Bounces sit beside Replies because they are the same question asked the other way: both
 * are what came back from a send, and both are read after one. The analytics card reports
 * a bounce RATE and nothing else, so this is where the rate becomes a name and an address.
 */
const TAB_BOUNCES = 5;
const TAB_SETTINGS = 6;

export default function CampaignDetailPage() {
  const { id } = useParams<{ id: string }>();
  const router = useRouter();

  const [detail, setDetail] = useState<Detail | null>(null);
  const [leads, setLeads] = useState<LeadRow[]>([]);
  const [totals, setTotals] = useState<{ count: number; replied: number; opened: number } | null>(null);
  const [loading, setLoading] = useState(false);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  const [tab, setTab] = useState(TAB_ANALYTICS);
  const [dirty, setDirty] = useState(false);
  const [pendingTab, setPendingTab] = useState<number | null>(null);
  /** Bumped on every sequence save, so the copy check re-runs against the new copy. */
  const [copySaved, setCopySaved] = useState(0);
  /**
   * Bumped by every load, so the analytics panel reloads with the chips above it.
   *
   * The panel used to fetch only on mount and on its own range toggle, which left
   * Refresh updating the chips and nothing else: a reply that arrived after the page
   * opened read as "1 replied" in the chip and "0 replied" in the card below it.
   */
  const [reloadKey, setReloadKey] = useState(0);
  /** The mount load must not bump that key; see the finally block in load(). */
  const firstLoad = useRef(true);

  const [addOpen, setAddOpen] = useState(false);
  const [deleteOpen, setDeleteOpen] = useState(false);
  const [pushOpen, setPushOpen] = useState(false);
  const [csvOpen, setCsvOpen] = useState(false);
  const [confirmName, setConfirmName] = useState('');
  const [newLead, setNewLead] = useState({ email: '', firstName: '', lastName: '' });

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const [dRes, lRes] = await Promise.all([
        fetch(`/api/lead-campaigns/${id}`),
        fetch(`/api/lead-campaigns/${id}/leads`),
      ]);
      const dJson = await dRes.json();
      if (!dRes.ok) throw new Error(dJson.error || 'Could not load the campaign');
      setDetail(dJson.data);
      const lJson = await lRes.json();
      if (lRes.ok) {
        setLeads(lJson.data ?? []);
        setTotals({ count: lJson.count ?? 0, replied: lJson.replied ?? 0, opened: lJson.opened ?? 0 });
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not load the campaign');
    } finally {
      setLoading(false);
      // Every load after the first nudges the analytics panel to reload along with us.
      // The first one is the panel's own mount fetch, which would otherwise run twice.
      if (firstLoad.current) firstLoad.current = false;
      else setReloadKey((n) => n + 1);
    }
  }, [id]);

  useEffect(() => { load(); }, [load]);

  // A panel with unsaved edits gets a confirmation before its state is thrown away;
  // anything clean switches straight through.
  const goToTab = (next: number) => {
    if (next === tab) return;
    if (dirty) { setPendingTab(next); return; }
    setTab(next);
  };

  const discardAndGo = () => {
    if (pendingTab != null) setTab(pendingTab);
    setDirty(false);
    setPendingTab(null);
  };

  const act = async (action: 'pause' | 'activate' | 'duplicate') => {
    setBusy(action);
    setError(null);
    setNotice(null);
    try {
      const res = await fetch(`/api/lead-campaigns/${id}/${action}`, { method: 'POST' });
      const json = await res.json();
      if (!res.ok) throw new Error(json.error || `Could not ${action} the campaign`);
      if (action === 'duplicate') {
        setNotice('Campaign duplicated. The copy is paused and starts empty of sends.');
      }
      await load();
    } catch (err) {
      setError(err instanceof Error ? err.message : `Could not ${action} the campaign`);
    } finally {
      setBusy(null);
    }
  };

  const addLead = async () => {
    setBusy('add');
    setError(null);
    setNotice(null);
    try {
      const res = await fetch(`/api/lead-campaigns/${id}/leads`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(newLead),
      });
      const json = await res.json();
      if (!res.ok) throw new Error(json.error || 'Could not add the lead');
      // A lead that landed needs no announcement — the row appears in the table. A lead
      // that did NOT land is the case worth interrupting for: already in another
      // campaign is the common reason, and silence there reads as success.
      const skipped = (json.skipped ?? [])[0];
      if (json.added === 0) {
        setError(skipped ? `Not added — ${skipped.reason}.` : 'Nothing was added.');
      }
      setNewLead({ email: '', firstName: '', lastName: '' });
      setAddOpen(false);
      await load();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not add the lead');
    } finally {
      setBusy(null);
    }
  };

  const removeCampaign = async () => {
    setBusy('delete');
    setError(null);
    try {
      const res = await fetch(`/api/lead-campaigns/${id}`, {
        method: 'DELETE',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ confirmName }),
      });
      const json = await res.json();
      if (!res.ok) throw new Error(json.error || 'Could not delete the campaign');
      router.push('/lead-campaigns');
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not delete the campaign');
      setBusy(null);
    }
  };

  const isActive = detail?.status === ACTIVE;
  const noSteps = detail?.steps === 0;
  /** Everything standing between this campaign and a first send, each with its tab. */
  const blockers: Array<{ label: string; tab: number }> = [
    ...(detail?.steps === 0 ? [{ label: 'no email written', tab: TAB_SEQUENCE }] : []),
    ...(detail?.mailboxes.length === 0 ? [{ label: 'no sending mailbox', tab: TAB_MAILBOXES }] : []),
    ...(detail && !detail.unsubscribeHeader ? [{ label: 'no unsubscribe header', tab: TAB_SETTINGS }] : []),
  ];
  const noMailboxes = detail?.mailboxes.length === 0;

  /** A tab label that carries a red dot when that area is what blocks sending. */
  const tabLabel = (text: string, flagged: boolean) =>
    flagged
      ? <Badge variant="dot" color="error" sx={{ '& .MuiBadge-badge': { right: -8, top: 4 } }}>{text}</Badge>
      : text;

  return (
    <Container maxWidth="xl" sx={{ py: 4 }}>
      <Button size="small" startIcon={<ArrowBackIcon />} onClick={() => router.push('/lead-campaigns')} sx={{ mb: 2 }}>
        All campaigns
      </Button>

      {error && <Alert severity="error" sx={{ mb: 2 }}>{error}</Alert>}
      {notice && <Alert severity="success" sx={{ mb: 2 }} onClose={() => setNotice(null)}>{notice}</Alert>}

      {loading && !detail ? (
        <Box sx={{ display: 'flex', justifyContent: 'center', py: 6 }}><CircularProgress /></Box>
      ) : detail ? (
        <>
          <Stack direction="row" sx={{ alignItems: 'center', flexWrap: 'wrap', gap: 1.5, mb: 2 }}>
            <Typography variant="h4" component="h1" sx={{ fontWeight: 'bold' }}>{detail.name}</Typography>
            <Chip
              label={detail.statusLabel} size="small"
              sx={{
                fontWeight: 700,
                bgcolor: isActive ? '#dcfce7' : '#e8eaed',
                color: isActive ? '#166534' : '#5c6b78',
              }}
            />
          </Stack>

          {/* Lifecycle actions for the campaign as a whole — not the concern of any one tab. */}
          <Stack direction="row" spacing={1} useFlexGap sx={{ flexWrap: 'wrap', mb: 3 }}>
            {isActive ? (
              <Button
                size="small" variant="outlined" color="warning" startIcon={<PauseIcon />}
                onClick={() => act('pause')} disabled={!!busy}
              >
                {busy === 'pause' ? 'Pausing…' : 'Pause'}
              </Button>
            ) : (
              <Tooltip
                title={
                  // Every blocker, not just the first — fixing one and finding the button
                  // still disabled with no new explanation is the worst version of this.
                  blockers.length
                    ? `Cannot send yet: ${blockers.map((b) => b.label).join(', ')}.`
                    : ''
                }
              >
                <span>
                  <Button
                    size="small" variant="contained" color="success" startIcon={<PlayArrowIcon />}
                    onClick={() => act('activate')}
                    disabled={!!busy || noSteps || noMailboxes}
                  >
                    {busy === 'activate' ? 'Activating…' : 'Activate'}
                  </Button>
                </span>
              </Tooltip>
            )}
            <Button size="small" variant="outlined" startIcon={<ContentCopyIcon />} onClick={() => act('duplicate')} disabled={!!busy}>
              {busy === 'duplicate' ? 'Duplicating…' : 'Duplicate'}
            </Button>
            <Button size="small" variant="outlined" startIcon={<RefreshIcon />} onClick={load} disabled={!!busy || loading}>
              Refresh
            </Button>
            <Box sx={{ flexGrow: 1 }} />
            <Button size="small" variant="outlined" color="error" startIcon={<DeleteOutlineIcon />} onClick={() => setDeleteOpen(true)} disabled={!!busy}>
              Delete
            </Button>
          </Stack>

          <Paper variant="outlined" sx={{ p: 2, mb: 3 }}>
            <Stack direction="row" spacing={1} useFlexGap sx={{ flexWrap: 'wrap', alignItems: 'center' }}>
              <Chip size="small" label={`${totals?.count ?? 0} leads`} sx={{ fontWeight: 600 }} />
              <Chip size="small" label={`${totals?.opened ?? 0} opened`} />
              <Chip size="small" label={`${totals?.replied ?? 0} replied`} sx={{ bgcolor: '#dcfce7', color: '#166534', fontWeight: 600 }} />
            </Stack>

            {/* No banner for "not ready to send". The state is already legible twice
                over: the blocking tab carries a red dot, and Activate is disabled with a
                tooltip naming what is missing. A third copy sitting on screen for the
                whole life of a draft is noise, not a warning. */}
          </Paper>

          <Box sx={{ borderBottom: 1, borderColor: 'divider', mb: 3 }}>
            <Tabs value={tab} onChange={(_, v) => goToTab(v)}>
              <Tab label="Analytics" />
              <Tab label={`Leads${totals?.count ? ` (${totals.count})` : ''}`} />
              <Tab label={tabLabel('Email sequence', !!noSteps)} />
              <Tab label={tabLabel('Sending mailboxes', !!noMailboxes)} />
              <Tab label="Replies" />
              <Tab label="Bounces" />
              <Tab label={tabLabel('Settings', !detail.unsubscribeHeader)} />
            </Tabs>
          </Box>

          {tab === TAB_ANALYTICS && (
            <CampaignAnalyticsPanel
              campaignId={detail.id}
              // The same contact records the chips above are counted from, so the card
              // cannot report a different number of replies than the chip beside it.
              contacts={leads}
              reloadKey={reloadKey}
            />
          )}

          {tab === TAB_LEADS && (
            <>
              <Stack direction="row" spacing={1} useFlexGap sx={{ flexWrap: 'wrap', mb: 2 }}>
                <Button size="small" variant="contained" startIcon={<GroupAddIcon />} onClick={() => setPushOpen(true)} disabled={!!busy}>
                  Add leads from CRM
                </Button>
                <Button size="small" variant="outlined" startIcon={<UploadFileIcon />} onClick={() => setCsvOpen(true)} disabled={!!busy}>
                  Import CSV
                </Button>
                <Button size="small" variant="outlined" startIcon={<PersonAddAlt1Icon />} onClick={() => setAddOpen(true)} disabled={!!busy}>
                  Add one lead
                </Button>
              </Stack>

              <Paper variant="outlined" sx={{ overflowX: 'auto' }}>
                <Table size="small" stickyHeader>
                  <TableHead>
                    <TableRow>
                      {['Email', 'Name', 'Opens', 'Replies', 'Clicks', 'Last contact', 'CRM lead'].map((h) => (
                        <TableCell key={h} sx={{ fontWeight: 700, whiteSpace: 'nowrap' }}>{h}</TableCell>
                      ))}
                    </TableRow>
                  </TableHead>
                  <TableBody>
                    {leads.map((l) => (
                      <TableRow key={l.id} hover>
                        <TableCell>{l.email}</TableCell>
                        <TableCell>{[l.firstName, l.lastName].filter(Boolean).join(' ') || '—'}</TableCell>
                        <TableCell sx={{ fontVariantNumeric: 'tabular-nums' }}>{l.opens}</TableCell>
                        <TableCell sx={{ fontVariantNumeric: 'tabular-nums', fontWeight: l.replies > 0 ? 700 : 400, color: l.replies > 0 ? '#166534' : undefined }}>
                          {l.replies}
                        </TableCell>
                        <TableCell sx={{ fontVariantNumeric: 'tabular-nums' }}>{l.clicks}</TableCell>
                        <TableCell sx={{ whiteSpace: 'nowrap', fontSize: 12.5 }}>
                          {l.lastContact ? String(l.lastContact).slice(0, 10) : '—'}
                        </TableCell>
                        <TableCell>
                          {l.propertyId
                            ? <a href={`/leads/${l.propertyId}`} style={{ color: '#1565c0' }}>open</a>
                            : <span style={{ color: '#b0b6c0' }}>—</span>}
                        </TableCell>
                      </TableRow>
                    ))}
                    {!loading && leads.length === 0 && (
                      <TableRow>
                        <TableCell colSpan={7} sx={{ textAlign: 'center', py: 4, color: '#888' }}>
                          No leads in this campaign yet.
                        </TableCell>
                      </TableRow>
                    )}
                  </TableBody>
                </Table>
              </Paper>
            </>
          )}

          {tab === TAB_SEQUENCE && (
            <CampaignCopyCheck campaignId={detail.id} reloadOn={copySaved} />
          )}

          {tab === TAB_SEQUENCE && (
            <CampaignSequencePanel
              campaignId={detail.id}
              current={detail.sequence ?? []}
              onDirtyChange={setDirty}
              /**
               * The copy check has to re-run when the copy changes.
               *
               * It loaded once on mount, so saving a sequence left it answering about the
               * previous version — a variable just added showed nothing, and the fix for it
               * appeared only after a manual page reload. The check exists to be read at the
               * moment somebody edits the copy, which is exactly when it was stale.
               */
              onSaved={() => { load(); setCopySaved((n) => n + 1); }}
            />
          )}

          {tab === TAB_MAILBOXES && (
            <CampaignMailboxPanel
              campaignId={detail.id}
              selected={detail.mailboxes}
              onDirtyChange={setDirty}
              onSaved={() => { load(); }}
            />
          )}

          {tab === TAB_REPLIES && <CampaignRepliesPanel campaignId={detail.id} />}

          {tab === TAB_BOUNCES && <CampaignBouncesPanel campaignId={detail.id} />}

          {tab === TAB_SETTINGS && (
            <CampaignSettingsPanel
              campaignId={detail.id}
              current={{
                name: detail.name,
                dailyLimit: detail.dailyLimit,
                unsubscribeHeader: detail.unsubscribeHeader,
                openTracking: detail.openTracking,
                linkTracking: detail.linkTracking,
                schedule: detail.schedule,
              }}
              onDirtyChange={setDirty}
              onSaved={() => { load(); }}
            />
          )}
        </>
      ) : null}

      {/* Leaving a tab mid-edit would drop the work silently, so it is confirmed. */}
      <Dialog open={pendingTab != null} onClose={() => setPendingTab(null)} maxWidth="xs" fullWidth>
        <DialogTitle>Discard unsaved changes?</DialogTitle>
        <DialogContent dividers>
          <Typography variant="body2">
            This tab has changes you have not saved. Leaving it now throws them away.
          </Typography>
        </DialogContent>
        <DialogActions sx={{ px: 3, py: 2 }}>
          <Button onClick={() => setPendingTab(null)} color="inherit">Stay and keep editing</Button>
          <Button variant="contained" color="error" onClick={discardAndGo}>Discard</Button>
        </DialogActions>
      </Dialog>

      {/* Add one lead by hand */}
      <Dialog open={addOpen} onClose={busy ? undefined : () => setAddOpen(false)} maxWidth="xs" fullWidth>
        <DialogTitle>Add a lead</DialogTitle>
        <DialogContent dividers>
          <Stack spacing={2} sx={{ mt: 0.5 }}>
            <TextField
              label="Email" size="small" fullWidth autoFocus value={newLead.email}
              onChange={(e) => setNewLead((n) => ({ ...n, email: e.target.value }))}
            />
            <Stack direction="row" spacing={1.5}>
              <TextField label="First name" size="small" fullWidth value={newLead.firstName} onChange={(e) => setNewLead((n) => ({ ...n, firstName: e.target.value }))} />
              <TextField label="Last name" size="small" fullWidth value={newLead.lastName} onChange={(e) => setNewLead((n) => ({ ...n, lastName: e.target.value }))} />
            </Stack>
            <Typography variant="caption" color="text.secondary">
              Checked against every campaign on the platform first — an address already in
              one is reported back rather than added twice.
            </Typography>
          </Stack>
        </DialogContent>
        <DialogActions sx={{ px: 3, py: 2 }}>
          <Button onClick={() => setAddOpen(false)} color="inherit" disabled={!!busy}>Cancel</Button>
          <Button variant="contained" onClick={addLead} disabled={!!busy || !newLead.email.trim()}>
            {busy === 'add' ? 'Adding…' : 'Add lead'}
          </Button>
        </DialogActions>
      </Dialog>

      {csvOpen && detail && (
        <CampaignCsvImportDialog
          open
          campaignId={detail.id}
          campaignName={detail.name}
          onClose={() => setCsvOpen(false)}
          onFinished={() => { load(); }}
        />
      )}

      {pushOpen && detail && (
        <CampaignPushDialog
          open
          campaignId={detail.id}
          campaignName={detail.name}
          onClose={() => setPushOpen(false)}
          onFinished={() => { load(); }}
        />
      )}

      {/* Delete, name-confirmed */}
      <Dialog open={deleteOpen} onClose={busy ? undefined : () => setDeleteOpen(false)} maxWidth="xs" fullWidth>
        <DialogTitle>Delete this campaign?</DialogTitle>
        <DialogContent dividers>
          <Alert severity="error" sx={{ mb: 2 }}>
            This removes the campaign and its leads and history from the platform. It cannot
            be undone.
          </Alert>
          <Typography variant="body2" sx={{ mb: 1.5 }}>
            Type <strong>{detail?.name}</strong> to confirm.
          </Typography>
          <TextField size="small" fullWidth value={confirmName} onChange={(e) => setConfirmName(e.target.value)} />
        </DialogContent>
        <DialogActions sx={{ px: 3, py: 2 }}>
          <Button onClick={() => setDeleteOpen(false)} color="inherit" disabled={!!busy}>Cancel</Button>
          <Button
            variant="contained" color="error" onClick={removeCampaign}
            disabled={!!busy || confirmName !== detail?.name}
          >
            {busy === 'delete' ? 'Deleting…' : 'Delete campaign'}
          </Button>
        </DialogActions>
      </Dialog>
    </Container>
  );
}
