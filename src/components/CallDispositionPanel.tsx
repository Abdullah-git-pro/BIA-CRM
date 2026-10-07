'use client';

import { easternDisplay } from '@/lib/wallClock';
import React, { useCallback, useEffect, useRef, useState } from 'react';
import {
  Box, Paper, Typography, Stack, Chip, Button, TextField, Alert, Divider, Tooltip,
} from '@mui/material';
import PhoneIcon from '@mui/icons-material/Phone';
import {
  CALL_OUTCOMES, CALL_OUTCOME_LABEL, CALL_STATUS_LABEL,
  type CallOutcome, type CallStatus,
} from '@/lib/callOutcomes';

/**
 * Logging a call (directive Sec. 10.5).
 *
 * "A form Ruben completes on a phone in under fifteen seconds. A form, not a spreadsheet
 * row to find and edit — it timestamps automatically and cannot be typed into the wrong
 * record."
 *
 * So: pick the number, tap the outcome, done. Notes and duration are optional and sit
 * after the thing that matters. The outcome buttons carry their consequence in a tooltip
 * because two of them suppress the household, and a control that does something
 * irreversible without saying so will eventually be tapped by someone in a hurry.
 *
 * The history above is the point of the exercise. "Couldn't reach them" is not data;
 * four rows with numbers, days and outcomes is.
 */

type Attempt = {
  id: string; numberDialled: string; numberRole: string | null; numberLabel: string | null;
  attemptedAt: string; durationSeconds: number | null; outcome: CallOutcome;
  callbackAt: string | null; notes: string | null; calledBy: string | null;
};
type State = {
  status: CallStatus; attempts: Attempt[]; attemptCount: number;
  numbersTried: string[]; distinctDays: number; lastAttemptAt: string | null;
  nextCallbackAt: string | null; invalidNumbers: string[];
  dialable: Array<{
    number: string; role: 'insured' | 'co_insured'; label: string;
    /** From the skip-trace payload. 48% of C1–C3 numbers are DNC-flagged. */
    dnc?: boolean; tcpa?: boolean; rank?: number | null; type?: string | null;
    /** Whose number it is, by name — who to ask for when it answers. */
    person?: string | null;
  }>;
  blockedReason: string | null;
};

const fmtPhone = (n: string) => {
  const d = String(n).replace(/\D/g, '');
  return d.length === 10 ? `(${d.slice(0, 3)}) ${d.slice(3, 6)}-${d.slice(6)}` : n;
};

/**
 * The outcome in one or two words, for a chip that also has to hold a phone number.
 *
 * The full labels read "Reached — callback scheduled", which is right on the button that
 * files it and far too long beside a number.
 */
const SHORT_OUTCOME: Record<CallOutcome, string> = {
  no_answer: 'no answer',
  voicemail: 'voicemail',
  bad_number: 'bad number',
  wrong_person: 'wrong person',
  callback_scheduled: 'callback',
  quote_requested: 'quoting',
  not_interested: 'not interested',
  do_not_call: 'do not call',
};
const shortOutcome = (o: CallOutcome) => SHORT_OUTCOME[o] ?? String(o).replace(/_/g, ' ');

/**
 * How long ago, in the coarsest unit that is still useful.
 *
 * "today" and "yesterday" are what a producer actually reasons with; an exact time only
 * matters inside the same day, when the question is whether he has already tried this
 * number this afternoon.
 */
function sinceLabel(at: string): string {
  const then = new Date(at).getTime();
  if (!Number.isFinite(then)) return '';
  const mins = Math.floor((Date.now() - then) / 60000);
  if (mins < 60) return `${Math.max(mins, 0)}m ago`;
  if (mins < 24 * 60) return `${Math.floor(mins / 60)}h ago`;
  const days = Math.floor(mins / (24 * 60));
  return days === 1 ? 'yesterday' : `${days}d ago`;
}

/**
 * One colour per status, and the four that replaced "contacted" are deliberately not all
 * green. Reaching somebody is not the outcome — what they said is. A do-not-call and a
 * quote request are both "contacted" and belong at opposite ends of the queue.
 */
const STATUS_STYLE: Record<CallStatus, object> = {
  not_attempted: { bgcolor: '#f1f5f9', color: '#5a6675' },
  attempting: { bgcolor: '#fff3d6', color: '#8a5a00' },
  callback_due: { bgcolor: '#e8f0fe', color: '#1565c0' },
  quoting: { bgcolor: '#e7f5ec', color: '#166534' },
  not_interested: { bgcolor: '#f1f5f9', color: '#5a6675' },
  do_not_call: { bgcolor: '#fdecea', color: '#b3261e' },
  unreachable: { bgcolor: '#fdecea', color: '#b3261e' },
};

