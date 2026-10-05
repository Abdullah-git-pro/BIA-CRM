'use client';

import React, { useCallback, useEffect, useState } from 'react';
import {
  Box, Paper, Typography, Stack, Chip, Button, TextField,
  Alert, Divider, Tooltip,
} from '@mui/material';
import ReplyIcon from '@mui/icons-material/Reply';
import RefreshIcon from '@mui/icons-material/Refresh';
import { REPLY_CLASSES, type ReplyClass } from '@/lib/replyClasses';
import { splitQuotedReply } from '@/lib/replyBody';

/**
 * The reply inbox (directive Sec. 7.6, Sec. 10.8).
 *
 * Replies land in one of 28 sending mailboxes nobody watches. Forwarding gets the message
 * in front of Ruben but leaves the OUTCOME nowhere — the classification, the household stop
 * it triggers and the response time all have to be typed somewhere afterwards, and anything
 * typed afterwards is data that eventually is not.
 *
 * So the classification is the action: choosing "stop" writes the household suppression,
 * "wrong timing" schedules the return 60 days before the next renewal. What each one does
 * is printed on the button, because a control whose consequence is invisible gets clicked
 * by someone who did not intend it.
 */

type Msg = { id: string; direction: 'in' | 'out'; from: string; to: string; subject: string; text: string; at: string | null };
type Thread = {
  threadId: string; eaccount: string; contactEmail: string; subject: string;
  messages: Msg[]; lastInboundAt: string | null; awaitingReply: boolean;
  responseMinutes: number | null; replyToUuid: string | null;
  leadId: string | null; propertyId: string | null; ownerName: string | null;
  cohort: string | null; grade: string | null;
  classification: ReplyClass | null; classifiedAt: string | null; classifiedBy: string | null;
};

const when = (s: string | null) => {
  if (!s) return '—';
  const d = new Date(s);
  const mins = Math.round((Date.now() - d.getTime()) / 60000);
  if (mins < 60) return `${mins}m ago`;
  if (mins < 1440) return `${Math.round(mins / 60)}h ago`;
  return d.toLocaleDateString();
};

/**
 * Quoted history is hidden, not deleted.
 *
 * A reply arrives with the entire thread quoted underneath it. Showing that inline buries
 * the two sentences the person actually wrote under three screens of our own copy, and the
 * two sentences are the whole job.
 *
 * This had its own matcher and it did not fire on the most common client of all: Apple
 * Mail writes the attribution line inside the quote block, so the line starts with ">" and
 * `\s*` never reached it. Michael Odrobinak's one-line reply rendered as thirty-one lines.
 * It is shared with the webhook's excerpt now so the two cannot drift apart again.
 */

