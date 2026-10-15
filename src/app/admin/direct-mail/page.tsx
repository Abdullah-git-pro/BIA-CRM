'use client';

import React, { useCallback, useEffect, useRef, useState } from 'react';
import {
  Container, Box, Typography, Paper, Stack, Button, TextField, MenuItem, Alert,
  CircularProgress, Chip, Divider, FormControlLabel, Switch, Tooltip,
  Dialog, DialogTitle, DialogContent, DialogContentText, DialogActions, IconButton,
} from '@mui/material';
import SaveIcon from '@mui/icons-material/Save';
import AddIcon from '@mui/icons-material/Add';
import WarningAmberIcon from '@mui/icons-material/WarningAmber';
import PrintIcon from '@mui/icons-material/Print';
import CloseIcon from '@mui/icons-material/Close';
import LetterEditor from '@/components/LetterEditor';

/**
 * The direct-mail letter: written here, printed by the vendor, priced by the same function
 * the emails use.
 *
 * ── Why the CRM edits the letter at all ─────────────────────────────────────
 * Abdullah, 15 Oct 2026. The alternative is a PDF from a designer, which bakes the band
 * price into artwork at design time — so a household's letter would quote whatever was true
 * when the file was made rather than what the card says today, and every wording change
 * would be a round trip. Written here, the letter asks the same question the email asks and
 * gets the same answer.
 *
 * ── Nothing on this screen sends anything ───────────────────────────────────
 * There is no send button and the endpoint behind it does not exist yet. A letter cannot be
 * recalled, and the template has to go through an E&O or counsel review before any of it is
 * printed — Frank's own condition. This screen writes the letter and shows exactly who would
 * receive it; posting it is a later, separate, deliberate act.
 */

type Template = {
  id: string; name: string; html: string; size: string; color: boolean; doubleSided: boolean;
  fromName: string | null; fromStreet: string | null; fromCity: string | null;
  fromState: string | null; fromZip: string | null;
  printedVars: string[]; approvedAt: string | null; approvedBy: string | null;
  updatedAt: string; updatedBy: string | null;
};

type Readiness = {
  cohort: string; total: number; ready: number; needsPerson: number;
  awaitingRating: number; rollNotRun: number; blocked: number; noAddress: number;
};

type Check = {
  used: string[]; unknown: string[];
  missingFor: Array<{ variable: string; propertyIds: string[] }>;
};

type Preview = {
  propertyId: string; name: string; mailsElsewhere: boolean; address: string; html: string;
};

const BLANK: Omit<Template, 'id' | 'printedVars' | 'approvedAt' | 'approvedBy' | 'updatedAt' | 'updatedBy'> = {
  name: '', html: '', size: 'us_letter', color: false, doubleSided: true,
  fromName: '', fromStreet: '', fromCity: '', fromState: 'NJ', fromZip: '',
};

/**
 * The starter is a letter BODY, not a page.
 *
 * No wrapper, no page padding, no geometry. The vendor prints the recipient address and a
 * routing barcode over the top of page one, and the system reserves 3.25in for them on send
 * — measured from a rendered proof, because Lob publishes no number. The first version of
 * this starter carried its own 0.75in padding and the proof came back with the salutation
 * and half the opening paragraph printed underneath the barcode.
 *
 * A starter that carries page geometry teaches everyone who copies it to write pages, and
 * the first one to get the clearance wrong prints a whole batch with its opening hidden.
 * There is also no address line here: the vendor prints that itself.
 */
const STARTER = `<p>Dear {{first_name}},</p>

<p>Your home insurance renews in {{month}}. We are an independent local agency and we
review renewals in your area before they roll over.</p>

<p>Based on what we can see about your property at {{property_address}}, we would expect a
premium in the range of <strong>\${{band_low}} to \${{band_high}}</strong>.</p>

<p>If that is higher than you expected, it is worth a short conversation.</p>

<p>Call us on [TRACKING NUMBER].</p>`;