export default function CallDispositionPanel({ leadId }: { leadId: string }) {
  const [state, setState] = useState<State | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [msg, setMsg] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [number, setNumber] = useState<string>('');
  /**
   * The number "Call now" asked for, read once from the URL.
   *
   * A ref rather than state: it is an instruction that arrives with the navigation and is
   * consumed by the first load. Putting it in the dependency list would re-apply it every
   * time the history reloaded, overriding a number the producer had since picked by hand.
   */
  const wantedNumberRef = useRef<string>('');
  useEffect(() => {
    try {
      wantedNumberRef.current = new URLSearchParams(window.location.search).get('call') ?? '';
    } catch { /* no window during SSR */ }
  }, []);
  const [notes, setNotes] = useState('');
  /**
   * ── "Nobody picked up — try again in fifteen minutes" ────────────────────
   *
   * Deliberately NOT the Callback field beside it. That one is a time the homeowner agreed
   * to, it is required on the outcomes that schedule one, and "callbacks honoured" is a
   * number somebody will be measured on. This is the caller's own note to himself after a
   * number rang out, and most will be dialled a few minutes either side of the minute they
   * name. One column for both would make every retry look like a promise to a customer.
   */
  const [reminders, setReminders] = useState<Array<{ id: string; dueLabel: string; minutesUntil: number; phone: string | null }>>([]);
  const [remBusy, setRemBusy] = useState(false);

  const loadReminders = useCallback(async () => {
    try {
      const j = await (await fetch(`/api/call-reminders?leadId=${encodeURIComponent(leadId)}`)).json();
      if (j.success) setReminders(j.reminders ?? []);
    } catch { /* a reminder list that fails to load must not take the call panel down */ }
  }, [leadId]);

  const remind = async (minutes: number) => {
    setRemBusy(true);
    try {
      const res = await fetch('/api/call-reminders', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          leadId,
          // The number currently selected, so the reminder reopens on the one he was
          // trying rather than making him pick again from ten, seven of them DNC-flagged.
          phone: number || null,
          minutes,
          note: notes.trim() || null,
        }),
      });
      const j = await res.json();
      if (!j.success) throw new Error(j.error || 'Could not set that reminder');
      setMsg(`Reminder set for ${j.reminder.dueLabel}`);
      await loadReminders();
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Could not set that reminder');
    } finally {
      setRemBusy(false);
    }
  };

  const closeReminder = async (id: string, how: 'done' | 'dismissed') => {
    try {
      await fetch('/api/call-reminders', {
        method: 'PATCH',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ id, how }),
      });
      await loadReminders();
    } catch { /* the toast will still show it; closing is not worth an error banner */ }
  };
  /**
   * Addresses taken mid-call (Frank, 25 Sep 2026 · item 8).
   *
   * Held here rather than on the card's edit form because the moment they exist is while
   * somebody is on the phone — and loading, editing and re-saving a whole lead to record
   * one line a customer just read out is not something anyone does with a person waiting.
   */
  const [capIns, setCapIns] = useState('');
  const [capCo, setCapCo] = useState('');
  const [capOpen, setCapOpen] = useState(false);
  /** The "put it back in the queue" reveal — see returnToQueue below. */
  const [reqOpen, setReqOpen] = useState(false);
  const [reqReason, setReqReason] = useState('');
  const [callbackAt, setCallbackAt] = useState('');

  const load = useCallback(async () => {
    try {
      const j = await (await fetch(`/api/leads/${leadId}/calls`)).json();
      if (!j.success) throw new Error(j.error || 'Could not read call history');
      setState(j.data);
      /**
       * A number in ?call= wins over the best-first default.
       *
       * That parameter is set by "Call now" on a reminder, and the whole point of the
       * reminder is THAT number — the one that rang out. Dropping back to the default would
       * put somebody on a different line from the one they meant to retry, and on these
       * cards seven of ten numbers are DNC-flagged.
       *
       * Digits only on both sides: the reminder stores what was dialled and the list holds
       * its own formatting, so "(609) 443-1962" and "6094431962" are the same number.
       */
      const digits = (v: string) => String(v ?? '').replace(/D/g, '');
      const wanted = digits(wantedNumberRef.current);
      const match = wanted
        ? (j.data.dialable as Array<{ number: string }>).find((d) => digits(d.number) === wanted)
        : null;
      setNumber((n) => (match?.number ?? (n || j.data.dialable[0]?.number || '')));
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Could not read call history');
    }
  }, [leadId]);

  useEffect(() => { load(); }, [load]);
  /**
   * Reminders already set on this card, so reopening it shows what is pending rather than
   * an empty row of buttons that makes it look as though nothing was ever scheduled.
   *
   * Wrapped rather than called straight: setState directly inside an effect invites
   * cascading renders, and `alive` stops a slow response for the PREVIOUS lead painting its
   * reminders onto this one — these panels are stepped through lead by lead, so that race is
   * the normal case, and a reminder shown against the wrong card is a call to the wrong person.
   */
  useEffect(() => {
    let alive = true;
    (async () => {
      try {
        const j = await (await fetch(`/api/call-reminders?leadId=${encodeURIComponent(leadId)}`)).json();
        if (alive && j.success) setReminders(j.reminders ?? []);
      } catch { /* a reminder list that fails to load must not take the call panel down */ }
    })();
    return () => { alive = false; };
  }, [leadId]);

  const log = async (outcome: CallOutcome) => {
    const spec = CALL_OUTCOMES.find((o) => o.key === outcome)!;

    /**
     * Clear the previous result BEFORE validating.
     *
     * Frank, 25 Sep 2026: "A callback saved without a date. Both the error banner and
     * 'Logged' showed."
     *
     * The guards below already refused the save — nothing was written. What stayed on
     * screen was the success message from the PREVIOUS attempt, because setMsg(null) came
     * after the early returns. So a refused save looked like a completed one sitting next
     * to a complaint, and the operator is left to guess which is true. On a callback that
     * means believing Ruben has a date in the diary when he has nothing.
     */
    setMsg(null);
    setError(null);

    if (!number) { setError('Pick the number you dialled.'); return; }
    if (spec.needsCallbackAt && !callbackAt) {
      setError('A scheduled callback needs a date and time.');
      return;
    }
    /**
     * A callback in the past is a callback nobody will be reminded about — the panel only
     * surfaces ones still ahead. Refused rather than accepted quietly.
     */
    if (spec.needsCallbackAt && new Date(callbackAt).getTime() <= Date.now()) {
      setError('That callback time has already passed. Pick a time in the future.');
      return;
    }
    if (spec.suppresses && !confirm(
      `Log "${spec.label}"?\n\n${spec.follows}\n\n`
      + 'This stops all contact with the household, on every channel. It is recorded, not deleted.',
    )) return;

    setBusy(true); setError(null); setMsg(null);
    try {
      const chosen = state?.dialable.find((d) => d.number === number);
      const j = await (await fetch(`/api/leads/${leadId}/calls`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          outcome, numberDialled: number,
          numberRole: chosen?.role ?? null, numberLabel: chosen?.label ?? null,
          notes: notes.trim() || null,
          callbackAt: spec.needsCallbackAt ? callbackAt : null,
        }),
      })).json();
      if (!j.success) throw new Error(j.error || 'Could not log the attempt');
      setState(j.data);
      setNotes(''); setCallbackAt('');
      setMsg(`Logged: ${spec.label}.`
        + (j.numberInvalidated ? ' That number will not be dialled again.' : '')
        + (j.suppressed ? ' Household suppressed.' : '')
        + (j.status === 'unreachable' ? ' This lead is now unreachable by phone and moves to direct mail.' : ''));
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Could not log the attempt');
    } finally { setBusy(false); }
  };

  /**
   * Take back the last outcome (Frank's item 9).
   *
   * Frank's example: one number showing "Voicemail left" and then "Bad number" five seconds
   * later. Without this the only way to correct a mis-tap is to log a third outcome on top,
   * which leaves the wrong one in the history looking like something that happened.
   */
  const undoLast = async () => {
    setMsg(null); setError(null);
    setBusy(true);
    try {
      const j = await (await fetch(`/api/leads/${leadId}/calls/undo`, { method: 'POST' })).json();
      if (!j.success) throw new Error(j.error || 'Could not undo that');
      if (!j.undone) { setError(j.reason || 'Nothing to undo.'); return; }
      setState(j.data);
      setMsg('Last outcome undone. Anything it triggered has been reversed too.');
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Could not undo that');
    } finally { setBusy(false); }
  };

  /**
   * Put the lead back in the calling queue (Frank, 29 Sep 2026).
   *
   * "I want it back in the regular queue... I can't do undo." Undo is ten minutes and
   * deletes the attempt; this keeps every call on the record and starts the calling story
   * again after a line, so the card shows both what was dialled and who decided to set it
   * aside.
   */
  const returnToQueue = async () => {
    setMsg(null); setError(null);
    setBusy(true);
    try {
      const j = await (await fetch(`/api/leads/${leadId}/calls/requeue`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ reason: reqReason.trim() || null }),
      })).json();
      if (!j.success) throw new Error(j.error || 'Could not return that lead to the queue');
      if (!j.returned) { setError(j.reason || 'Could not return that lead to the queue.'); return; }
      setState(j.data);
      setReqOpen(false); setReqReason('');
      setMsg(
        `Back in the queue. ${j.discounted} earlier attempt${j.discounted === 1 ? '' : 's'} set aside`
        + ' — still on the record below.'
        + (j.restoredNumbers?.length ? ` Dialling again: ${j.restoredNumbers.join(', ')}.` : ''),
      );
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Could not return that lead to the queue');
    } finally { setBusy(false); }
  };

  const captureEmail = async () => {
    setMsg(null); setError(null);
    if (!capIns.trim() && !capCo.trim()) { setError('Type at least one address.'); return; }
    setBusy(true);
    try {
      const j = await (await fetch(`/api/leads/${leadId}/capture-email`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          insuredEmail: capIns.trim() || null,
          coInsuredEmail: capCo.trim() || null,
        }),
      })).json();
      if (!j.success) throw new Error(j.error || 'Could not save that address');
      setState(j.data);
      setCapIns(''); setCapCo(''); setCapOpen(false);
      setMsg(
        `Saved${j.insuredSet ? ' insured' : ''}${j.insuredSet && j.coInsuredSet ? ' and' : ''}`
        + `${j.coInsuredSet ? ' co-insured' : ''} address. This account is now reachable by email.`
        + (j.replaced?.length
          ? ` The previous ${j.replaced.map((r: { role: string; was: string }) => `${r.role} address (${r.was})`).join(' and ')} is in the history.`
          : ''),
      );
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Could not save that address');
    } finally { setBusy(false); }
  };

  if (!state) {
    return <Paper variant="outlined" sx={{ p: 2 }}><Typography variant="body2" color="text.secondary">Loading call history…</Typography></Paper>;
  }

  /**
   * The most recent attempt on one number, or null if it has never been dialled.
   *
   * Matched on digits only. The attempt stores whatever was dialled and the card holds a
   * cleaned copy, and comparing the two as written would make a number that HAS been
   * tried look untouched — the exact fault this is here to fix.
   */
  const lastAttemptOn = (num: string): Attempt | null => {
    const key = String(num).replace(/\D/g, '');
    let best: Attempt | null = null;
    for (const a of state.attempts) {
      if (String(a.numberDialled).replace(/\D/g, '') !== key) continue;
      if (!best || a.attemptedAt > best.attemptedAt) best = a;
    }
    return best;
  };

  return (
    <Paper variant="outlined" sx={{ p: 2 }}>
      <Stack direction="row" sx={{ alignItems: 'center', gap: 1, mb: 1.5, flexWrap: 'wrap' }}>
        <PhoneIcon fontSize="small" sx={{ color: '#5a6675' }} />
        <Typography sx={{ fontWeight: 700, fontSize: 14 }}>Calls</Typography>
        <Chip label={CALL_STATUS_LABEL[state.status]} size="small"
          sx={{ height: 20, fontWeight: 700, ...STATUS_STYLE[state.status] }} />
        {state.attemptCount > 0 && (
          <Tooltip arrow title={
            `${state.attemptCount} attempt${state.attemptCount === 1 ? '' : 's'} across `
            + `${state.numbersTried.length} number${state.numbersTried.length === 1 ? '' : 's'} `
            + `over ${state.distinctDays} day${state.distinctDays === 1 ? '' : 's'}. `
            + 'Unreachable needs 4 attempts, 3+ days and 2+ numbers where they exist.'
          }>
            <Typography variant="caption" sx={{ color: '#5a6675', cursor: 'help' }}>
              {state.attemptCount} attempt{state.attemptCount === 1 ? '' : 's'} ·{' '}
              {state.numbersTried.length} number{state.numbersTried.length === 1 ? '' : 's'} ·{' '}
              {state.distinctDays} day{state.distinctDays === 1 ? '' : 's'}
            </Typography>
          </Tooltip>
        )}
        {state.nextCallbackAt && (
          <Chip size="small" label={`Callback ${easternDisplay(state.nextCallbackAt)} ET`}
            sx={{ height: 20, bgcolor: '#e8f0fe', color: '#1565c0', fontWeight: 600 }} />
        )}
      </Stack>

      {error && <Alert severity="error" sx={{ mb: 1.5 }} onClose={() => setError(null)}>{error}</Alert>}
      {msg && <Alert severity="success" sx={{ mb: 1.5 }} onClose={() => setMsg(null)}>{msg}</Alert>}

      {/*
        Never a silently disabled form. If there is nobody to call — suppressed household,
        every number dead, already retired — the reason is stated, because an unexplained
        dead control gets worked around by dialling off the card, and then the attempt is
        never logged at all.
      */}
      {state.blockedReason ? (
        <Alert severity="warning" sx={{ mb: 1.5 }}>{state.blockedReason}</Alert>
      ) : (
        <>
          <Typography variant="caption" sx={{ fontWeight: 700, display: 'block', mb: 0.5 }}>
            Which number did you dial? <Box component="span" sx={{ fontWeight: 400, color: '#5a6675' }}>
              — best first
            </Box>
          </Typography>
          {/*
            ── DNC, shown on the number (Frank's item 9) ──────────────────────

            The skip-trace payload has carried a per-number DNC flag all along and none of
            it reached the person dialling: 464 of the 965 numbers on C1–C3 cards are
            flagged, on 155 of 184 accounts, and 16 accounts are flagged on every number.

            Flagged numbers are sorted last and marked, not removed. Removing them would
            hide half the list and make 16 accounts look as though they had no numbers at
            all; leaving them unmarked is how somebody dials one without knowing. Whether a
            flagged number may be called is a question for Frank and Adnan — the panel's job
            is to make sure nobody answers it by accident.
          */}
          {/*
            ── What already happened on each number, on the number ─────────────

            Every attempt was listed underneath, and none of it reached the control
            somebody dials from. On lead 197686734 all four numbers offered had been
            tried the previous afternoon — four "no answer" in six minutes — and the
            chips looked exactly like a card nobody had touched. The history was on
            screen and in the wrong place: a producer reads the thing he is about to
            click, not the log below it.

            Shown as the outcome and when, because "tried" is not the useful fact. A
            voicemail left an hour ago and a no-answer from last Tuesday are different
            decisions, and the difference is what stops a number being redialled twice
            in an afternoon.
          */}
          {/*
            ── Grouped by whose number it is (Frank, 7 Oct 2026) ───────────────

            Co-insured numbers were always offered here — 698 of 998 Grade A cards carry
            one, 40 of them have no insured number at all, and 57 calls have already been
            logged against them. None of that was visible: the role appeared only in a
            hover tooltip, so the card looked as though it listed the insured's numbers
            and nothing else.

            Grouped under a heading with the person's NAME rather than tagged on each
            chip, because the name is the operative fact on a call. Dialling the
            co-insured's mobile and opening with the insured's name wastes a good number.
          */}
          {(['insured', 'co_insured'] as const)
            .filter((role) => state.dialable.some((d) => d.role === role))
            .map((role) => {
              const group = state.dialable.filter((d) => d.role === role);
              const who = group.find((d) => d.person)?.person ?? null;
              return (
                <Box key={role} sx={{ mb: 1.25 }}>
                  <Typography variant="caption" sx={{ display: 'block', color: '#5a6675', mb: 0.4 }}>
                    {role === 'insured' ? 'Insured' : 'Co-insured'}
                    {who ? <> — <Box component="span" sx={{ fontWeight: 700 }}>{who}</Box></> : null}
                    {role === 'co_insured' ? ' · ask for them by name' : null}
                  </Typography>
                  <Stack direction="row" spacing={0.75} sx={{ flexWrap: 'wrap' }} useFlexGap>
                    {group.map((d) => {
              const last = lastAttemptOn(d.number);
              return (
                <Tooltip
                  key={d.number}
                  arrow
                  title={[
                    d.role === 'insured' ? 'The insured' : 'The co-insured',
                    d.label === 'trace' ? 'found by a skip trace' : 'on the policy record',
                    d.type ? d.type.toLowerCase() : null,
                    d.rank != null ? `vendor rank ${d.rank}` : null,
                    d.dnc ? 'ON THE DO-NOT-CALL LIST' : null,
                    last
                      ? `last tried ${easternDisplay(last.attemptedAt)} — ${CALL_OUTCOME_LABEL[last.outcome]}`
                      : 'never dialled',
                  ].filter(Boolean).join(' · ')}
                >
                  <Chip
                    label={
                      `${fmtPhone(d.number)}${d.dnc ? ' · DNC' : ''}`
                      + (last ? ` · ${shortOutcome(last.outcome)} ${sinceLabel(last.attemptedAt)}` : '')
                    }
                    size="small"
                    onClick={() => setNumber(d.number)}
                    variant={number === d.number ? 'filled' : 'outlined'}
                    sx={number === d.number
                      ? { bgcolor: d.dnc ? '#b3261e' : '#1565c0', color: '#fff', fontWeight: 700 }
                      : d.dnc
                        ? { borderColor: '#b3261e', color: '#b3261e', fontWeight: 700 }
                        : last
                          // Tried already: muted, so an untried number is the one that
                          // stands out. Not disabled — trying again is often the right move.
                          ? { borderColor: '#c6ccd6', color: '#6b7280' }
                          : { borderColor: '#1565c0', color: '#1565c0', fontWeight: 700 }}
                  />
                </Tooltip>
              );
                    })}
                  </Stack>
                </Box>
              );
            })}
          {state.dialable.every((d) => lastAttemptOn(d.number)) && state.dialable.length > 0 && (
            <Typography variant="caption" sx={{ display: 'block', color: '#8a5a00', mb: 1.5 }}>
              Every number on this card has been tried at least once. Nothing here is new —
              check the dates before dialling again.
            </Typography>
          )}
          {state.dialable.some((d) => d.dnc) && (
            <Typography variant="caption" sx={{ display: 'block', color: '#b3261e', mb: 1.5 }}>
              {state.dialable.filter((d) => d.dnc).length} of these {state.dialable.length} numbers
              are on the do-not-call list. They are listed last and flagged — check before dialling one.
            </Typography>
          )}

          <Typography variant="caption" sx={{ fontWeight: 700, display: 'block', mb: 0.5 }}>
            What happened? One tap — it is timestamped for you.
          </Typography>
          <Stack direction="row" spacing={0.75} sx={{ mb: 1.5, flexWrap: 'wrap' }} useFlexGap>
            {CALL_OUTCOMES.map((o) => (
              <Tooltip key={o.key} arrow title={o.follows}>
                <span>
                  <Button
                    size="small" variant="outlined" disabled={busy}
                    onClick={() => log(o.key)}
                    sx={{
                      fontSize: 11, textTransform: 'none',
                      ...(o.tone === 'bad' ? { borderColor: '#f2a3a3', color: '#b3261e' } : {}),
                      ...(o.tone === 'good' ? { borderColor: '#9bd4b0', color: '#166534' } : {}),
                    }}
                  >
                    {o.label}
                  </Button>
                </span>
              </Tooltip>
            ))}
          </Stack>

          <Stack direction={{ xs: 'column', sm: 'row' }} spacing={1} sx={{ mb: 1 }}>
            <TextField
              size="small" fullWidth placeholder="Notes (optional)"
              value={notes} onChange={(e) => setNotes(e.target.value)}
            />
            <TextField
              size="small" type="datetime-local" label="Callback" sx={{ minWidth: 210 }}
              value={callbackAt} onChange={(e) => setCallbackAt(e.target.value)}
              required
              error={Boolean(error) && !callbackAt}
              slotProps={{
                inputLabel: { shrink: true },
                /**
                 * Nothing before now. The panel only ever surfaces callbacks still ahead,
                 * so a past one is recorded and then never shown to anybody — which is
                 * indistinguishable from not having set one.
                 */
                htmlInput: {
                  min: new Date(Date.now() - new Date().getTimezoneOffset() * 60_000)
                    .toISOString().slice(0, 16),
                },
              }}
            />
          </Stack>
        </>
      )}

      {/*
        ── An address, taken on the call (Frank's item 8) ────────────────────

        Aimed at the 72 rated C1–C3 accounts with no verified address, which Ruben calls
        first precisely because we cannot email them. The one thing that call can produce
        that nothing else can is the address itself, said out loud by the person it belongs
        to — better evidence than a skip trace, a tax roll or a verifier, all of which are
        guesses about who owns a mailbox.

        Collapsed by default so it does not compete with the outcome buttons, which are what
        the panel is for.
      */}
      {/*
        Under the outcome buttons, because it is what you reach for AFTER tapping "No
        answer" — not an alternative to recording what happened.
      */}
      <Box sx={{ mb: 1.5 }}>
        <Typography variant="caption" sx={{ display: 'block', color: '#5a6675', mb: 0.5 }}>
          No answer? Remind me to try again in —
        </Typography>
        <Stack direction="row" spacing={1} useFlexGap sx={{ flexWrap: 'wrap', gap: 1 }}>
          {[10, 15, 30, 60].map((m) => (
            <Button
              key={m}
              size="small"
              variant="outlined"
              disabled={remBusy}
              onClick={() => remind(m)}
              sx={{ textTransform: 'none', minWidth: 0, px: 1.5 }}
            >
              {m < 60 ? `${m} min` : '1 hour'}
            </Button>
          ))}
        </Stack>

        {reminders.length > 0 && (
          <Box sx={{ mt: 1 }}>
            {reminders.map((r) => (
              <Stack
                key={r.id}
                direction="row"
                spacing={1}
                sx={{ alignItems: 'center', mb: 0.5, flexWrap: 'wrap', gap: 0.5 }}
              >
                <Chip
                  size="small"
                  label={r.minutesUntil <= 0
                    ? `due now${r.minutesUntil < -1 ? ` (${Math.abs(r.minutesUntil)} min ago)` : ''}`
                    : `in ${r.minutesUntil} min`}
                  sx={{
                    height: 20, fontSize: 11, fontWeight: 700,
                    bgcolor: r.minutesUntil <= 0 ? '#fdecea' : '#eef4ff',
                    color: r.minutesUntil <= 0 ? '#b3261e' : '#1a3d7c',
                  }}
                />
                <Typography variant="caption" sx={{ color: '#5a6675' }}>
                  {r.dueLabel}{r.phone ? ` · ${r.phone}` : ''}
                </Typography>
                <Button size="small" variant="text" sx={{ minWidth: 0, px: 0.75 }}
                  onClick={() => closeReminder(r.id, 'done')}>done</Button>
                <Button size="small" variant="text" color="inherit" sx={{ minWidth: 0, px: 0.75, color: '#8a8f98' }}
                  onClick={() => closeReminder(r.id, 'dismissed')}>drop</Button>
              </Stack>
            ))}
          </Box>
        )}
      </Box>

      <Box sx={{ mb: 1.5 }}>
        {!capOpen ? (
          <Button size="small" variant="text" onClick={() => setCapOpen(true)} sx={{ pl: 0 }}>
            + Add an email they gave you
          </Button>
        ) : (
          <Paper variant="outlined" sx={{ p: 1.5, bgcolor: '#fafbfc' }}>
            <Typography variant="caption" sx={{ fontWeight: 700, display: 'block', mb: 1 }}>
              An address from the call
            </Typography>
            <Stack direction="row" spacing={1} sx={{ flexWrap: 'wrap', gap: 1 }}>
              <TextField
                size="small" label="Insured email" type="email" sx={{ flex: '1 1 220px' }}
                value={capIns} onChange={(e) => setCapIns(e.target.value)}
                slotProps={{ inputLabel: { shrink: true } }}
                placeholder="name@example.com"
              />
              <TextField
                size="small" label="Co-insured email" type="email" sx={{ flex: '1 1 220px' }}
                value={capCo} onChange={(e) => setCapCo(e.target.value)}
                slotProps={{ inputLabel: { shrink: true } }}
                placeholder="optional"
              />
            </Stack>
            <Stack direction="row" spacing={1} sx={{ mt: 1, alignItems: 'center' }}>
              <Button size="small" variant="contained" disabled={busy} onClick={captureEmail}>
                Save address
              </Button>
              <Button size="small" onClick={() => { setCapOpen(false); setCapIns(''); setCapCo(''); }}>
                Cancel
              </Button>
              <Typography variant="caption" sx={{ color: '#5a6675' }}>
                Taken from the customer, so it outranks anything a trace found.
              </Typography>
            </Stack>
          </Paper>
        )}
      </Box>

      {state.invalidNumbers.length > 0 && (
        <Typography variant="caption" sx={{ display: 'block', color: '#b3261e', mb: 1 }}>
          Not dialling: {state.invalidNumbers.map(fmtPhone).join(', ')} — marked bad or wrong person.
        </Typography>
      )}

      {state.attempts.length > 0 && (
        <>
          <Divider sx={{ my: 1.5 }} />
          <Box sx={{ display: 'flex', alignItems: 'baseline', justifyContent: 'space-between', mb: 0.75 }}>
            <Typography variant="caption" sx={{ fontWeight: 700 }}>
              Every attempt
            </Typography>
            {/*
              Sits beside the history, not among the outcome buttons.

              It is a correction to what is already recorded, so it belongs where the record
              is — and keeping it away from the eight things Ruben taps mid-call means it
              cannot be hit by accident on the way to "No answer".
            */}
            <Button size="small" variant="text" disabled={busy}
              onClick={() => { setReqOpen((v) => !v); setError(null); setMsg(null); }}
              sx={{ minWidth: 0, py: 0, px: 0.75, fontSize: 11, color: '#5a6675' }}>
              {reqOpen ? 'cancel' : 'put back in the queue'}
            </Button>
          </Box>

          {reqOpen && (
            <Box sx={{ mb: 1.5, p: 1.25, border: '1px solid #e3e7ee', borderRadius: 1, bgcolor: '#fafbfc' }}>
              <Typography variant="caption" sx={{ display: 'block', color: '#5a6675', mb: 1 }}>
                The calls below stay on the record. This lead goes back into the queue as though
                it had not been called yet, and your name and reason go on the card.
              </Typography>
              <TextField
                size="small" fullWidth autoFocus
                label="Why (optional)"
                placeholder="e.g. status set while testing"
                value={reqReason}
                onChange={(e) => setReqReason(e.target.value)}
                slotProps={{ inputLabel: { shrink: true } }}
                sx={{ mb: 1 }}
              />
              <Button size="small" variant="contained" disabled={busy} onClick={returnToQueue}>
                Put back in the queue
              </Button>
            </Box>
          )}
          {/*
            Undo sits on the newest row only, and only inside the window the service
            allows. A button on every row would invite editing history; this is for the
            five seconds after a wrong tap.
          */}
          {state.attempts.map((a, idx) => {
            const spec = CALL_OUTCOMES.find((o) => o.key === a.outcome);
            return (
              <Box key={a.id} sx={{ display: 'flex', gap: 1, py: 0.5, alignItems: 'baseline', flexWrap: 'wrap' }}>
                <Typography variant="caption" sx={{ minWidth: 118, color: '#5a6675' }}>
                  {/*
                    Eastern, always — not the reader's own clock.

                    This was toLocaleString() on a value the browser parsed as local, so a
                    call placed at 12:42 AM in New Jersey showed as 4:42 AM. Frank, 25 Sep:
                    "calling-hours rules and day counts depend on it." Whoever opens the
                    card, the agency operates on Eastern and the log has to say Eastern.
                  */}
                  {easternDisplay(a.attemptedAt)}
                </Typography>
                <Typography variant="caption" sx={{ fontFamily: 'monospace' }}>
                  {fmtPhone(a.numberDialled)}
                </Typography>
                {/*
                  Whose number was rung, on the row that records it.
                  The role has been stored on every attempt all along — 57 of the 269
                  calls on the book are to a co-insured — and the log never showed it, so
                  the history read as though every call had been to the insured.
                */}
                {a.numberRole === 'co_insured' && (
                  <Typography variant="caption" sx={{ color: '#6b4e00', fontWeight: 600 }}>
                    co-insured
                  </Typography>
                )}
                <Typography variant="caption" sx={{
                  fontWeight: 700,
                  color: spec?.tone === 'good' ? '#166534' : spec?.tone === 'bad' ? '#b3261e' : '#5a6675',
                }}>
                  {spec?.label ?? a.outcome}
                </Typography>
                {/*
                  The callback date, on the row that created it (Frank's item 1).

                  Without it the log says a callback was scheduled and not for when, so the
                  only way to find the date was to trust the one chip at the top — which
                  shows the NEXT callback across the whole lead, not this row's.
                */}
                {a.callbackAt && (
                  <Typography variant="caption" sx={{ color: '#1565c0', fontWeight: 600 }}>
                    · due {easternDisplay(a.callbackAt)} ET
                  </Typography>
                )}
                {a.notes && <Typography variant="caption" sx={{ color: '#5a6675' }}>· {a.notes}</Typography>}
                {a.calledBy && <Typography variant="caption" sx={{ color: '#9098a6' }}>· {a.calledBy}</Typography>}
                {idx === 0 && (
                  <Button size="small" variant="text" disabled={busy} onClick={undoLast}
                    sx={{ minWidth: 0, py: 0, px: 0.75, fontSize: 11, color: "#b3261e" }}>
                    undo
                  </Button>
                )}
              </Box>
            );
          })}
        </>
      )}
    </Paper>
  );
}