export default function CampaignRepliesPanel({ campaignId }: { campaignId?: string }) {
  const [threads, setThreads] = useState<Thread[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [open, setOpen] = useState<string | null>(null);
  const [draft, setDraft] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState<string | null>(null);
  const [msg, setMsg] = useState<string | null>(null);
  const [showQuoted, setShowQuoted] = useState<Record<string, boolean>>({});

  const load = useCallback(async () => {
    setLoading(true); setError(null);
    try {
      const url = campaignId
        ? `/api/admin/replies?campaignId=${encodeURIComponent(campaignId)}`
        : '/api/admin/replies';
      const j = await (await fetch(url)).json();
      if (!j.success) throw new Error(j.error || 'Could not read the inbox');
      setThreads(j.data || []);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Could not read the inbox');
    } finally { setLoading(false); }
  }, [campaignId]);

  useEffect(() => { load(); }, [load]);

  const send = async (t: Thread) => {
    const text = (draft[t.threadId] ?? '').trim();
    if (!text) return;
    setBusy(t.threadId); setMsg(null);
    try {
      const j = await (await fetch('/api/admin/replies', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          action: 'reply', replyToUuid: t.replyToUuid, eaccount: t.eaccount,
          subject: t.subject, text, leadId: t.leadId, contactEmail: t.contactEmail,
        }),
      })).json();
      if (!j.success) throw new Error(j.error || 'Send failed');
      setDraft((d) => ({ ...d, [t.threadId]: '' }));
      setMsg(`Replied to ${t.contactEmail} from ${t.eaccount}.`);
      await load();
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Send failed');
    } finally { setBusy(null); }
  };

  const classify = async (t: Thread, klass: ReplyClass) => {
    if (!t.leadId) { setError('This thread is not matched to a lead, so it cannot be classified.'); return; }
    const spec = REPLY_CLASSES.find((c) => c.key === klass)!;
    if (spec.suppresses && !confirm(
      `Classify as "${spec.label}"?\n\n${spec.triggers}\n\n`
      + 'This suppresses the household across every channel and future cycle. It is recorded, not deleted, but it stops all contact.',
    )) return;

    setBusy(t.threadId); setMsg(null);
    try {
      const j = await (await fetch('/api/admin/replies', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'classify', leadId: t.leadId, contactEmail: t.contactEmail, klass }),
      })).json();
      if (!j.success) throw new Error(j.error || 'Could not classify');
      setMsg(`Classified as "${spec.label}"${j.suppressed ? ` — household suppressed (${j.scope})` : ''}.`);
      await load();
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Could not classify');
    } finally { setBusy(null); }
  };

  const awaiting = threads.filter((t) => t.awaitingReply).length;

  return (
    <Box>
      <Typography variant="body2" color="text.secondary" sx={{ mb: 2 }}>
        Every prospect who has answered. Read the thread, reply from the mailbox that sent it,
        and classify what they said — the classification is what triggers the action.
      </Typography>

      <Stack direction="row" spacing={1} sx={{ mb: 2, alignItems: 'center', flexWrap: 'wrap' }} useFlexGap>
        <Chip label={`${threads.length} conversation${threads.length === 1 ? '' : 's'}`} size="small" />
        {/*
          "Awaiting a reply" was read as waiting for THEM. It means the opposite: their
          message is the most recent one, so the answer is owed by us. A queue label that
          can be read either way is worse than no label — it makes an untouched
          conversation look like one that is progressing.
        */}
        <Chip
          label={awaiting ? `${awaiting} need${awaiting === 1 ? 's' : ''} your reply` : 'All answered'}
          size="small"
          sx={awaiting ? { bgcolor: '#fdecea', color: '#b3261e', fontWeight: 700 } : { bgcolor: '#e7f5ec', color: '#166534' }}
        />
        <Box sx={{ flex: 1 }} />
        <Button size="small" startIcon={<RefreshIcon />} onClick={load} disabled={loading}>
          {loading ? 'Loading…' : 'Refresh'}
        </Button>
      </Stack>

      {error && <Alert severity="error" sx={{ mb: 2 }} onClose={() => setError(null)}>{error}</Alert>}
      {msg && <Alert severity="success" sx={{ mb: 2 }} onClose={() => setMsg(null)}>{msg}</Alert>}

      {!loading && !threads.length && (
        <Paper variant="outlined" sx={{ p: 4, textAlign: 'center' }}>
          <Typography color="text.secondary">
            Nobody has replied yet. Threads appear here the moment someone answers.
          </Typography>
        </Paper>
      )}

      {threads.map((t) => {
        const isOpen = open === t.threadId;
        const last = t.messages[t.messages.length - 1];
        return (
          <Paper key={t.threadId} variant="outlined" sx={{ mb: 1.5, overflow: 'hidden' }}>
            <Box
              onClick={() => setOpen(isOpen ? null : t.threadId)}
              sx={{ p: 1.75, cursor: 'pointer', bgcolor: t.awaitingReply ? '#fffaf5' : 'transparent' }}
            >
              <Stack direction="row" sx={{ alignItems: 'center', gap: 1, flexWrap: 'wrap' }}>
                <Typography sx={{ fontWeight: 700, fontSize: 14 }}>
                  {t.ownerName || t.contactEmail}
                </Typography>
                {t.grade && (
                  <Chip label={t.grade} size="small" sx={{ height: 18, fontWeight: 700 }} />
                )}
                {t.cohort && <Chip label={t.cohort} size="small" variant="outlined" sx={{ height: 18 }} />}
                {t.awaitingReply
                  ? (
                    <Tooltip arrow title="Their message is the most recent one in this thread — nobody has answered it yet.">
                      <Chip label="Needs your reply" size="small"
                        sx={{ height: 18, bgcolor: '#fdecea', color: '#b3261e', fontWeight: 700, cursor: 'help' }} />
                    </Tooltip>
                  )
                  : t.responseMinutes != null && (
                    <Tooltip arrow title="Time from their message to our answer — the SLA in Sec. 10.8 is under an hour in business hours.">
                      <Chip
                        label={`answered in ${t.responseMinutes}m`}
                        size="small"
                        sx={{ height: 18, bgcolor: t.responseMinutes <= 60 ? '#e7f5ec' : '#fff3d6',
                          color: t.responseMinutes <= 60 ? '#166534' : '#8a5a00' }}
                      />
                    </Tooltip>
                  )}
                {t.classification && (
                  <Chip
                    label={REPLY_CLASSES.find((c) => c.key === t.classification)?.label ?? t.classification}
                    size="small" sx={{ height: 18, fontWeight: 600 }}
                  />
                )}
                <Box sx={{ flex: 1 }} />
                <Typography variant="caption" color="text.secondary">{when(t.lastInboundAt)}</Typography>
              </Stack>
              <Typography variant="caption" color="text.secondary" sx={{ display: 'block', mt: 0.25 }}>
                {t.contactEmail} · {t.subject}
                {last && (
                  <>
                    {' · '}
                    <b>{last.direction === 'in' ? 'they wrote last' : 'we replied last'}</b>
                  </>
                )}
              </Typography>
              {!isOpen && (
                <Typography variant="body2" noWrap sx={{ mt: 0.5, color: '#5a6675' }}>
                  {splitQuotedReply(last?.text ?? '').body || '(no text)'}
                </Typography>
              )}
            </Box>

            {isOpen && (
              <Box sx={{ px: 1.75, pb: 1.75 }}>
                <Divider sx={{ mb: 1.5 }} />
                {t.messages.map((m) => {
                  const { body, quoted } = splitQuotedReply(m.text);
                  const key = `${t.threadId}:${m.id}`;
                  return (
                    <Box
                      key={m.id}
                      sx={{
                        mb: 1.25, p: 1.25, borderRadius: 1,
                        bgcolor: m.direction === 'in' ? '#f1f5f9' : '#e8f0fe',
                        ml: m.direction === 'in' ? 0 : 4, mr: m.direction === 'in' ? 4 : 0,
                      }}
                    >
                      <Typography variant="caption" sx={{ fontWeight: 700, color: '#5a6675' }}>
                        {m.direction === 'in' ? m.from : `${m.from} (us)`} · {when(m.at)}
                      </Typography>
                      <Typography variant="body2" sx={{ whiteSpace: 'pre-wrap', mt: 0.5 }}>
                        {body || '(no text)'}
                      </Typography>
                      {quoted && (
                        <>
                          <Button size="small" sx={{ mt: 0.5, fontSize: 11 }}
                            onClick={() => setShowQuoted((q) => ({ ...q, [key]: !q[key] }))}>
                            {showQuoted[key] ? 'Hide quoted' : 'Show quoted history'}
                          </Button>
                          {showQuoted[key] && (
                            <Typography variant="caption"
                              sx={{ display: 'block', whiteSpace: 'pre-wrap', color: '#9098a6', mt: 0.5 }}>
                              {quoted}
                            </Typography>
                          )}
                        </>
                      )}
                    </Box>
                  );
                })}

                {/* ── Reply ─────────────────────────────────────────────── */}
                <TextField
                  fullWidth multiline minRows={3} size="small" placeholder={`Reply as ${t.eaccount}…`}
                  value={draft[t.threadId] ?? ''}
                  onChange={(e) => setDraft((d) => ({ ...d, [t.threadId]: e.target.value }))}
                  sx={{ mb: 1 }}
                />
                <Stack direction="row" spacing={1} sx={{ alignItems: 'center', mb: 2, flexWrap: 'wrap' }} useFlexGap>
                  <Button
                    variant="contained" size="small" startIcon={<ReplyIcon />}
                    disabled={busy === t.threadId || !(draft[t.threadId] ?? '').trim() || !t.replyToUuid}
                    onClick={() => send(t)}
                  >
                    {busy === t.threadId ? 'Sending…' : 'Send reply'}
                  </Button>
                  <Typography variant="caption" color="text.secondary">
                    Goes out from <b>{t.eaccount}</b>, in this thread — so it reaches them as a
                    reply from the person they wrote to, not a new message from a stranger.
                  </Typography>
                </Stack>

                {/* ── Classify (Sec. 7.6) ───────────────────────────────── */}
                <Typography variant="caption" sx={{ fontWeight: 700, display: 'block', mb: 0.5 }}>
                  What did they say? The classification triggers the action.
                </Typography>
                {!t.leadId && (
                  <Alert severity="info" sx={{ mb: 1 }}>
                    This conversation is not matched to a lead in the CRM, so it cannot be
                    classified. That happens when the address was added to the campaign
                    directly rather than pushed from here.
                  </Alert>
                )}
                <Stack direction="row" spacing={0.75} sx={{ flexWrap: 'wrap' }} useFlexGap>
                  {REPLY_CLASSES.map((c) => (
                    <Tooltip key={c.key} arrow title={c.triggers}>
                      <span>
                        <Button
                          size="small"
                          variant={t.classification === c.key ? 'contained' : 'outlined'}
                          disabled={busy === t.threadId || !t.leadId}
                          onClick={() => classify(t, c.key)}
                          sx={{
                            fontSize: 11, textTransform: 'none',
                            ...(c.tone === 'bad' ? { borderColor: '#f2a3a3', color: '#b3261e' } : {}),
                            ...(c.tone === 'good' ? { borderColor: '#9bd4b0', color: '#166534' } : {}),
                            ...(t.classification === c.key ? { color: '#fff' } : {}),
                          }}
                        >
                          {c.label}
                        </Button>
                      </span>
                    </Tooltip>
                  ))}
                </Stack>
                {t.classifiedAt && (
                  <Typography variant="caption" color="text.secondary" sx={{ display: 'block', mt: 1 }}>
                    Classified {when(t.classifiedAt)}{t.classifiedBy ? ` by ${t.classifiedBy}` : ''}.
                  </Typography>
                )}
              </Box>
            )}
          </Paper>
        );
      })}
    </Box>
  );
}