export default function DirectMailPage() {
  const [templates, setTemplates] = useState<Template[]>([]);
  const [letterVars, setLetterVars] = useState<string[]>([]);
  const [editing, setEditing] = useState<Partial<Template>>({ ...BLANK });
  const [cohorts, setCohorts] = useState<Readiness[]>([]);
  const [cohort, setCohort] = useState('2026-10-12');
  const [count, setCount] = useState<number | null>(null);
  const [check, setCheck] = useState<Check | null>(null);
  const [preview, setPreview] = useState<Preview | null>(null);
  const [loading, setLoading] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [note, setNote] = useState<string | null>(null);

  const seq = useRef(0);
  /** Set by the editor so the variable chips can insert where the cursor is. */
  const insertRef = useRef<((text: string) => void) | null>(null);

  /**
   * The proof: the letter as the printer will actually produce it.
   *
   * Worth its own state because it is the only view that tells the truth about the page.
   * The editor shows the body; the vendor composes the address block, the routing barcode
   * and the envelope window onto it afterwards — which is how the first version of this
   * letter came back with its salutation printed underneath a barcode.
   */
  const [proof, setProof] = useState<{
    letterId: string; pages: string[]; recipient: { name: string; address: string; mailsElsewhere: boolean };
    expectedAt: string | null; rendering: boolean;
  } | null>(null);
  const proofPoll = useRef<ReturnType<typeof setTimeout> | null>(null);
  /**
   * Whether anybody is still looking. Closing the dialog stops the polling — otherwise a
   * letter that takes two minutes keeps asking the vendor long after the person who wanted
   * it has moved on, and pops an error at them from a screen they already left.
   */
  const proofWanted = useRef(false);

  const closeProof = useCallback(() => {
    proofWanted.current = false;
    if (proofPoll.current) clearTimeout(proofPoll.current);
    setProof(null);
  }, []);

  useEffect(() => () => { if (proofPoll.current) clearTimeout(proofPoll.current); }, []);

  const renderProof = useCallback(async () => {
    if (!editing.id) return;
    setError(null);
    setProof(null);
    proofWanted.current = true;
    try {
      const res = await fetch('/api/admin/direct-mail/proof', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ templateId: editing.id, cohort }),
      });
      const json = await res.json();
      if (!json.success) throw new Error(json.error || 'Could not render a proof');

      setProof({
        letterId: json.letterId, pages: [], recipient: json.recipient,
        expectedAt: json.expectedAt, rendering: true,
      });

      /**
       * Poll, because the vendor renders asynchronously — measured at anywhere from a
       * second to a little over two minutes. Capped so a letter that never renders stops
       * asking rather than hammering them until the tab is closed.
       */
      let tries = 0;
      const ask = async () => {
        if (!proofWanted.current) return;
        tries++;
        const r = await fetch(`/api/admin/direct-mail/proof?letterId=${encodeURIComponent(json.letterId)}`);
        const j = await r.json();
        if (!proofWanted.current) return;
        if (j.success && j.ready) {
          setProof((prev) => (prev && prev.letterId === json.letterId
            ? { ...prev, pages: j.pages, rendering: false } : prev));
          return;
        }
        if (tries > 45) {
          setProof((prev) => (prev && prev.letterId === json.letterId
            ? { ...prev, rendering: false } : prev));
          setError('The printer has not produced this proof after three minutes. It is usually quicker — try again.');
          return;
        }
        proofPoll.current = setTimeout(ask, 4000);
      };
      proofPoll.current = setTimeout(ask, 2500);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Could not render a proof');
    }
  }, [editing.id, cohort]);

  const loadTemplates = useCallback(async () => {
    const res = await fetch('/api/admin/direct-mail/templates');
    const json = await res.json();
    if (!json.success) return;
    setTemplates(json.templates ?? []);
    setLetterVars(json.letterVars ?? []);
  }, []);

  useEffect(() => { loadTemplates(); }, [loadTemplates]);

  /** The list, and — when a template is selected — whether every letter renders whole. */
  const loadList = useCallback(async (c: string, templateId?: string) => {
    const n = ++seq.current;
    setLoading(true);
    setError(null);
    try {
      const qs = new URLSearchParams({ cohort: c, grade: 'A' });
      if (templateId) qs.set('templateId', templateId);
      const res = await fetch(`/api/admin/direct-mail/list?${qs}`);
      const json = await res.json();
      if (n !== seq.current) return;
      if (!json.success) throw new Error(json.error || 'Could not build the list');
      setCount(json.count ?? 0);
      setCheck(json.check ?? null);
      setPreview(json.preview ?? null);
      setCohorts((prev) => {
        const next = prev.slice();
        const i = next.findIndex((r) => r.cohort === c);
        if (i >= 0 && json.readiness) next[i] = json.readiness;
        return next;
      });
    } catch (e) {
      if (n === seq.current) setError(e instanceof Error ? e.message : 'Something went wrong');
    } finally {
      if (n === seq.current) setLoading(false);
    }
  }, []);

  /**
   * The batch: what it would print, what it would cost, and how far it has got.
   *
   * Quoted before it is run, every time. A button labelled "send" over a week of 50
   * households is not consent if the person pressing it cannot see that it is 50 and $53.
   */
  const [quote, setQuote] = useState<{
    cohort: string; mode: 'test' | 'live'; batchId: string;
    pending: number; alreadySent: number; estimatedCost: number; unitCost: number;
    liveAvailable: boolean; approved: boolean; blocked: boolean; overCap: boolean; maxBatch: number;
    missingFrom?: string[];
    failures?: Array<{ propertyId: string; toStreet: string; toCity: string; toZip: string; error: string }>;
  } | null>(null);
  const [quoting, setQuoting] = useState(false);
  /**
   * The letter as it was last saved, so unsaved edits can be told apart from saved ones.
   *
   * Everything that renders a real letter — the proof, the preview, the send — reads the
   * SAVED template from the database. Nothing stopped somebody adding a divider, pressing
   * "Render a proof" and studying a page that did not contain it, with no sign that the
   * thing on screen and the thing in the editor were different documents. Approving a proof
   * of a letter that was never stored is the version of that mistake that reaches paper.
   */
  const [saved, setSaved] = useState<Partial<Template> | null>(null);
  const [liveAvailable, setLiveAvailable] = useState(false);
  const [run, setRun] = useState<{ done: number; total: number; failed: number } | null>(null);
  const stopRun = useRef(false);

  const askSend = useCallback(async (mode: 'test' | 'live') => {
    if (!editing.id) return;
    setQuoting(true);
    setError(null);
    try {
      const qs = new URLSearchParams({ cohort, templateId: String(editing.id), mode, dry: '1' });
      const res = await fetch(`/api/admin/direct-mail/send?${qs}`, { method: 'POST' });
      const json = await res.json();
      if (!json.success) throw new Error(json.error || 'Could not price the batch');
      setQuote(json);
      setLiveAvailable(!!json.liveAvailable);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Could not price the batch');
    } finally {
      setQuoting(false);
    }
  }, [editing.id, cohort]);

  /**
   * The loop lives here because a cohort cannot finish inside a serverless budget. Each
   * chunk is its own request and the endpoint is resumable — closing the tab stops the run
   * rather than breaking it, and every letter already printed is already recorded.
   */
  const startSend = useCallback(async (q: NonNullable<typeof quote>) => {
    setQuote(null);
    setRun({ done: 0, total: q.pending, failed: 0 });
    stopRun.current = false;
    setError(null);
    try {
      let guard = 0;
      for (;;) {
        if (stopRun.current) break;
        if (++guard > 400) throw new Error('Stopped after 400 chunks — something is not finishing.');
        const qs = new URLSearchParams({
          cohort: q.cohort, templateId: String(editing.id), mode: q.mode,
          batchId: q.batchId, chunk: '10',
        });
        const res = await fetch(`/api/admin/direct-mail/send?${qs}`, { method: 'POST' });
        const json = await res.json();
        if (!json.success) throw new Error(json.error || 'The run failed');
        setRun((r) => (r ? {
          done: r.done + (json.processed ?? 0),
          failed: r.failed + (json.failed ?? 0),
          total: r.done + (json.processed ?? 0) + (json.remaining ?? 0),
        } : r));
        if (json.done || !json.processed) break;
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : 'The run failed');
    } finally {
      setRun(null);
      loadList(cohort, editing.id);
    }
  }, [editing.id, cohort, loadList]);

  useEffect(() => {
    (async () => {
      const res = await fetch('/api/admin/direct-mail/list?grade=A');
      const json = await res.json();
      if (json.success) setCohorts(json.readiness ?? []);
    })();
  }, []);

  useEffect(() => { loadList(cohort, editing.id); }, [cohort, editing.id, loadList]);

  /**
   * The mode banner has to be right before anybody presses anything, so it is not waiting
   * on somebody opening the send dialog to find out whether live mail is switched on.
   */
  useEffect(() => {
    if (!editing.id) return;
    (async () => {
      const qs = new URLSearchParams({ cohort, templateId: String(editing.id), mode: 'test', dry: '1' });
      const res = await fetch(`/api/admin/direct-mail/send?${qs}`, { method: 'POST' });
      const j = await res.json();
      if (j.success) setLiveAvailable(!!j.liveAvailable);
    })();
  }, [editing.id, cohort]);

  const save = async () => {
    setSaving(true);
    setError(null);
    setNote(null);
    try {
      const res = await fetch('/api/admin/direct-mail/templates', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(editing),
      });
      const json = await res.json();
      if (!json.success) throw new Error(json.error || 'Could not save');
      setEditing(json.template);
      setSaved(json.template);
      setNote(json.approvalCleared
        ? 'Saved. The wording changed, so the compliance approval has been cleared — it needs reviewing again before anything is printed.'
        : 'Saved.');
      await loadTemplates();
      loadList(cohort, json.template.id);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Could not save');
    } finally {
      setSaving(false);
    }
  };

  const set = <K extends keyof Template>(k: K, v: Template[K]) =>
    setEditing((t) => ({ ...t, [k]: v }));

  const current = cohorts.find((r) => r.cohort === cohort);

  /** Does the editor hold anything the database does not? */
  const dirty = !!editing.id && !!saved && (
    (editing.html ?? '') !== (saved.html ?? '')
    || (editing.name ?? '') !== (saved.name ?? '')
    || (editing.size ?? 'us_letter') !== (saved.size ?? 'us_letter')
    || !!editing.color !== !!saved.color
    || (editing.doubleSided !== false) !== (saved.doubleSided !== false)
    || ['fromName', 'fromStreet', 'fromCity', 'fromState', 'fromZip'].some(
      (k) => String((editing as Record<string, unknown>)[k] ?? '') !== String((saved as Record<string, unknown>)[k] ?? ''))
  );

  return (
    <Container maxWidth="xl" sx={{ py: 4 }}>
      <Box sx={{ mb: 3 }}>
        <Typography variant="h4" sx={{ fontWeight: 'bold', mb: 0.5 }}>Direct mail</Typography>
        <Typography variant="body2" color="text.secondary">
          The letter, and who would receive it. Nothing on this screen posts anything.
        </Typography>
      </Box>

      {/*
        The mode banner.

        Loud, permanent, and at the top — because the one mistake that cannot be taken back
        is believing you are rehearsing when you are not. It states the mode as a fact about
        the system rather than as a setting somebody chose.
      */}
      <Alert severity={liveAvailable ? 'warning' : 'info'} sx={{ mb: 2 }}>
        {liveAvailable ? (
          <>
            <strong>Live mail is switched on.</strong> Letters sent from this screen will be
            printed and posted, and cannot be recalled. Test sends are still available and
            still print nothing.
          </>
        ) : (
          <>
            <strong>Test mode.</strong> Nothing sent from this screen is printed or posted,
            and nothing is charged. Live mail needs the letter reviewed for compliance and
            <code> LOB_LIVE_ENABLED</code> set deliberately.
          </>
        )}
      </Alert>

      {error && <Alert severity="error" sx={{ mb: 2 }}>{error}</Alert>}
      {note && <Alert severity="success" sx={{ mb: 2 }} onClose={() => setNote(null)}>{note}</Alert>}

      <Stack direction={{ xs: 'column', lg: 'row' }} spacing={2.5} sx={{ alignItems: 'flex-start' }}>

        {/* ── The letter ─────────────────────────────────────────────────── */}
        <Paper variant="outlined" sx={{ p: 2.5, flex: '1 1 0', minWidth: 0, width: '100%' }}>
          <Stack direction="row" sx={{ alignItems: 'center', justifyContent: 'space-between', mb: 2 }}>
            <Typography sx={{ fontWeight: 700 }}>The letter</Typography>
            <Stack direction="row" spacing={1}>
              <TextField
                select size="small" sx={{ minWidth: 190 }}
                value={editing.id ?? ''}
                onChange={(e) => {
                  const t = templates.find((x) => x.id === e.target.value);
                  setEditing(t ? { ...t } : { ...BLANK });
                  setSaved(t ? { ...t } : null);
                }}
              >
                <MenuItem value="">— new template —</MenuItem>
                {templates.map((t) => (
                  <MenuItem key={t.id} value={t.id}>{t.name}</MenuItem>
                ))}
              </TextField>
              <Button size="small" startIcon={<AddIcon />} onClick={() => { setEditing({ ...BLANK, html: STARTER }); setSaved(null); }}>
                Start from example
              </Button>
            </Stack>
          </Stack>

          <TextField
            label="Name" size="small" fullWidth sx={{ mb: 1.5 }}
            value={editing.name ?? ''} onChange={(e) => set('name', e.target.value)}
          />

          <LetterEditor
            value={editing.html ?? ''}
            onChange={(html) => set('html', html)}
            onRegisterInsert={(fn) => { insertRef.current = fn; }}
          />

          <Box sx={{ mt: 1.5, mb: 2 }}>
            <Typography variant="caption" sx={{ color: '#5a6675', display: 'block', mb: 0.5 }}>
              Variables this letter can use — click to insert at the cursor
            </Typography>
            <Stack direction="row" sx={{ flexWrap: 'wrap', gap: 0.5 }}>
              {letterVars.map((v) => (
                <Chip
                  key={v} size="small" label={`{{${v}}}`} variant="outlined"
                  sx={{ fontFamily: 'ui-monospace, monospace', fontSize: 11, cursor: 'pointer' }}
                  /*
                    Inserted where the writer is typing, not appended to the end. Appending
                    put {{band_low}} after the sign-off and left them to cut and paste it
                    back into the sentence it belonged in.
                  */
                  onClick={() => insertRef.current?.(`{{${v}}}`)}
                />
              ))}
            </Stack>
          </Box>

          <Divider sx={{ my: 2 }} />

          <Typography variant="caption" sx={{ fontWeight: 700, color: '#5a6675' }}>
            Return address — printed on the envelope
          </Typography>
          <Stack direction="row" spacing={1} sx={{ mt: 1, flexWrap: 'wrap', gap: 1 }}>
            <TextField label="Agency name" size="small" sx={{ flex: '1 1 200px' }}
              value={editing.fromName ?? ''} onChange={(e) => set('fromName', e.target.value)} />
            <TextField label="Street" size="small" sx={{ flex: '1 1 200px' }}
              value={editing.fromStreet ?? ''} onChange={(e) => set('fromStreet', e.target.value)} />
            <TextField label="City" size="small" sx={{ flex: '1 1 120px' }}
              value={editing.fromCity ?? ''} onChange={(e) => set('fromCity', e.target.value)} />
            <TextField label="State" size="small" sx={{ width: 90 }}
              value={editing.fromState ?? ''} onChange={(e) => set('fromState', e.target.value)} />
            <TextField label="ZIP" size="small" sx={{ width: 110 }}
              value={editing.fromZip ?? ''} onChange={(e) => set('fromZip', e.target.value)} />
          </Stack>

          <Stack direction="row" spacing={2} sx={{ mt: 2, alignItems: 'center', flexWrap: 'wrap' }}>
            <TextField select size="small" label="Paper" sx={{ width: 140 }}
              value={editing.size ?? 'us_letter'} onChange={(e) => set('size', e.target.value)}>
              <MenuItem value="us_letter">US Letter</MenuItem>
              <MenuItem value="us_legal">US Legal</MenuItem>
            </TextField>
            <FormControlLabel
              control={<Switch size="small" checked={!!editing.color}
                onChange={(e) => set('color', e.target.checked)} />}
              label={<Typography variant="body2">Colour</Typography>} />
            <FormControlLabel
              control={<Switch size="small" checked={editing.doubleSided !== false}
                onChange={(e) => set('doubleSided', e.target.checked)} />}
              label={<Typography variant="body2">Double sided</Typography>} />
            <Box sx={{ flex: 1 }} />
            {/*
              The proof sits with the letter, not with the list.
              It answers "what does my letter look like", which is a question about the
              thing being edited — and it is the only view that tells the truth about the
              page, because the vendor composes the address block and barcode onto it after
              we hand the HTML over.
            */}
            {editing.id && (
              <Tooltip
                arrow
                title={dirty
                  ? 'Save first. The proof prints the saved letter, so it would not show what you have just changed.'
                  : 'Print this letter for one real household and show the actual page — address block, barcode and all. Free, and nothing is posted.'}
              >
                <span>
                  <Button
                    variant="outlined" sx={{ textTransform: 'none' }}
                    startIcon={proof?.rendering
                      ? <CircularProgress size={14} /> : <PrintIcon sx={{ fontSize: 17 }} />}
                    onClick={renderProof}
                    disabled={!!proof?.rendering || !editing.html || dirty}
                  >
                    {proof?.rendering ? 'Printing…' : 'Render a proof'}
                  </Button>
                </span>
              </Tooltip>
            )}
            <Button variant="contained" startIcon={saving ? <CircularProgress size={14} color="inherit" /> : <SaveIcon />}
              onClick={save} disabled={saving || !editing.name}>
              Save
            </Button>
          </Stack>

          {/*
            Approval is a person's act and it is shown as a fact, not as a setting. An
            approved letter that is then edited is an unapproved letter — the save clears it.
          */}
          {dirty && (
            <Alert severity="warning" sx={{ mt: 1.5 }}>
              <strong>Unsaved changes.</strong> The proof, the preview and the send all read
              the saved letter — save before you look at any of them, or you will be
              approving a page that does not contain this edit.
            </Alert>
          )}

          {editing.id && (
            <Box sx={{ mt: 1.5 }}>
              {editing.approvedAt ? (
                <Chip size="small" label={`Compliance approved by ${editing.approvedBy ?? 'someone'}`}
                  sx={{ bgcolor: '#e7f5ec', color: '#166534', fontWeight: 600 }} />
              ) : (
                <Chip size="small" icon={<WarningAmberIcon sx={{ fontSize: 15 }} />}
                  label="Not yet reviewed for compliance"
                  sx={{ bgcolor: '#fff3d6', color: '#8a5a00', fontWeight: 600 }} />
              )}
            </Box>
          )}
        </Paper>

        {/* ── Who would get it ───────────────────────────────────────────── */}
        <Paper variant="outlined" sx={{ p: 2.5, flex: '1 1 0', minWidth: 0, width: '100%' }}>
          <Stack direction="row" sx={{ alignItems: 'center', justifyContent: 'space-between', mb: 2 }}>
            <Typography sx={{ fontWeight: 700 }}>Who would get it</Typography>
            <TextField select size="small" sx={{ minWidth: 150 }} value={cohort}
              onChange={(e) => setCohort(e.target.value)}>
              {cohorts.map((r) => (
                <MenuItem key={r.cohort} value={r.cohort}>{r.cohort}</MenuItem>
              ))}
            </TextField>
          </Stack>

          {loading && <CircularProgress size={18} />}

          {count != null && (
            <Box sx={{ mb: 2 }}>
              <Typography sx={{ fontSize: 34, fontWeight: 700, lineHeight: 1.1 }}>
                {count.toLocaleString()}
              </Typography>
              <Typography variant="body2" color="text.secondary">
                letters — Grade A, name confirmed on the tax roll, priced, with an address
              </Typography>
            </Box>
          )}

          {/*
            Why the rest are not getting one. Each line is a different person's job: a
            reviewer, a producer, or the roll runner. "Awaiting a rating" had no home on any
            screen before this — those leads are green everywhere else and still unmailable.
          */}
          {current && (
            <Box sx={{ mb: 2 }}>
              {[
                { n: current.needsPerson, label: 'held for a person — the roll did not confirm the name' },
                { n: current.awaitingRating, label: 'awaiting a carrier rating — no band price yet' },
                { n: current.rollNotRun, label: 'the roll has not been run' },
                { n: current.noAddress, label: 'no mailing address on file' },
                { n: current.blocked, label: 'town we cannot check at all' },
              ].map((r) => (
                <Stack key={r.label} direction="row" spacing={1} sx={{ alignItems: 'baseline', lineHeight: 1.6 }}>
                  <Box sx={{ width: 34, textAlign: 'right', fontWeight: 700, fontSize: 13,
                    color: r.n ? '#b4690e' : '#c3cad4', fontVariantNumeric: 'tabular-nums' }}>
                    {r.n || '–'}
                  </Box>
                  <Box sx={{ fontSize: 12.5, color: r.n ? '#5a6675' : '#b4bcc7' }}>{r.label}</Box>
                </Stack>
              ))}
              <Typography variant="caption" sx={{ color: '#8a94a6', display: 'block', mt: 1 }}>
                {current.total.toLocaleString()} Grade A in this week
              </Typography>
            </Box>
          )}

          {check && !!check.unknown.length && (
            <Alert severity="error" sx={{ mb: 2 }}>
              This letter uses {check.unknown.map((u) => `{{${u}}}`).join(', ')}, which direct mail
              cannot supply.
            </Alert>
          )}
          {check && !!check.missingFor.length && (
            <Alert severity="warning" sx={{ mb: 2 }}>
              {check.missingFor.map((m) => (
                <Box key={m.variable}>
                  <strong>{m.propertyIds.length}</strong> of these households have no{' '}
                  <code>{`{{${m.variable}}}`}</code> — their letter would print a gap.
                </Box>
              ))}
            </Alert>
          )}
          {check && !check.unknown.length && !check.missingFor.length && !!check.used.length && (
            <Alert severity="success" sx={{ mb: 2 }}>
              Every one of these {count} letters renders completely.
            </Alert>
          )}

          {/*
            ── Printing ──────────────────────────────────────────────────────
            Both buttons price the batch first and neither sends anything on its own click.
            Test is offered beside live on purpose: a rehearsal over the real list, with the
            real letter, is the last thing worth doing before paper.
          */}
          {editing.id && (
            <Box sx={{ mt: 2, pt: 2, borderTop: '1px solid #eef1f5' }}>
              {run ? (
                <Stack direction="row" spacing={1.5} sx={{ alignItems: 'center' }}>
                  <CircularProgress size={18} />
                  <Box>
                    <Typography variant="body2" sx={{ fontWeight: 600 }}>
                      Printing {run.done.toLocaleString()} of {run.total.toLocaleString()}
                      {!!run.failed && ` · ${run.failed} failed`}
                    </Typography>
                    <Typography variant="caption" sx={{ color: '#8a94a6' }}>
                      Keep this tab open. Every letter already printed is already recorded.
                    </Typography>
                  </Box>
                  <Box sx={{ flex: 1 }} />
                  <Button size="small" color="inherit" onClick={() => { stopRun.current = true; }}>
                    Stop
                  </Button>
                </Stack>
              ) : (
                <Stack direction="row" spacing={1} sx={{ alignItems: 'center', flexWrap: 'wrap', gap: 1 }}>
                  <Button
                    variant="outlined" size="small" sx={{ textTransform: 'none' }}
                    startIcon={quoting ? <CircularProgress size={13} /> : undefined}
                    disabled={quoting || !count || dirty}
                    onClick={() => askSend('test')}
                  >
                    Test run over this week
                  </Button>
                  <Tooltip
                    arrow
                    title={dirty
                      ? 'Save the letter first — a send prints the saved wording, not what is on screen.'
                      : liveAvailable
                        ? 'Print and post these letters for real. You will see the count and the cost first.'
                        : 'Live mail is switched off. It needs the letter reviewed for compliance and LOB_LIVE_ENABLED set.'}
                  >
                    <span>
                      <Button
                        variant="contained" size="small" color="warning"
                        sx={{ textTransform: 'none' }}
                        disabled={quoting || !count || !liveAvailable || dirty}
                        onClick={() => askSend('live')}
                      >
                        Print and post
                      </Button>
                    </span>
                  </Tooltip>
                </Stack>
              )}
            </Box>
          )}

          {preview && (
            <Box>
              <Stack direction="row" spacing={1} sx={{ alignItems: 'center', mb: 1 }}>
                <Typography variant="caption" sx={{ fontWeight: 700, color: '#5a6675' }}>
                  Preview — {preview.name}
                </Typography>
                {preview.mailsElsewhere && (
                  <Tooltip title="This household's letter goes somewhere other than the insured property. Previewed on purpose: it is the case most likely to read wrong.">
                    <Chip size="small" label="mails elsewhere"
                      sx={{ height: 18, fontSize: 10, bgcolor: '#fff3d6', color: '#8a5a00' }} />
                  </Tooltip>
                )}
              </Stack>
              <Typography variant="caption" sx={{ color: '#8a94a6', display: 'block' }}>
                {preview.address}
              </Typography>
              {/*
                Said plainly, because this preview cannot show it. The vendor composes the
                recipient address and barcode onto the top of page one after we hand the HTML
                over, so the overlap only exists in the printed PDF — which is exactly how the
                first proof came back with its salutation underneath the barcode.
              */}
              <Typography variant="caption" sx={{ color: '#8a94a6', display: 'block', mb: 1, fontStyle: 'italic' }}>
                This is the <strong>saved</strong> letter. The recipient address and barcode
                print above it — 3.25in is reserved automatically.
              </Typography>
              <Box
                sx={{ border: '1px solid #e4e9f0', borderRadius: 1, bgcolor: '#fff', p: 1,
                  maxHeight: 420, overflow: 'auto' }}
                dangerouslySetInnerHTML={{ __html: preview.html }}
              />
            </Box>
          )}
        </Paper>
      </Stack>

      {/*
        ── The cost, in front of the person about to spend it ────────────────
        The same shape as the contact-check quote: the number of letters and what they cost,
        stated before anything happens, with the live case saying plainly that it cannot be
        taken back.
      */}
      <Dialog open={!!quote} onClose={() => setQuote(null)} maxWidth="sm" fullWidth>
        <DialogTitle sx={{ fontWeight: 700 }}>
          {quote?.mode === 'live' ? 'Print and post these letters?' : 'Test run over this week?'}
        </DialogTitle>
        <DialogContent>
          <DialogContentText component="div">
            {!quote?.pending ? (
              <Box>Every mailable household in this week has already had this letter.</Box>
            ) : (
              <>
                <Box sx={{ fontSize: 15, mb: 1.5 }}>
                  <strong>{quote.pending.toLocaleString()}</strong> letters
                  {quote.mode === 'live' && quote.estimatedCost > 0 && (
                    <> · about <strong>${quote.estimatedCost.toFixed(2)}</strong> at $
                      {quote.unitCost.toFixed(2)} each</>
                  )}
                  {quote.mode === 'test' && <> · free, nothing is printed or posted</>}
                </Box>

                {!!quote.alreadySent && (
                  <Box sx={{ fontSize: 13.5, color: '#5a6675', mb: 1 }}>
                    {quote.alreadySent.toLocaleString()} household
                    {quote.alreadySent === 1 ? ' has' : 's have'} already been attempted for
                    this week and {quote.alreadySent === 1 ? 'is' : 'are'} excluded.
                  </Box>
                )}

                {/*
                  Addresses the printer would not accept. Shown with the vendor's own words,
                  because the fix is to the address and not to the batch — retrying prints
                  the same refusal.
                */}
                {!!quote.failures?.length && (
                  <Alert severity="warning" sx={{ mb: 1.5 }}>
                    <strong>{quote.failures.length}</strong> could not be printed — the
                    printer would not accept the address:
                    <Box component="ul" sx={{ pl: 2.5, my: 0.5 }}>
                      {quote.failures.slice(0, 5).map((f) => (
                        <li key={f.propertyId} style={{ fontSize: 12.5 }}>
                          {f.toStreet}, {f.toCity} {f.toZip}
                        </li>
                      ))}
                    </Box>
                    These need the address corrected, not another attempt.
                  </Alert>
                )}

                {quote.mode === 'live' ? (
                  <Alert severity="warning" sx={{ mb: 1.5 }}>
                    These are printed and posted. They cannot be recalled, edited or
                    suppressed once this starts.
                  </Alert>
                ) : (
                  <Box sx={{ fontSize: 13.5, color: '#5a6675', mb: 1 }}>
                    A rehearsal over the real list with the real letter. Nothing reaches
                    anybody.
                  </Box>
                )}

                {quote.overCap && (
                  <Alert severity="error" sx={{ mb: 1.5 }}>
                    {quote.pending.toLocaleString()} is more than one run may print
                    ({quote.maxBatch}). Split it.
                  </Alert>
                )}
                {!!quote.missingFrom?.length && (
                  <Alert severity="error" sx={{ mb: 1.5 }}>
                    This letter has no return address — the printer refuses every letter
                    without one. Fill in the return address and save.
                  </Alert>
                )}
                {quote.blocked && !quote.missingFrom?.length && (
                  <Alert severity="error" sx={{ mb: 1.5 }}>
                    Some of these letters would print with a gap in them. Fix the letter first.
                  </Alert>
                )}
                {quote.mode === 'live' && !quote.approved && (
                  <Alert severity="error" sx={{ mb: 1.5 }}>
                    This letter has not been reviewed for compliance.
                  </Alert>
                )}

                <Box sx={{ fontSize: 13.5, color: '#5a6675' }}>
                  Keep this tab open while it runs. You can stop at any point; every letter
                  already printed is already recorded, and stopping never prints one twice.
                </Box>
              </>
            )}
          </DialogContentText>
        </DialogContent>
        <DialogActions>
          <Button color="inherit" onClick={() => setQuote(null)}>Cancel</Button>
          <Button
            variant="contained"
            color={quote?.mode === 'live' ? 'warning' : 'primary'}
            disabled={!quote?.pending || quote.blocked || quote.overCap
              || (quote.mode === 'live' && !quote.approved)}
            onClick={() => { if (quote) startSend(quote); }}
          >
            {quote?.mode === 'live'
              ? `Print and post ${quote?.pending.toLocaleString()}`
              : `Run ${quote?.pending.toLocaleString()} test letters`}
          </Button>
        </DialogActions>
      </Dialog>

      {/*
        ── The proof, full size ──────────────────────────────────────────────
        A letter page is 8.5x11 — tall, narrow, and unreadable squeezed into a column
        beside a form. It gets the screen.

        The dialog opens the moment the letter is requested rather than when it is ready,
        so the wait is visible and closable: the vendor renders at its own pace, measured
        anywhere from a second to a little over two minutes.
      */}
      <Dialog open={!!proof} onClose={closeProof} maxWidth="md" fullWidth scroll="paper">
        <DialogTitle sx={{ pb: 1 }}>
          <Stack direction="row" sx={{ alignItems: 'center', justifyContent: 'space-between' }}>
            <Box>
              <Typography sx={{ fontWeight: 700, fontSize: 18 }}>
                The letter, as it will be printed
              </Typography>
              {proof && (
                <Typography variant="caption" sx={{ color: '#5a6675' }}>
                  {proof.recipient.name} · {proof.recipient.address}
                  {proof.expectedAt && ` · would arrive about ${proof.expectedAt}`}
                </Typography>
              )}
            </Box>
            <IconButton onClick={closeProof} size="small" aria-label="Close the proof">
              <CloseIcon />
            </IconButton>
          </Stack>
          {proof?.recipient.mailsElsewhere && (
            <Tooltip arrow title="Proofed on a household whose letter goes somewhere other than the insured property — the case most likely to read wrong, and the one a spot check would miss.">
              <Chip size="small" label="mails elsewhere"
                sx={{ mt: 0.75, height: 19, fontSize: 10.5, bgcolor: '#fff3d6', color: '#8a5a00' }} />
            </Tooltip>
          )}
        </DialogTitle>

        <DialogContent dividers sx={{ bgcolor: '#f4f6f9' }}>
          {proof?.rendering ? (
            <Stack spacing={1.5} sx={{ alignItems: 'center', py: 8 }}>
              <CircularProgress size={28} />
              <Typography variant="body2" sx={{ color: '#5a6675' }}>
                The printer is rendering it…
              </Typography>
              <Typography variant="caption" sx={{ color: '#8a94a6' }}>
                Usually seconds, sometimes a couple of minutes. You can close this.
              </Typography>
            </Stack>
          ) : (
            <Stack spacing={2} sx={{ alignItems: 'center' }}>
              {proof?.pages.map((src, i) => (
                <Box key={src} sx={{ width: '100%', maxWidth: 760 }}>
                  {(proof.pages.length > 1) && (
                    <Typography variant="caption" sx={{ color: '#8a94a6', display: 'block', mb: 0.5 }}>
                      Page {i + 1} of {proof.pages.length}
                    </Typography>
                  )}
                  {/* eslint-disable-next-line @next/next/no-img-element */}
                  <img
                    src={src} alt={`Letter page ${i + 1}`}
                    style={{ width: '100%', display: 'block', background: '#fff',
                      border: '1px solid #dde3ec', borderRadius: 4,
                      boxShadow: '0 1px 6px rgba(16,24,40,0.08)' }}
                  />
                </Box>
              ))}
            </Stack>
          )}
        </DialogContent>

        <DialogActions sx={{ justifyContent: 'space-between', px: 3 }}>
          <Typography variant="caption" sx={{ color: '#8a94a6' }}>
            Test print — free, never posted, and not recorded as a letter to this household.
          </Typography>
          <Button onClick={closeProof}>Close</Button>
        </DialogActions>
      </Dialog>
    </Container>
  );
}
