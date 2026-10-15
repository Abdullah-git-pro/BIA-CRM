'use client';

import { useEffect, useState, useCallback } from 'react';
import { useParams, useRouter } from 'next/navigation';
import {
  Box, Breadcrumbs, Button, Chip, CircularProgress, Divider, Grid,
  MenuItem, Paper, Select, Stack, TextField, Tooltip, Typography,
  Alert, Snackbar, FormControl, InputLabel, Checkbox, FormControlLabel, FormHelperText,
} from '@mui/material';
import Link from 'next/link';
import { getMissingFields } from '@/services/grade.service';
import { GRADE_INFO, LeadGrade } from '@/types/grade';
import {
  SELECTABLE_LEAD_STATUS_OPTIONS, leadStatusLabel, CLOSED_STATUSES, LeadStatus,
} from '@/types/lead';
import { ELIGIBILITY_REASONS } from '@/types/carrier';
import { WIPP_BY_ZIP } from '@/services/taxRoll.service';
import { parseRollOwners, compareOwnerNames } from '@/services/ownerNameMatch.service';
import ArrowBackIcon from '@mui/icons-material/ArrowBack';
import HomeIcon from '@mui/icons-material/Home';
import CheckCircleIcon from '@mui/icons-material/CheckCircle';
import CancelIcon from '@mui/icons-material/Cancel';
import HelpOutlineIcon from '@mui/icons-material/HelpOutlined';
import WavesIcon from '@mui/icons-material/Waves';
import FactCheckIcon from '@mui/icons-material/FactCheck';
import ContactPhoneIcon from '@mui/icons-material/ContactPhone';
import SaveIcon from '@mui/icons-material/Save';
import SkipNextIcon from '@mui/icons-material/SkipNext';
import GavelIcon from '@mui/icons-material/Gavel';
import PersonSearchIcon from '@mui/icons-material/PersonSearch';
import VerifiedIcon from '@mui/icons-material/Verified';
import SkipTraceDialog from '@/components/SkipTraceDialog';
import EmailVerdictMark, { verdictKey, type EmailVerdicts, type PersonRole } from '@/components/EmailVerdictMark';
import UnclaimedAddressPanel from '@/components/UnclaimedAddressPanel';
import CallDispositionPanel from '@/components/CallDispositionPanel';
import QuoteOutcomePanel from '@/components/QuoteOutcomePanel';
import { useAuth } from '@/context/AuthContext';

// ─── Helpers ─────────────────────────────────────────────────────────────────

function fmt(v: number | null | undefined, prefix = '') {
  if (v == null) return '—';
  return `${prefix}${Number(v).toLocaleString()}`;
}

/**
 * Suggested Indicative Band Price from the rated premiums (Frank, Jul-2026 sync).
 * This is the outreach hook — "we have you rated at $725–$900" — so it must be
 * credible, not a wide guess.
 *
 * Both carriers rated → the spread between them, rounded outward to $25. Matches
 * Frank's worked examples exactly: $750 & $899 → $725–$900; $760 & $900 → $750–$900.
 * (Low nudges to the next $25 BELOW — strictly below when it lands on a boundary.)
 * Only one carrier rated → ±$250 around it, his fallback for a single data point.
 * Producers override whenever their judgement differs.
 */
export function suggestBand(travelers?: number, plymouth?: number): { low: number; high: number } | null {
  const vals = [travelers, plymouth].filter((v): v is number => typeof v === 'number' && Number.isFinite(v) && v > 0);
  if (!vals.length) return null;
  const strictFloor25 = (n: number) => { const f = Math.floor(n / 25) * 25; return f === n ? n - 25 : f; };
  const ceil25 = (n: number) => Math.ceil(n / 25) * 25;
  if (vals.length === 2) return { low: strictFloor25(Math.min(...vals)), high: ceil25(Math.max(...vals)) };
  const p = vals[0];
  return { low: strictFloor25(p - 250), high: ceil25(p + 250) };
}

/** Read-only DOB display — "1962-01-01 · age 64 (est.)". Age is derived from the
 *  year so it stays correct whether the DOB is REAPI-estimated or admin-corrected. */
function dobDisplay(v: unknown): string {
  if (!v) return '';
  const s = String(v).slice(0, 10);
  const y = parseInt(s.slice(0, 4), 10);
  const age = y ? new Date().getFullYear() - y : null;
  return `${s}${age && age > 0 && age < 120 ? ` · age ${age}` : ''} (est.)`;
}

function fmtCurrency(v: number | null | undefined) {
  if (v == null) return '—';
  return new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD', maximumFractionDigits: 0 }).format(v);
}

// Grade chip colors — sourced from GRADE_INFO so the detail page matches the
// lead table exactly (A green · B orange · C red · D grey).
function gradeChipSx(g: string | null) {
  const info = GRADE_INFO[(g ?? '') as LeadGrade];
  if (!info) return {};
  return {
    backgroundColor: info.backgroundColor,
    color: info.color,
    border: `1px solid ${info.borderColor}`,
    fontWeight: 700,
  };
}

function statusLabel(s: string | null) {
  return leadStatusLabel(s);
}

function coastChip(exposure: string | null) {
  if (!exposure) return <Chip label="No coord data" size="small" />;
  const map: Record<string, { color: 'error' | 'warning' | 'info' | 'success', label: string }> = {
    extreme: { color: 'error', label: '🔴 Extreme Coastal' },
    high: { color: 'warning', label: '🟠 High Coastal' },
    moderate: { color: 'info', label: '🟡 Moderate Coastal' },
    low: { color: 'success', label: '🟢 Low Coastal Risk' },
  };
  const cfg = map[exposure] ?? { color: 'default' as any, label: exposure };
  return <Chip label={cfg.label} color={cfg.color} size="small" />;
}

function eligibilityIcon(status: string | null) {
  if (status === 'eligible') return <CheckCircleIcon fontSize="small" color="success" />;
  if (status === 'ineligible') return <CancelIcon fontSize="small" color="error" />;
  return <HelpOutlineIcon fontSize="small" color="warning" />;
}

// ─── Section card ─────────────────────────────────────────────────────────────

function Section({ title, children, sx }: { title: string; children: React.ReactNode; sx?: object }) {
  return (
    <Paper variant="outlined" sx={{ p: 2.5, borderRadius: 2, ...sx }}>
      <Typography variant="subtitle2" color="text.secondary" gutterBottom sx={{ fontWeight: 700, textTransform: 'uppercase', letterSpacing: 0.5, fontSize: 11 }}>
        {title}
      </Typography>
      {children}
    </Paper>
  );
}

function Row({ label, value }: { label: string; value: React.ReactNode }) {
  return (
    <Stack direction="row" sx={{ justifyContent: 'space-between', alignItems: 'flex-start', py: 0.5 }} spacing={1}>
      <Typography variant="body2" color="text.secondary" noWrap sx={{ minWidth: 110, flexShrink: 0 }}>{label}</Typography>
      <Typography variant="body2" component="div" sx={{ fontWeight: 500, textAlign: 'right', minWidth: 0, wordBreak: 'break-word' }}>{value ?? '—'}</Typography>
    </Stack>
  );
}

/**
 * A person's email addresses, each with the identity verdict beside it.
 *
 * One per line rather than comma-joined: these carry a mark that has to attach to a
 * particular address, and "a@x.com, b@y.com not theirs" leaves which one ambiguous at
 * exactly the moment it matters. Three addresses is the common case and four lines is not a
 * crowded card.
 *
 * An address with no mark has not been checked. That is most of the book — only C2 has been
 * through the identity check — so absence is drawn as nothing at all rather than as a
 * warning, and a clean card must never read as a row of silent failures.
 */
function EmailList({ label, addresses, verdicts, role }: {
  label: string;
  addresses: string[];
  verdicts: EmailVerdicts;
  /** Whose line this is. The verdict is looked up for THIS person, never the other one. */
  role: PersonRole;
}) {
  return (
    /*
      Full width with the label above, not a Row.

      A Row keeps 110px for the label and right-aligns the value, which leaves about 190px —
      narrower than an ordinary address, so bernice.curto@gmail.com broke across two lines
      mid-word and the tick ended up under it. These are lists rather than single values and
      they get the panel's whole width.
    */
    <Box sx={{ py: 0.5 }}>
      <Typography variant="body2" color="text.secondary" sx={{ mb: 0.25 }}>{label}</Typography>
      {addresses.map((e) => {
        const v = verdicts[verdictKey(e, role)];
        return (
          /*
            Inline, not a flex row.

            As a flex row the mark was its own item, so an address that filled the column
            pushed the tick onto a line of its own and a card read as a column of stray ✓s
            with nothing to attach them to. Inline text keeps the mark immediately after the
            last character, wherever that lands.
          */
          <Box key={e} sx={{ fontSize: 14, fontWeight: 500, lineHeight: 1.75, wordBreak: 'break-word' }}>
            {/* Struck through when it is somebody else's: the address stays readable — it is
                still what the trace returned — but it should not look sendable. */}
            <Box component="span" sx={v?.nameMatch === false
              ? { color: '#8a94a6', textDecoration: 'line-through' }
              : undefined}>
              {e}
            </Box>
            <EmailVerdictMark verdict={v} />
          </Box>
        );
      })}
    </Box>
  );
}

// Labelled heading for a sub-section inside the Row 1 / Row 2 worksheet bands.
function SubHead({ children }: { children: React.ReactNode }) {
  return (
    <Typography variant="caption" sx={{ fontWeight: 700, textTransform: 'uppercase', letterSpacing: 0.5, color: 'primary.main', display: 'block', mb: 0.75, pb: 0.5, borderBottom: '2px solid', borderColor: 'divider' }}>
      {children}
    </Typography>
  );
}

// Compact labelled <Select> for the editable Home-Features / confirm-on-call forms.
// `options` are [value, label] tuples; an "Unknown" (empty) choice is always first.
function FeatureSelect({ label, value, onChange, options, unknownLabel = 'Unknown', showEmpty = false }: {
  label: string;
  value: string;
  onChange: (v: string) => void;
  options: Array<[string, string]>;
  unknownLabel?: string;
  /**
   * Show the empty choice in the CLOSED field instead of leaving it blank.
   *
   * Off by default, because on the other fifteen selects here an unset value is unremarkable
   * and a blank box reads fine. It is on for the verification dropdowns, where "nobody has
   * checked this" is itself the answer: those feed the cohort's verified column, and a field
   * that looks empty reads the same as one that failed to load. Somebody deciding whether
   * 616 addresses still need checking should not have to click a dropdown to find out.
   */
  showEmpty?: boolean;
}) {
  return (
    <FormControl size="small" fullWidth>
      {/* shrink is forced with showEmpty, or the label sits on top of the empty-state text. */}
      <InputLabel shrink={showEmpty ? true : undefined}>{label}</InputLabel>
      <Select
        value={value ?? ''}
        label={label}
        displayEmpty={showEmpty}
        notched={showEmpty ? true : undefined}
        onChange={(e) => onChange(e.target.value)}
      >
        <MenuItem value=""><em>{unknownLabel}</em></MenuItem>
        {options.map(([v, l]) => <MenuItem key={v} value={v}>{l}</MenuItem>)}
      </Select>
    </FormControl>
  );
}

/**
 * ZeroBounce's own vocabulary, offered to a person in their words.
 *
 * Kept as the vendor's values rather than a friendly enum, because the same column holds
 * imported verdicts and hand-set ones and the ledger reads both. A second vocabulary would
 * mean a translation somewhere, and a translation is a place the two can disagree.
 *
 * Only "valid" is deliverable — see DELIVERABLE_STATUSES in emailVerification.service. A
 * catch-all domain accepts everything and tells you nothing, which is why it does not count.
 */
/**
 * Every verdict ZeroBounce can return, for DISPLAY.
 *
 * The importer writes all of these, so the dropdown has to be able to render any of them —
 * a lead the verifier called catch-all must not show as blank just because a person could
 * not have chosen it.
 */
const VERIFY_LABELS: Record<string, string> = {
  valid: 'Verified — deliverable',
  invalid: 'Invalid — does not exist',
  'catch-all': 'Catch-all — cannot tell',
  unknown: 'Unknown — checker could not say',
  abuse: 'Abuse — known complainer',
  spamtrap: 'Spam trap — never mail',
  do_not_mail: 'Do not mail',
};

/**
 * What a PERSON may choose: the two a human can actually know.
 *
 * The rest are things only a verifier can determine — whether a domain accepts everything,
 * whether an address is a trap — and a producer picking one of those is guessing into a
 * column the cohort reports. They still arrive from the import and still display; they are
 * simply not on the menu.
 */
const VERIFY_CHOICES = ['valid', 'invalid'];

// Travelers Q#7 restricted dog breeds — confirmed by a BIA employee on first contact.
const RESTRICTED_DOG_BREEDS = [
  'Akita', 'Alaskan Malamute', 'American Bull Terrier', 'American Staffordshire Terrier',
  'Mastiff', 'Chow Chow', 'Doberman Pinscher', 'Pit Bull', 'Presa Canario',
  'Rottweiler', 'Staffordshire Bull Terrier', 'Wolf Hybrid',
];

// ─── Page ────────────────────────────────────────────────────────────────────

export default function LeadDetailPage() {
  const { id } = useParams<{ id: string }>();
  const router = useRouter();
  const { user } = useAuth();
  const isAdmin = user?.role === 'admin' || user?.role === 'superadmin';

  // Return to wherever the producer came from — the actual previous page (filtered
  // Leads, a specific Queue tab, QC Reports, …) — instead of a hardcoded route.
  // Falls back to the leads list only when there's no in-app history (direct open).
  /**
   * Where this lead was opened from, carried on the URL so "next lead" keeps it and Back
   * still knows the way home several leads into a queue.
   */
  const cameFrom = typeof window === 'undefined'
    ? null
    : new URLSearchParams(window.location.search).get('from');
  const keepOrigin = (href: string) => (cameFrom ? `${href}?from=${encodeURIComponent(cameFrom)}` : href);

  const goBack = () => {
    if (typeof window === 'undefined') return;
    // A lead opened from a QC report carries ?from=<report key>. router.back() alone
    // lands on the QC page with its React state gone — the chosen report shows its
    // empty "press Run" state and the pipeline tab is back at the first stage — so the
    // producer has to rebuild the view they were already looking at. ?restore=1 tells
    // that page to re-apply the filters it kept and re-run itself.
    if (cameFrom) { router.push(`/admin/qc?restore=1&from=${encodeURIComponent(cameFrom)}`); return; }
    if (window.history.length > 1) router.back();
    else router.push('/leads');
  };

  const [lead, setLead] = useState<any>(null);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [nextLeadId, setNextLeadId] = useState<string | null>(null);
  const [snackbar, setSnackbar] = useState<{ open: boolean; msg: string; severity: 'success' | 'error' }>({ open: false, msg: '', severity: 'success' });

  // Producer form state
  const [status, setStatus] = useState('');
  /**
   * Isolated — its own field, deliberately not a status (Frank, 23 Sep 2026).
   *
   * "Isolated" means Grade A with no insured email: we would quote this lead and cannot
   * email it. That is a fact about REACH, and status is a fact about how far the lead has
   * got. Storing it as a status made them alternatives, so parking a lead for skip tracing
   * erased that it was rated — which is how a week holding 61 rated leads reported 48.
   */
  const [isolated, setIsolated] = useState(false);
  const [posQuoteNumber, setPosQuoteNumber] = useState('');
  const [posCarrier, setPosCarrier] = useState('');
  const [posQuotePremium, setPosQuotePremium] = useState('');
  const [boundPremium, setBoundPremium] = useState('');
  const [varianceNotes, setVarianceNotes] = useState('');
  const [varianceReason, setVarianceReason] = useState('');
  const [authorizationMethod, setAuthorizationMethod] = useState('');
  const [authorizationDate, setAuthorizationDate] = useState<string | null>(null);
  const [stampingAuth, setStampingAuth] = useState(false);
  const [skipTracing, setSkipTracing] = useState(false);
  const [overridingName, setOverridingName] = useState(false);
  const [verifyingOwner, setVerifyingOwner] = useState(false);
  const [floodChecking, setFloodChecking] = useState(false);
  const [enriching, setEnriching] = useState(false);
  const [batchTracing, setBatchTracing] = useState(false);
  const [skipDialogOpen, setSkipDialogOpen] = useState(false);

  /**
   * Identity verdicts for this lead's addresses, fetched when the card opens.
   *
   * It used to wait for the skip-trace dialog, which is why the verdicts could be paid for
   * and still be invisible: the card body showed the same addresses as plain text, so a
   * dead one looked identical to a good one unless somebody thought to open a popup.
   *
   * Still its own request rather than a join on the lead payload — only C2 has been graded,
   * so for most cards this returns nothing, and the join would be paid by every screen that
   * reads a lead. One small fetch per card is the cheaper side of that trade.
   */
  const [verifiedEmails, setVerifiedEmails] = useState<EmailVerdicts>({});
  useEffect(() => {
    if (!lead?.propertyId) return;
    let cancelled = false;
    (async () => {
      try {
        const res = await fetch(`/api/leads/${lead.propertyId}/contact-verification`);
        const json = await res.json();
        if (cancelled || !json.success) return;
        const map: EmailVerdicts = {};
        for (const e of (json.email ?? [])) {
          // Keyed by address AND role: the same address can be attributed to both people
          // and come back as one person's and not the other's.
          const role = e.role === 'coInsured' ? 'coInsured' : 'insured';
          map[verdictKey(String(e.value), role)] = {
            nameMatch: e.nameMatch, isValid: e.isValid,
            ageScore: e.ageScore ?? null, contactGrade: e.contactGrade ?? null,
          };
        }
        setVerifiedEmails(map);
      } catch {
        // A failed read leaves the marks off, which is the same as never checked — the one
        // thing it must not do is draw an address as somebody else's on no evidence.
      }
    })();
    return () => { cancelled = true; };
  }, [lead?.propertyId]);
  const [lostReason, setLostReason] = useState('');
  const [lostStage, setLostStage] = useState('');
  const [producerNote, setProducerNote] = useState('');
  // Manual grade override + revisit + competitor capture
  const [manualGrade, setManualGrade] = useState('');
  const [gradeOverrideReason, setGradeOverrideReason] = useState('');
  const [revisitFlag, setRevisitFlag] = useState(false);
  const [revisitDate, setRevisitDate] = useState('');
  const [revisitNote, setRevisitNote] = useState('');
  const [competitorCarrier, setCompetitorCarrier] = useState('');
  const [competitorPremium, setCompetitorPremium] = useState('');
  // Roof confirmation (year clears the B/C roof-age gate; type drives carrier eligibility)
  const [roofYear, setRoofYear] = useState('');
  const [roofType, setRoofType] = useState('');
  // Frank Jun-2026: dual insureds / DOB / confirm-on-call / home features (single bag)
  const [extra, setExtra] = useState<Record<string, any>>({});
  const setEx = (k: string, v: any) => setExtra((p) => ({ ...p, [k]: v }));
  const [showCondoFields, setShowCondoFields] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    const res = await fetch(`/api/leads/${id}`);
    const json = await res.json();
    if (json.success) {
      const l = json.data;
      setLead(l);
      /**
       * A lead isolated before 23 Sep 2026 has 'isolated' sitting IN its status, with the
       * real one in isolatedFromStatus. Show the real one, so the dropdown never offers a
       * value it does not contain — 'isolated' is not in LEAD_STATUS_OPTIONS and never was.
       */
      setStatus((l.status === 'isolated' ? l.isolatedFromStatus : l.status) ?? 'new');
      setIsolated(l.isolatedAt != null || l.status === 'isolated');
      setPosQuoteNumber(l.posQuoteNumber ?? '');
      setPosCarrier(l.posCarrier ?? '');
      setPosQuotePremium(l.posQuotePremium != null ? String(l.posQuotePremium) : '');
      setBoundPremium(l.boundPremium != null ? String(l.boundPremium) : '');
      setVarianceNotes(l.varianceNotes ?? '');
      setVarianceReason(l.varianceReason ?? '');
      setAuthorizationMethod(l.authorizationMethod ?? '');
      setAuthorizationDate(l.authorizationDate ?? null);
      setLostReason(l.lostReason ?? '');
      setLostStage(l.lostStage ?? '');
      setManualGrade(l.manualGrade ?? '');
      setGradeOverrideReason(l.gradeOverrideReason ?? '');
      setRevisitFlag(!!l.revisitFlag);
      setRevisitDate(l.revisitDate ? String(l.revisitDate).slice(0, 10) : '');
      setRevisitNote(l.revisitNote ?? '');
      setCompetitorCarrier(l.competitorCarrier ?? '');
      setCompetitorPremium(l.competitorPremium != null ? String(l.competitorPremium) : '');
      setRoofYear(l.roofYear != null ? String(l.roofYear) : '');
      setRoofType(l.roofType ?? '');
      setExtra({
        owner2FirstName: l.owner2FirstName ?? '',
        owner2LastName: l.owner2LastName ?? '',
        owner2Phone: l.owner2Phone ?? '',
        owner2Email: l.owner2Email ?? '',
        maritalStatus: l.maritalStatus ?? '',
        owner1Dob: l.owner1Dob ? String(l.owner1Dob).slice(0, 10) : '',
        owner2Dob: l.owner2Dob ? String(l.owner2Dob).slice(0, 10) : '',
        reapiDob: l.reapiDob ? String(l.reapiDob).slice(0, 10) : '',
        dogBreed: l.dogBreed ?? '',
        insuranceHistory: l.insuranceHistory ?? 'currently_insured', // assumed valid until call
        heatingRenovatedYear: l.heatingRenovatedYear != null ? String(l.heatingRenovatedYear) : '',
        bathroomsFull: l.bathroomsFull != null ? String(l.bathroomsFull) : '',
        bathroomsHalf: l.bathroomsHalf != null ? String(l.bathroomsHalf) : '',
        garageType: l.garageType ?? '',
        garageCount: l.garageCount != null ? String(l.garageCount) : '',
        sidingType: l.sidingType ?? '',
        foundationType: l.foundationType ?? '',
        heatSource: l.heatSource ?? 'gas', // NJ default
        feetFromHydrant: l.feetFromHydrant != null ? String(l.feetFromHydrant) : '',
        burglarAlarm: l.burglarAlarm ?? '',
        fireAlarm: l.fireAlarm ?? '',
        sprinklerSystem: !!l.sprinklerSystem,
        smokeDetector: l.smokeDetector ?? '',
        waterSensor: l.waterSensor ?? '',
        autoWaterShutoff: l.autoWaterShutoff ?? '',
        lowTempSensor: l.lowTempSensor ?? '',
        leedCertified: !!l.leedCertified,
        effectiveDate: l.effectiveDate ? String(l.effectiveDate).slice(0, 10) : '',
        floodZoneType: l.floodZoneType ?? '',
        floodZoneManual: !!l.floodZoneManual,
        travelersPremium: l.travelersPremium != null ? String(l.travelersPremium) : '',
        plymouthPremium: l.plymouthPremium != null ? String(l.plymouthPremium) : '',
        travelersEligible: l.travelersEligible ?? '',
        plymouthEligible: l.plymouthEligible ?? '',
        travelersEligibilityReason: l.travelersEligibilityReason ?? '',
        plymouthEligibilityReason: l.plymouthEligibilityReason ?? '',
        travelersEligibilityDetail: l.travelersEligibilityDetail ?? '',
        plymouthEligibilityDetail: l.plymouthEligibilityDetail ?? '',
        indicativeBandLow: l.indicativeBandLow != null ? String(l.indicativeBandLow) : '',
        indicativeBandHigh: l.indicativeBandHigh != null ? String(l.indicativeBandHigh) : '',
        doNotRevisit: !!l.doNotRevisit,
        phone1: l.phone1 ?? '',
        email1: l.email1 ?? '',
        basementFinishedPct: l.basementFinishedPct ?? '',
        propertyTypeMismatch: !!l.propertyTypeMismatch,
        bathroomGrade: l.bathroomGrade ?? '',
        kitchenCount: l.kitchenCount != null ? String(l.kitchenCount) : '',
        kitchenGrade: l.kitchenGrade ?? '',
      });
    }
    setLoading(false);
  }, [id]);

  useEffect(() => { load(); }, [load]);

  /** Pre-fetch the next active Grade-A lead by x-date so "Save & Next" is instant */
  const prefetchNextLead = useCallback(async () => {
    try {
      const res = await fetch('/api/leads?source=db&size=50&active=true&grade=A&orderBy=xdate');
      const json = await res.json();
      if (json.success && json.data?.length) {
        const next = json.data.find((l: any) => l.propertyId !== id);
        setNextLeadId(next?.propertyId ?? null);
      }
    } catch { /* silent */ }
  }, [id]);

  useEffect(() => { prefetchNextLead(); }, [prefetchNextLead]);

  // ── Dirty tracking ──────────────────────────────────────────────────────────
  // Snapshot every editable field; Save stays disabled until one of them changes.
  const [pristine, setPristine] = useState<string | null>(null);
  const formSnapshot = JSON.stringify({
    status, isolated, posQuotePremium, boundPremium, varianceNotes, varianceReason,
    authorizationMethod, lostReason, lostStage, producerNote, manualGrade,
    gradeOverrideReason, revisitFlag, revisitDate, revisitNote,
    competitorCarrier, competitorPremium, roofYear, roofType, extra,
  });
  useEffect(() => {
    // Re-baseline the snapshot whenever a fresh lead is loaded or a save returns new data.
    if (!loading && lead) setPristine(formSnapshot);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [lead, loading]);
  const dirty = pristine !== null && formSnapshot !== pristine;

  /**
   * The verification verdict on each person's address.
   *
   * Loaded from its own endpoint rather than carried on the lead, because a verdict belongs
   * to an ADDRESS and a lead holds several — the insured's may pass while the co-insured's
   * fails, and a re-trace can replace either.
   */
  const [verify, setVerify] = useState<{
    insured: { email: string | null; status: string | null; source: string | null; verifiedAt: string | null };
    coInsured: { email: string | null; status: string | null; source: string | null; verifiedAt: string | null };
  } | null>(null);
  const [verifyBusy, setVerifyBusy] = useState<'insured' | 'coInsured' | null>(null);
  const [verifyErr, setVerifyErr] = useState<string | null>(null);

  const loadVerify = useCallback(async () => {
    if (!id) return;
    try {
      const j = await (await fetch(`/api/leads/${id}/verify-email`)).json();
      if (j.success) setVerify({ insured: j.insured, coInsured: j.coInsured });
    } catch { /* a verdict that fails to load must not take the worksheet down */ }
  }, [id]);

  /**
   * Load on mount and whenever the card changes.
   *
   * The fetch is wrapped rather than called straight, for two reasons. The lint rule is
   * right that setState directly inside an effect invites cascading renders; and `alive`
   * stops a slow response for the PREVIOUS lead painting its verdict onto this one — the
   * worksheet is stepped through lead by lead, so that race is the normal case, not an
   * edge one, and a wrong verdict here is a number the cohort then reports.
   */
  useEffect(() => {
    let alive = true;
    (async () => {
      if (!id) return;
      try {
        const j = await (await fetch(`/api/leads/${id}/verify-email`)).json();
        if (alive && j.success) setVerify({ insured: j.insured, coInsured: j.coInsured });
      } catch { /* a verdict that fails to load must not take the worksheet down */ }
    })();
    return () => { alive = false; };
  }, [id]);

  const setVerification = async (role: 'insured' | 'coInsured', status: string) => {
    setVerifyBusy(role);
    setVerifyErr(null);
    try {
      const res = await fetch(`/api/leads/${id}/verify-email`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ role, status }),
      });
      const j = await res.json();
      if (!j.success) throw new Error(j.error || 'Could not save that');
      await loadVerify();
    } catch (e) {
      setVerifyErr(e instanceof Error ? e.message : 'Could not save that');
    } finally {
      setVerifyBusy(null);
    }
  };

  const save = async (andNext = false) => {
    // Grade-override gate (Frank Phase 5b): changing the grade requires a comment.
    if (manualGrade && !gradeOverrideReason.trim()) {
      setSnackbar({ open: true, msg: 'A reason is required to save a manual grade override.', severity: 'error' });
      return;
    }
    // Close-out gate (Frank Phase 5): a lead can't be marked LOST without an
    // explanation (reason + stage) AND a revisit election (revisit OR do-not-revisit).
    if (status === 'lost') {
      if (!lostReason || !lostStage) {
        setSnackbar({ open: true, msg: 'Lost requires a reason and the stage it was lost at.', severity: 'error' });
        return;
      }
      if (!revisitFlag && !extra.doNotRevisit) {
        setSnackbar({ open: true, msg: 'Close-out: choose "Revisit next year" or "Do Not Revisit" before closing.', severity: 'error' });
        return;
      }
    }
    setSaving(true);
    const bp = boundPremium ? parseFloat(boundPremium) : undefined;
    const pqp = posQuotePremium ? parseFloat(posQuotePremium) : undefined;
    const varianceAmount = bp && lead?.expectedPremium
      ? Math.round((bp - lead.expectedPremium) * 10) / 10
      : undefined;

    const body: any = {
      status,
      /**
       * Setting it stamps the time; clearing it wipes the whole isolation record, so a
       * lead that comes back does not keep a stale reason explaining why it was parked.
       */
      isolatedAt: isolated ? (lead?.isolatedAt ?? new Date().toISOString()) : null,
      isolatedReason: isolated
        ? (lead?.isolatedReason ?? 'Marked isolated by a producer')
        : null,
      ...(isolated ? {} : { isolatedFromStatus: null }),
      posQuoteNumber: posQuoteNumber || undefined,
      posCarrier: posCarrier || undefined,
      posQuotePremium: pqp,
      boundPremium: bp,
      varianceNotes: varianceNotes || undefined,
      varianceReason: varianceReason || undefined,
      varianceAmount,
      authorizationMethod: authorizationMethod || undefined,
      lostReason: status === 'lost' ? (lostReason || undefined) : undefined,
      lostStage: status === 'lost' ? (lostStage || undefined) : undefined,
      // Manual grade override — send the field so the API can clear it when blank
      manualGrade: manualGrade || '',
      gradeOverrideReason: gradeOverrideReason || undefined,
      // Revisit / future re-engagement
      revisitFlag,
      revisitDate: revisitFlag && revisitDate ? revisitDate : undefined,
      revisitNote: revisitFlag ? (revisitNote || undefined) : undefined,
      // Lost-to-competitor price (only meaningful when lost)
      competitorCarrier: status === 'lost' ? (competitorCarrier || undefined) : undefined,
      competitorPremium: status === 'lost' && competitorPremium ? parseFloat(competitorPremium) : undefined,
      // Roof confirmation (producer-entered). Empty roof type → left as 'Unknown'.
      roofYear: roofYear ? parseInt(roofYear, 10) : undefined,
      roofType: roofType || undefined,
      // Frank Jun-2026: dual insureds / DOB / confirm-on-call / home features
      owner2FirstName: extra.owner2FirstName || undefined,
      owner2LastName: extra.owner2LastName || undefined,
      owner2Phone: extra.owner2Phone || undefined,
      owner2Email: extra.owner2Email || undefined,
      maritalStatus: extra.maritalStatus || undefined,
      owner1Dob: extra.owner1Dob || undefined,
      owner2Dob: extra.owner2Dob || undefined,
      // Admin-only DOB override (correct a wrong skip-trace estimate)
      ...(isAdmin ? { reapiDob: extra.reapiDob || undefined } : {}),
      dogBreed: extra.dogBreed || undefined,
      insuranceHistory: extra.insuranceHistory || undefined,
      heatingRenovatedYear: extra.heatingRenovatedYear ? parseInt(extra.heatingRenovatedYear, 10) : undefined,
      bathroomsFull: extra.bathroomsFull !== '' && extra.bathroomsFull != null ? parseInt(extra.bathroomsFull, 10) : undefined,
      bathroomsHalf: extra.bathroomsHalf !== '' && extra.bathroomsHalf != null ? parseInt(extra.bathroomsHalf, 10) : undefined,
      garageType: extra.garageType || undefined,
      garageCount: extra.garageCount !== '' && extra.garageCount != null ? parseInt(extra.garageCount, 10) : undefined,
      sidingType: extra.sidingType || undefined,
      foundationType: extra.foundationType || undefined,
      heatSource: extra.heatSource || undefined,
      feetFromHydrant: extra.feetFromHydrant !== '' && extra.feetFromHydrant != null ? parseInt(extra.feetFromHydrant, 10) : undefined,
      burglarAlarm: extra.burglarAlarm || undefined,
      fireAlarm: extra.fireAlarm || undefined,
      sprinklerSystem: !!extra.sprinklerSystem,
      smokeDetector: extra.smokeDetector || undefined,
      waterSensor: extra.waterSensor || undefined,
      autoWaterShutoff: extra.autoWaterShutoff || undefined,
      lowTempSensor: extra.lowTempSensor || undefined,
      leedCertified: !!extra.leedCertified,
      effectiveDate: extra.effectiveDate || undefined,
      // FEMA flood override (Phase 3a): when manual, send the zone + flag so
      // re-enrichment won't overwrite it with the FEMA lookup.
      floodZoneManual: !!extra.floodZoneManual,
      floodZoneType: extra.floodZoneManual ? (extra.floodZoneType || undefined) : undefined,
      // Carrier eligibility override (producer-editable) + reason for the change
      travelersEligible: extra.travelersEligible || undefined,
      plymouthEligible: extra.plymouthEligible || undefined,
      travelersEligibilityReason: extra.travelersEligibilityReason || undefined,
      plymouthEligibilityReason: extra.plymouthEligibilityReason || undefined,
      travelersEligibilityDetail: extra.travelersEligibilityDetail || undefined,
      plymouthEligibilityDetail: extra.plymouthEligibilityDetail || undefined,
      // Indicative band price for outreach merge (auto-suggested, producer-overridable)
      indicativeBandLow: extra.indicativeBandLow !== '' && extra.indicativeBandLow != null ? parseFloat(extra.indicativeBandLow) : undefined,
      indicativeBandHigh: extra.indicativeBandHigh !== '' && extra.indicativeBandHigh != null ? parseFloat(extra.indicativeBandHigh) : undefined,
      // Phase 5: carrier pricing + auto-assigned (cheaper) carrier
      travelersPremium: extra.travelersPremium !== '' && extra.travelersPremium != null ? parseFloat(extra.travelersPremium) : undefined,
      plymouthPremium: extra.plymouthPremium !== '' && extra.plymouthPremium != null ? parseFloat(extra.plymouthPremium) : undefined,
      assignedCarrier: (() => {
        const t = parseFloat(extra.travelersPremium); const p = parseFloat(extra.plymouthPremium);
        const tOk = !isNaN(t); const pOk = !isNaN(p);
        return tOk && pOk ? (t <= p ? 'travelers' : 'plymouth') : tOk ? 'travelers' : pOk ? 'plymouth' : undefined;
      })(),
      doNotRevisit: !!extra.doNotRevisit,
      phone1: extra.phone1 || undefined,
      email1: extra.email1 || undefined,
      basementFinishedPct: extra.basementFinishedPct || undefined,
      propertyTypeMismatch: !!extra.propertyTypeMismatch,
      bathroomGrade: extra.bathroomGrade || undefined,
      kitchenCount: extra.kitchenCount !== '' && extra.kitchenCount != null ? parseInt(extra.kitchenCount, 10) : undefined,
      kitchenGrade: extra.kitchenGrade || undefined,
      _createdBy: lead?.producerEmail || undefined,
      // Only send an explicit note when the producer typed one; otherwise the server
      // auto-logs the actual field-level changes (status, grade, edited fields).
      ...(producerNote ? { _activityNote: producerNote, _activityType: 'note' } : {}),
    };

    const res = await fetch(`/api/leads/${id}`, { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
    const json = await res.json();
    if (json.success) {
      setLead(json.data);
      setProducerNote('');
      if (andNext && nextLeadId) {
        router.push(keepOrigin(`/leads/${nextLeadId}`));
      } else {
        setSnackbar({ open: true, msg: 'Lead saved successfully', severity: 'success' });
        prefetchNextLead();
      }
    } else {
      setSnackbar({ open: true, msg: 'Save failed — try again', severity: 'error' });
    }
    setSaving(false);
  };

  /** One-click: stamp authorizationDate = now and persist immediately */
  const stampAuthDate = async () => {
    setStampingAuth(true);
    const now = new Date().toISOString();
    const res = await fetch(`/api/leads/${id}`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        authorizationDate: now,
        authorizationMethod: authorizationMethod || undefined,
        _activityNote: 'Authorization date stamped',
        _activityType: 'status_change',
      }),
    });
    const json = await res.json();
    if (json.success) {
      setAuthorizationDate(now);
      setLead(json.data);
      setSnackbar({ open: true, msg: 'Authorization date stamped', severity: 'success' });
    } else {
      setSnackbar({ open: true, msg: 'Failed to stamp authorization date', severity: 'error' });
    }
    setStampingAuth(false);
  };

  /** Run a REAPI skip trace for this lead (gated: carrier-qualified + not yet traced). */
  /** Confirm the insured name against the municipal tax roll (free, on demand). */
  const runOwnerVerifyAction = async () => {
    setVerifyingOwner(true);
    try {
      const res = await fetch(`/api/leads/${id}/verify-owner?force=1`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ _createdBy: lead?.producerEmail || undefined }),
      });
      const json = await res.json();
      if (json.success) {
        const st = json.result?.status ?? lead?.ownerVerifyStatus;
        setSnackbar({
          open: true,
          msg: st === 'match' ? 'Insured name confirmed against the tax roll'
            : st === 'partial' ? `Surname matches — tax roll shows "${json.result?.recordName}"`
            : st === 'mismatch' ? `Name mismatch — tax roll shows "${json.result?.recordName}"`
            : 'Could not confirm the insured name',
          severity: st === 'match' ? 'success' : 'error',
        });
        await load();
      } else {
        setSnackbar({ open: true, msg: json.error || 'Owner verification failed', severity: 'error' });
      }
    } catch {
      setSnackbar({ open: true, msg: 'Owner verification failed', severity: 'error' });
    } finally {
      setVerifyingOwner(false);
    }
  };

  /**
   * Second-source trace. Works on any grade — see the API route for why.
   */
  const runBatchDataAction = async () => {
    setBatchTracing(true);
    try {
      const res = await fetch(`/api/leads/${id}/batchdata`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ _createdBy: lead?.producerEmail || undefined }),
      });
      const j = await res.json();
      if (!j.success) {
        setSnackbar({ open: true, msg: j.error || 'BatchData trace failed', severity: 'error' });
      } else if (!j.matched) {
        setSnackbar({ open: true, msg: j.message || 'BatchData found nothing for this property', severity: 'error' });
      } else {
        const bits = [`${j.phones.length} phone(s)`, `${j.emails.length} email(s)`];
        if (j.regradedTo) bits.push(`grade → ${j.regradedTo}`);
        else if (j.overrideStands) bits.push('manual grade kept — review it');
        setSnackbar({ open: true, msg: `BatchData: ${bits.join(' · ')}`, severity: 'success' });
        await load();
      }
    } catch {
      setSnackbar({ open: true, msg: 'BatchData trace failed — try again', severity: 'error' });
    } finally {
      setBatchTracing(false);
    }
  };

  const runSkipTraceAction = async () => {
    setSkipTracing(true);
    try {
      const res = await fetch(`/api/leads/${id}/skip-trace`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ _createdBy: lead?.producerEmail || undefined }),
      });
      const json = await res.json();
      const label = 'Skip trace';
      if (json.success) {
        const r = json.result ?? {};
        const found = (r.phones?.length ?? 0) + (r.emails?.length ?? 0);
        setSnackbar({
          open: true,
          msg: found > 0
            ? `${label}: ${r.phones?.length ?? 0} phone(s), ${r.emails?.length ?? 0} email(s) found`
            : `${label} ran — no contact match found`,
          severity: found > 0 ? 'success' : 'error',
        });
        await load(); // refresh phone/email/skipTraced from the server
      } else {
        setSnackbar({ open: true, msg: json.error || `${label} failed`, severity: 'error' });
      }
    } catch {
      setSnackbar({ open: true, msg: 'Skip trace failed — try again', severity: 'error' });
    }
    setSkipTracing(false);
  };

  /** Override the on-file insured name with the skip-trace name (Frank Aug-2026). */
  const runOverrideInsuredName = async () => {
    if (!lead?.skipTraceOwnerName) return;
    setOverridingName(true);
    const parts = String(lead.skipTraceOwnerName).trim().split(/\s+/);
    const first = parts[0] ?? '';
    const last = parts.slice(1).join(' ');
    try {
      const res = await fetch(`/api/leads/${id}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          owner1FirstName: first, owner1LastName: last, skipTraceOwnerName: null,
          _createdBy: lead?.producerEmail || undefined,
          _activityType: 'edit',
          _activityNote: `Insured name overridden with skip-trace name: ${lead.skipTraceOwnerName}`,
        }),
      });
      const json = await res.json();
      if (json.success) {
        setSnackbar({ open: true, msg: `Insured name updated to ${[first, last].filter(Boolean).join(' ')}`, severity: 'success' });
        await load();
      } else {
        setSnackbar({ open: true, msg: json.error || 'Override failed', severity: 'error' });
      }
    } catch {
      setSnackbar({ open: true, msg: 'Override failed — try again', severity: 'error' });
    }
    setOverridingName(false);
  };

  /** Re-check FEMA flood zone for this lead (FREE — no credits). */
  /**
   * Fill in a lead the pipeline never processed: carrier verdicts, flood, grade, pricing.
   * Free — no vendor credits — which is why it can be a button rather than a request.
   */
  const runEnrichAction = async () => {
    setEnriching(true);
    try {
      const res = await fetch(`/api/leads/${id}/enrich`, { method: 'POST' });
      const json = await res.json();
      if (json.success) {
        const moved = json.gradeBefore !== json.gradeAfter;
        setSnackbar({
          open: true,
          msg: json.filled?.length
            ? `Enriched — ${json.filled.join(', ')}${moved ? ` · grade ${json.gradeBefore ?? '—'} → ${json.gradeAfter ?? '—'}` : ''}`
            : 'Enrichment ran — no new data was available',
          severity: 'success',
        });
        await load();
      } else {
        setSnackbar({ open: true, msg: json.error || 'Enrichment failed', severity: 'error' });
      }
    } catch {
      setSnackbar({ open: true, msg: 'Enrichment failed — try again', severity: 'error' });
    } finally {
      setEnriching(false);
    }
  };

  const runFloodCheckAction = async () => {
    setFloodChecking(true);
    try {
      const res = await fetch(`/api/leads/${id}/flood`, { method: 'POST' });
      const json = await res.json();
      if (json.success) {
        const z = json.result ?? {};
        setSnackbar({
          open: true,
          msg: `FEMA flood: ${z.zone ?? '—'}${z.sfha ? ' (SFHA high-risk)' : ''}`,
          severity: 'success',
        });
        await load(); // refresh flood fields + grade from the server
      } else {
        setSnackbar({ open: true, msg: json.error || 'Flood re-check failed', severity: 'error' });
      }
    } catch {
      setSnackbar({ open: true, msg: 'Flood re-check failed — try again', severity: 'error' });
    }
    setFloodChecking(false);
  };

  if (loading) {
    return (
      <Box sx={{ display: 'flex', justifyContent: 'center', alignItems: 'center', minHeight: '60vh' }}>
        <CircularProgress />
      </Box>
    );
  }

  if (!lead) {
    return (
      <Box sx={{ p: 4 }}>
        <Alert severity="error">Lead not found.</Alert>
        <Button startIcon={<ArrowBackIcon />} onClick={goBack} sx={{ mt: 2 }}>Back</Button>
      </Box>
    );
  }

  const address = `${lead.addressStreet}, ${lead.addressCity}, ${lead.addressState} ${lead.addressZip}`;
  // Expiration = effective + 1 year (standard annual policy term, Frank Jul-2026). Derived, not stored.
  const expirationDate = (() => {
    const base = lead.effectiveDate || lead.renewalTargetDate;
    if (!base) return null;
    const d = new Date(base);
    if (isNaN(d.getTime())) return null;
    d.setFullYear(d.getFullYear() + 1);
    return d.toLocaleDateString();
  })();

  const hasRealName = !!(lead.owner1FirstName || lead.owner1LastName);
  const ownerName = [lead.owner1FirstName, lead.owner1LastName].filter(Boolean).join(' ') || '—';
  const coInsuredName = [lead.owner2FirstName, lead.owner2LastName].filter(Boolean).join(' ');

  /**
   * The addresses attributed to each person, preferring the computed split.
   *
   * insuredEmailsOnFile / coInsuredEmailsOnFile come from recipients.service — the same rule
   * the campaign push uses, so the card shows what would actually be mailed. The slot
   * columns are the fallback for a payload that predates them; without it an older cached
   * lead would silently show no addresses at all, which reads as "none on file" rather than
   * "this page is stale".
   *
   * ── An EMPTY list is an answer, not a missing one ─────────────────────────
   * The fallback fires only when the field is absent, never when it comes back empty.
   * Treating [] as missing put Pamela Divino's pamrdivino@aol.com under the insured off the
   * raw email1 column when the rule attributes it to Ralph alone — the card would have
   * claimed an address for a person the campaign will never mail it to.
   */
  const dedupe = (xs: unknown[]) => {
    const seen = new Set<string>();
    const out: string[] = [];
    for (const x of xs) {
      const e = String(x ?? '').trim();
      if (!e || seen.has(e.toLowerCase())) continue;
      seen.add(e.toLowerCase());
      out.push(e);
    }
    return out;
  };
  const insuredAddrs = dedupe(
    Array.isArray(lead.insuredEmailsOnFile) ? lead.insuredEmailsOnFile : [lead.email1, lead.email2],
  );
  const coInsuredAddrs = dedupe(
    Array.isArray(lead.coInsuredEmailsOnFile) ? lead.coInsuredEmailsOnFile : [lead.owner2Email],
  );

  // The only skip trace left is the Tracerfy ENHANCED tier, which keys off the named
  // insured — without a first AND last name on file it cannot run at all (Frank Aug-2026).
  const insuredNameOnFile = !!String(lead.owner1FirstName ?? '').trim() && !!String(lead.owner1LastName ?? '').trim();

  // Skip-trace name mismatch (Frank Aug-2026): the name Tracerfy returned disagrees with
  // the insured on file. Surface both + an override button; never auto-applied.
  const nameMismatch = !!lead.skipTraceOwnerName
    && compareOwnerNames({ first: lead.owner1FirstName, last: lead.owner1LastName }, String(lead.skipTraceOwnerName)).result === 'mismatch';

  // No insured name on file, but the tax roll gave us one. Show it as a SUGGESTION —
  // greyed/italic, no verified tick — because it is the roll's word alone (nothing of
  // ours agreed with it). A producer confirms it on the call, which promotes it to the
  // real insured name. Never render this as a tick: that would be self-referential.
  const rollSuggestedName = !hasRealName && lead.ownerVerifyName ? String(lead.ownerVerifyName) : null;

  // Second insured from the tax roll (Frank Jul-2026): the roll lists both owners —
  // typically husband + wife on title — in one field ("SCHEIDT, WOODROW W & MARY ANN").
  // Surface the spouse as a confirm-on-call suggestion whenever we don't already have a
  // co-insured on file, so both can be reached (2x the outreach chance on one lead).
  const hasCoInsured = !!(lead.owner2FirstName || lead.owner2LastName);
  const rollSecondInsured = (!hasCoInsured && lead.ownerVerifyName)
    ? (parseRollOwners(String(lead.ownerVerifyName)).person2?.display ?? null)
    : null;

  /**
   * What the tax roll says about the CO-insured, when it disagrees with the card.
   *
   * Read from coInsuredVerifyStatus rather than re-derived here: the QC report and the card
   * must not be able to reach different conclusions about the same two names, which is what
   * two parsers of the same string eventually do.
   *
   * 'match' and the no-second-owner cases deliberately render nothing. A line that appears
   * on every card saying the two agree is a line nobody reads by the third card, and it
   * would hide the 131 that do not.
   */
  const coInsuredVerify = (() => {
    const st = lead.coInsuredVerifyStatus as string | null;
    if (!st || !lead.coInsuredVerifyName) return null;
    const cfg: Record<string, { label: string; color: string }> = {
      mismatch: { label: 'Tax roll says', color: '#b3261e' },
      partial: { label: 'Tax roll says', color: '#8a5a00' },
    };
    return cfg[st] ?? null;
  })();

  // Owner-name verification badge (Frank Jul-2026). Shows the outcome of checking the
  // insured name against the municipal tax roll. Deliberately graded, not a plain tick:
  // a surname-only match usually means the roll lists a spouse or co-owner, which is
  // legitimate but worth a producer's glance rather than a silent pass.
  const ownerVerify = (() => {
    const st = lead.ownerVerifyStatus as 'match' | 'partial' | 'mismatch' | 'unknown' | 'not_found' | null;
    if (!st) return null;
    const when = lead.ownerVerifyAt ? String(lead.ownerVerifyAt).slice(0, 10) : '';
    const src = lead.ownerVerifySource ? ` · ${String(lead.ownerVerifySource).replace(/_/g, ' ')}` : '';
    const tip = `${lead.ownerVerifyDetail || ''}${lead.ownerVerifyName ? `\nTax record: ${lead.ownerVerifyName}` : ''}${when ? `\nChecked ${when}${src}` : ''}`;
    const cfg = {
      match: { icon: <VerifiedIcon sx={{ fontSize: 16 }} />, color: '#1565c0', label: 'Verified' },
      partial: { icon: <HelpOutlineIcon sx={{ fontSize: 16 }} />, color: '#8a5a00', label: 'Partial' },
      mismatch: { icon: <CancelIcon sx={{ fontSize: 16 }} />, color: '#b3261e', label: 'Name mismatch' },
      not_found: { icon: <CancelIcon sx={{ fontSize: 16 }} />, color: '#b3261e', label: 'Not on tax roll' },
      unknown: { icon: <HelpOutlineIcon sx={{ fontSize: 16 }} />, color: '#6b7280', label: 'Unverified' },
    }[st];
    if (!cfg) return null;
    return (
      <Tooltip title={<span style={{ whiteSpace: 'pre-line' }}>{tip}</span>}>
        <Box component="span" sx={{ display: 'inline-flex', alignItems: 'center', gap: 0.25, color: cfg.color, cursor: 'help' }}>
          {cfg.icon}
          <Box component="span" sx={{ fontSize: 11, fontWeight: 600 }}>{cfg.label}</Box>
        </Box>
      </Tooltip>
    );
  })();
  const isCondoLead = String(lead.propertyType ?? '').toUpperCase() === 'CONDO' || /condo/i.test(lead.landUse ?? '');
  // Mailing address — the actual signal behind "investor / absentee" (Frank Jul-2026).
  // When it differs from the property, the owner doesn't live there.
  const mailAddress = [lead.mailStreet, lead.mailCity, lead.mailState].filter(Boolean).join(', ');
  const mailDiffers = !!lead.mailStreet && !!lead.addressStreet
    && String(lead.mailStreet).trim().toLowerCase() !== String(lead.addressStreet).trim().toLowerCase();

  // Save gate (Frank Phase 5b): disable Save / Save & Next until required fields pass —
  // a grade override needs a reason; a LOST lead needs reason + stage + revisit election.
  const overrideNeedsReason = !!manualGrade && !gradeOverrideReason.trim();
  const lostNeedsFields = status === 'lost' && (!lostReason || !lostStage || (!revisitFlag && !extra.doNotRevisit));
  const saveBlocked = overrideNeedsReason || lostNeedsFields;
  const saveBlockedMsg = overrideNeedsReason
    ? 'Enter a reason for the manual grade override to save.'
    : lostNeedsFields
      ? 'Complete all Lost fields (reason, stage, revisit election) to save.'
      : '';

  // Flood grade-cap signal (Frank Jun-2026) — mirrors floodZoneGradeCap() in grade.service.
  const floodZ = String(lead.floodZoneType ?? '').trim().toUpperCase();
  const floodSub = String(lead.floodZoneSubtype ?? '').toUpperCase();
  const floodCapNote: { severity: 'error' | 'warning'; text: string } | null =
    (lead.floodSfha === true || /^(A|V)/.test(floodZ))
      ? { severity: 'error', text: `High-risk SFHA flood zone ${lead.floodZoneType || ''} — downgraded to D for Travelers & Plymouth.` }
      : (floodZ === 'X500' || floodZ.includes('0.2') || floodSub.includes('0.2') || floodSub.includes('SHADED'))
        ? { severity: 'warning', text: 'Moderate (shaded Zone X) flood — grade capped at C.' }
        : null;

  const varDiff = lead.boundPremium && lead.expectedPremium
    ? lead.boundPremium - lead.expectedPremium
    : null;

  const travelersNotes: string[] = typeof lead.travelersNotes === 'string'
    ? JSON.parse(lead.travelersNotes || '[]')
    : lead.travelersNotes ?? [];
  const plymouthNotes: string[] = typeof lead.plymouthNotes === 'string'
    ? JSON.parse(lead.plymouthNotes || '[]')
    : lead.plymouthNotes ?? [];

  // Fields still needed to reach Grade A (Quote-Ready), and — for Grade D —
  // the carrier-appetite reasons the lead was knocked out for.
  const missingFields = getMissingFields(lead);
  const gradeInfo = GRADE_INFO[(lead.grade ?? '') as LeadGrade];
  const ineligibleReasons = lead.grade === 'D'
    ? Array.from(new Set([
      ...(lead.travelersEligible === 'ineligible' ? travelersNotes : []),
      ...(lead.plymouthEligible === 'ineligible' ? plymouthNotes : []),
    ]))
    : [];

  // Producer-editable carrier eligibility (Frank Jun-2026). Three states; the token
  // 'review' is shown as "Referral". Changing it from the system value reveals a
  // required reason box that is saved + captured in the activity log.
  const ELIG_OPTS: [string, string][] = [
    ['eligible', 'Eligible'],
    ['review', 'Referral'],
    ['ineligible', 'Non-eligible'],
  ];
  const renderCarrierEligibility = (carrier: 'travelers' | 'plymouth', label: string, notes: string[]) => {
    const valKey = carrier === 'travelers' ? 'travelersEligible' : 'plymouthEligible';
    const reasonKey = carrier === 'travelers' ? 'travelersEligibilityReason' : 'plymouthEligibilityReason';
    const detailKey = carrier === 'travelers' ? 'travelersEligibilityDetail' : 'plymouthEligibilityDetail';
    const cur = extra[valKey] ?? '';
    const changed = cur !== ((lead as any)[valKey] ?? '');
    const needsReason = changed && !(extra[reasonKey] ?? '');
    const showReason = changed || !!(extra[reasonKey] ?? '') || !!(extra[detailKey] ?? '').trim();
    // Territory-driven reasons pre-fill Detail with the ZIP so trends are reportable
    // straight from the keyword search (Frank: "insert zip if FEMA related").
    const pickReason = (v: string) => {
      setEx(reasonKey, v);
      const opt = ELIGIBILITY_REASONS.find((o) => o.value === v);
      if (opt?.autoZip && !(extra[detailKey] ?? '').trim() && lead.addressZip) {
        setEx(detailKey, `ZIP ${lead.addressZip}`);
      }
    };
    return (
      <>
        <Stack direction="row" sx={{ alignItems: 'center', mb: 0.75, flexWrap: 'wrap' }} spacing={1}>
          {eligibilityIcon(cur)}
          <Typography variant="body2" sx={{ fontWeight: 600, minWidth: 92 }}>{label}</Typography>
          <FormControl size="small" sx={{ minWidth: 140 }}>
            <Select value={cur} displayEmpty onChange={(e) => setEx(valKey, e.target.value)}>
              {ELIG_OPTS.map(([v, l]) => <MenuItem key={v} value={v}>{l}</MenuItem>)}
            </Select>
          </FormControl>
        </Stack>
        {notes.length > 0 && (
          <Box sx={{ pl: 3.5, mb: showReason ? 1 : 1.5 }}>
            {notes.map((n, i) => (
              <Typography key={i} variant="caption" color="text.secondary" sx={{ display: 'block' }}>• {n}</Typography>
            ))}
          </Box>
        )}
        {showReason && (
          <Box sx={{ pl: 3.5, mb: 1.5 }}>
            <FormControl size="small" fullWidth error={needsReason} sx={{ mb: 1 }}>
              <InputLabel>Reason for change</InputLabel>
              <Select
                label="Reason for change"
                value={extra[reasonKey] ?? ''}
                onChange={(e) => pickReason(e.target.value)}
              >
                {ELIGIBILITY_REASONS.map((o) => (
                  <MenuItem key={o.value} value={o.value}>{o.label}</MenuItem>
                ))}
              </Select>
              <FormHelperText>{needsReason ? 'Pick a reason — this is what QC reports on' : ' '}</FormHelperText>
            </FormControl>
            <TextField
              label="Detail (optional)" size="small" fullWidth multiline minRows={1}
              value={extra[detailKey] ?? ''} onChange={(e) => setEx(detailKey, e.target.value)}
              placeholder="Nuance for this specific account — e.g. the exact carrier wording"
              helperText="Free text for one-offs. The dropdown above drives trend reporting."
            />
          </Box>
        )}
      </>
    );
  };

  return (
    <Box sx={{ p: { xs: 2, md: 3 }, maxWidth: 1200, mx: 'auto' }}>

      {/* ── Header ─────────────────────────────────────────────────────── */}
      <Breadcrumbs sx={{ mb: 1 }}>
        <Box component="button" type="button" onClick={goBack}
          sx={{ background: 'none', border: 'none', p: 0, font: 'inherit', color: 'inherit', cursor: 'pointer', display: 'flex', alignItems: 'center', gap: 0.5, '&:hover': { textDecoration: 'underline' } }}>
          <ArrowBackIcon fontSize="small" /> Back
        </Box>
        <Typography color="text.primary" variant="body2">{lead.addressStreet}</Typography>
      </Breadcrumbs>

      <Stack direction={{ xs: 'column', sm: 'row' }} sx={{ alignItems: { sm: 'center' }, justifyContent: 'space-between', mb: 3 }} spacing={1}>
        <Stack direction="row" sx={{ alignItems: 'center' }} spacing={1.5}>
          <HomeIcon color="action" />
          <Typography variant="h5" sx={{ fontWeight: 700 }}>{address}</Typography>
        </Stack>
        <Stack direction="row" useFlexGap spacing={1} sx={{ flexWrap: 'wrap' }}>
          <Chip label={`Grade ${lead.grade ?? '?'}`} sx={gradeChipSx(lead.grade)} />
          <Chip label={statusLabel(lead.status)} variant="outlined" />
          {coastChip(lead.coastExposure)}
        </Stack>
      </Stack>

      <Stack spacing={2.5}>

        {/* ══ ROW 1 · ACCOUNT DATA (read-only) ══════════════════════════ */}
        <Section title="Account Data">
          <Grid container spacing={{ xs: 2, md: 2.5 }} sx={{ mt: 0.5, alignItems: 'stretch', '& > .MuiGrid-root': { border: '1px solid', borderColor: 'divider', borderRadius: 2, p: 2, bgcolor: 'background.paper' } }}>

            {/* Insured */}
            <Grid size={{ xs: 12, sm: 6, lg: 4 }}>
              <SubHead>Insured</SubHead>
              <Row
                label="Insured Named"
                value={
                  <Box component="span" sx={{ display: 'inline-flex', alignItems: 'center', gap: 0.5, justifyContent: 'flex-end', flexWrap: 'wrap' }}>
                    {rollSuggestedName ? (
                      <Tooltip title="Pulled from the municipal tax roll — no name was on file. Confirm with the insured on the call, then save it as the insured name.">
                        <Box component="span" sx={{ fontStyle: 'italic', color: '#6b7280', cursor: 'help' }}>
                          {rollSuggestedName}
                          <Box component="span" sx={{ fontStyle: 'normal', fontSize: 10, fontWeight: 600, color: '#8a5a00', ml: 0.75 }}>
                            from tax roll · confirm on call
                          </Box>
                        </Box>
                      </Tooltip>
                    ) : (
                      <>{ownerName}{ownerVerify}</>
                    )}
                  </Box>
                }
              />
              {/* Comparison row — only when we HAD a name to compare against (partial/mismatch/
                  unknown-with-name). Suppressed for roll-suggested names, which already show above. */}
              {hasRealName && lead.ownerVerifyStatus && lead.ownerVerifyStatus !== 'match' && lead.ownerVerifyName && (
                <Row label="Tax Record Shows" value={<Box component="span" sx={{ color: '#8a5a00' }}>{lead.ownerVerifyName}</Box>} />
              )}
              {!!WIPP_BY_ZIP[String(lead.addressZip ?? '').trim()]?.length && (
                <Button
                  size="small" variant="outlined" sx={{ mt: 0.5, mb: 0.5, textTransform: 'none' }}
                  startIcon={verifyingOwner ? <CircularProgress size={13} color="inherit" /> : <VerifiedIcon sx={{ fontSize: 15 }} />}
                  onClick={runOwnerVerifyAction}
                  disabled={verifyingOwner}
                >
                  {verifyingOwner ? 'Checking…' : lead.ownerVerifyStatus ? 'Re-check owner name' : 'Verify owner name'}
                </Button>
              )}
              {lead.reapiDob && (
                <Row label="REAPI DOB" value={dobDisplay(lead.reapiDob)} />
              )}
              {coInsuredName && (
                <Row
                  label="Co-Insured"
                  value={
                    <Box component="span">
                      {coInsuredName}
                      {/*
                        ── The roll's version, on the card rather than on hover ──
                        Frank, item 8: "Co-insured from WIIP shows on the card, not just on
                        hover." The row above only ever appeared when the card named NOBODY,
                        so a card holding the WRONG second person looked identical to one
                        holding the right one — Harish Chandra's card showed Saranya
                        Radhakrishnan with nothing to say the roll reads differently.

                        Only shown when they actually differ. Repeating the same name twice
                        on every agreeing card would train people to stop reading it.
                      */}
                      {coInsuredVerify && (
                        <Box component="span" sx={{ display: 'block', fontSize: 11, mt: 0.25, color: coInsuredVerify.color }}>
                          {coInsuredVerify.label}: <strong>{lead.coInsuredVerifyName}</strong>
                        </Box>
                      )}
                    </Box>
                  }
                />
              )}
              {rollSecondInsured && (
                <Row
                  label="Co-Insured"
                  value={
                    <Tooltip title="Second owner on the municipal tax roll (usually a spouse). No co-insured was on file. Confirm on the call, then save it as the co-insured.">
                      <Box component="span" sx={{ fontStyle: 'italic', color: '#6b7280', cursor: 'help' }}>
                        {rollSecondInsured}
                        <Box component="span" sx={{ fontStyle: 'normal', fontSize: 10, fontWeight: 600, color: '#8a5a00', ml: 0.75 }}>
                          from tax roll · confirm on call
                        </Box>
                      </Box>
                    </Tooltip>
                  }
                />
              )}
              {lead.owner2Dob && (
                <Row label="Co-Insured DOB" value={dobDisplay(lead.owner2Dob)} />
              )}
              {lead.owner2Phone && <Row label="Co-Insured Phone" value={lead.owner2Phone} />}

              {/*
                ── The addresses, with whose they are ────────────────────────────
                Every address the card attributes to each person, each carrying its identity
                verdict. Both halves of that matter.

                The LIST, because the single slot column is not what a campaign sends to:
                C2's cards hold 192 attributed addresses against 134 in email1/email2/
                owner2Email, so showing the slot alone hid a third of what we actually mail.

                The MARK, because 25 of C2's graded addresses are registered to somebody
                else, and until now that could only be seen by opening the skip-trace popup.
                An address with no mark has not been checked — it is not a failure, and most
                of the book is in that state.
              */}
              {!!insuredAddrs.length && (
                <EmailList
                  label={insuredAddrs.length > 1 ? `Insured Emails (${insuredAddrs.length})` : 'Insured Email'}
                  addresses={insuredAddrs}
                  verdicts={verifiedEmails}
                  role="insured"
                />
              )}
              {!!coInsuredAddrs.length && (
                <EmailList
                  label={coInsuredAddrs.length > 1 ? `Co-Insured Emails (${coInsuredAddrs.length})` : 'Co-Insured Email'}
                  addresses={coInsuredAddrs}
                  verdicts={verifiedEmails}
                  role="coInsured"
                />
              )}
              <Row label="Owner Occupied" value={lead.ownerOccupied ? 'Yes' : 'No'} />
              <Row label="Absentee Owner" value={lead.absenteeOwner ? 'Yes' : 'No'} />
              {mailAddress && (
                <Row
                  label="Mailing Address"
                  value={
                    <Box component="span" sx={{ color: mailDiffers ? '#8a5a00' : 'inherit' }}>
                      {mailAddress}
                      {mailDiffers && (
                        <Box component="span" sx={{ display: 'block', fontSize: 11, fontWeight: 400, color: '#8a5a00' }}>
                          ≠ property address — confirm occupancy on the call
                          {/* Evidence, not proof: a trust/LLC often mails to a trustee or
                              attorney while the family lives in the home, and PO boxes,
                              snowbirds and forwarded mail all look the same here. */}
                        </Box>
                      )}
                    </Box>
                  }
                />
              )}
            </Grid>

            {/* Property Details */}
            <Grid size={{ xs: 12, sm: 6, lg: 4 }}>
              <SubHead>Property Details</SubHead>
              <Row label="Property Type" value={lead.propertyType} />
              <Row label="Land Use" value={lead.landUse} />
              <Row label="Year Built" value={lead.yearBuilt} />
              <Row label="Sq Ft" value={lead.squareFeet ? Number(lead.squareFeet).toLocaleString() : undefined} />
              {/*
                Condos are not rated on home characteristics.

                The edit form below already hides these; this read-only panel did not, and
                it is the one people actually look at. A condo card showing "— bd / — ba"
                reads as missing data, and on 17 Sep 2026 a room spent ten minutes asking
                whether a blank bedroom count was what made a condo Grade B. It is not:
                CONDO_EXEMPT_FIELDS in grade.service drops bedrooms, square footage, year
                built and roof year for condos precisely because no carrier rates them.
                Showing a field that cannot affect anything invites exactly that question.
              */}
              {!isCondoLead && (
                <>
                  <Row label="Bedrooms / Bath" value={
                    (lead.bathroomsFull != null || lead.bathroomsHalf != null)
                      ? `${lead.bedrooms ?? '—'} bd / ${lead.bathroomsFull ?? 0} full · ${lead.bathroomsHalf ?? 0} half`
                      : `${lead.bedrooms ?? '—'} bd / ${lead.bathrooms ?? '—'} ba`
                  } />
                  <Row label="Stories" value={lead.stories} />
                  <Row label="Lot Sq Ft" value={lead.lotSquareFeet ? Number(lead.lotSquareFeet).toLocaleString() : undefined} />
                </>
              )}
              {/* SFH quoting assumptions (Frank Aug-2026): when the granular detail is missing,
                  show the standard default so producers quote fast — pool in-ground, basement
                  100% finished, garage 2-car. Actual data (if pulled) wins over the assumption. */}
              <Row label="Pool" value={
                !lead.pool ? 'No'
                  : isCondoLead ? 'Yes'
                  : <>Yes <Box component="span" sx={{ color: '#8a5a00', fontSize: 11 }}>· assume in-ground</Box></>
              } />
              <Row label="Garage" value={
                !lead.garage ? 'No'
                  : lead.garageCount || lead.garageType ? `Yes${lead.garageType ? ` · ${lead.garageType}` : ''}${lead.garageCount ? ` · ${lead.garageCount}-car` : ''}`
                  : isCondoLead ? 'Yes'
                  : <>Yes <Box component="span" sx={{ color: '#8a5a00', fontSize: 11 }}>· assume 2-car</Box></>
              } />
              <Row label="Basement" value={
                !lead.basement ? 'No'
                  : lead.basementFinishedPct ? `Yes · ${lead.basementFinishedPct}% finished`
                  : isCondoLead ? 'Yes'
                  : <>Yes <Box component="span" sx={{ color: '#8a5a00', fontSize: 11 }}>· assume 100% finished</Box></>
              } />
              <Row label="A/C" value={lead.airConditioning ? 'Yes' : 'No'} />
              {isCondoLead && (
                <Typography variant="caption" sx={{ display: 'block', mt: 1, color: '#2e5540' }}>
                  Bedrooms, baths, stories and lot size are hidden — carriers don&apos;t rate
                  condos on them, and they don&apos;t affect this lead&apos;s grade.
                </Typography>
              )}
            </Grid>

            {/* Financials */}
            <Grid size={{ xs: 12, sm: 6, lg: 4 }}>
              <SubHead>Financials</SubHead>
              <Row label="Estimated Value" value={fmtCurrency(lead.estimatedValue)} />
              <Row label="Assessed Value" value={fmtCurrency(lead.assessedValue)} />
              <Row label="Last Sale" value={fmtCurrency(lead.lastSaleAmount)} />
              <Row label="Last Sale Date" value={lead.lastSaleDate} />
              <Row label="Open Mortgage" value={fmtCurrency(lead.openMortgageBalance)} />
              <Row label="Original Mortgage" value={fmtCurrency(lead.originalMortgageAmount)} />
              <Row label="Lender" value={lead.lenderName} />
              <Row label="Mortgage Type" value={lead.mortgageType} />
              <Row label="Est. Equity" value={fmtCurrency(lead.estimatedEquity)} />
            </Grid>

            {/* Carrier Eligibility */}
            <Grid size={{ xs: 12, sm: 6, lg: 4 }}>
              <SubHead>Carrier Eligibility</SubHead>
              {renderCarrierEligibility('travelers', 'Travelers', travelersNotes)}
              <Divider sx={{ my: 1 }} />
              {renderCarrierEligibility('plymouth', 'Plymouth Rock', plymouthNotes)}

              {/*
                Shown only on a lead that has never been enriched.

                Such a lead reports a dash for both carriers, which reads as "declined"
                and is really "never asked" — and its grade is provisional, because the
                flood check that could cap it has not run either. The button is offered
                here, next to the dashes that prompt the question, rather than buried in
                an admin screen.
              */}
              {!lead.travelersEligible && !lead.plymouthEligible && (
                <Box sx={{ mt: 1.5, p: 1.25, borderRadius: 1, bgcolor: '#fff3d6', border: '1px solid #f0dcae' }}>
                  <Typography variant="caption" sx={{ color: '#8a5a00', display: 'block', mb: 0.75 }}>
                    This lead has never been enriched — no carrier verdict and no flood check,
                    so the grade is provisional.
                  </Typography>
                  <Button
                    size="small"
                    variant="outlined"
                    startIcon={enriching ? <CircularProgress size={14} color="inherit" /> : <FactCheckIcon />}
                    onClick={runEnrichAction}
                    disabled={enriching}
                  >
                    {enriching ? 'Running…' : 'Run enrichment (free)'}
                  </Button>
                </Box>
              )}
            </Grid>

            {/* Flood & Coastal Risk */}
            <Grid size={{ xs: 12, sm: 6, lg: 4 }}>
              <SubHead>Flood & Coastal Risk</SubHead>
              {/* Coastal exposure */}
              <Stack direction="row" sx={{ alignItems: 'center', mb: 1 }} spacing={1}>
                <WavesIcon color="action" fontSize="small" />
                {coastChip(lead.coastExposure)}
              </Stack>
              <Row label="Distance to Coast" value={lead.coastDistanceMiles != null ? `${lead.coastDistanceMiles} mi` : undefined} />
              <Row label="Coordinates" value={lead.latitude && lead.longitude ? `${parseFloat(lead.latitude).toFixed(4)}, ${parseFloat(lead.longitude).toFixed(4)}` : undefined} />
              {lead.coastExposure === 'extreme' || lead.coastExposure === 'high' ? (
                <Alert severity="warning" sx={{ mt: 1, py: 0, fontSize: 12 }}>
                  Wind/hail deductibles likely apply. Confirm at binding.
                </Alert>
              ) : null}

              <Divider sx={{ my: 1.5 }} />

              {/* FEMA flood zone */}
              <Row label="FEMA Flood Zone" value={
                lead.floodZoneType
                  ? `${lead.floodZoneType}${lead.floodSfha ? ' · SFHA' : ''}${lead.floodZoneManual ? ' · manual' : ''}`
                  : (lead.floodCheckedAt ? 'X — minimal' : '— (not checked)')
              } />
              {lead.floodZoneSubtype && <Row label="Zone Detail" value={lead.floodZoneSubtype} />}
              <Box sx={{ mt: 0.75 }}>
                <Link href="https://msc.fema.gov/portal/home" target="_blank" rel="noopener noreferrer" style={{ fontSize: 12, color: '#1565c0', fontWeight: 600 }}>
                  Verify on FEMA map ↗
                </Link>
                {lead.floodCheckedAt && (
                  <Typography variant="caption" color="text.secondary" sx={{ display: 'block', mt: 0.25 }}>
                    Auto-checked via FEMA NFHL {new Date(lead.floodCheckedAt).toLocaleDateString()}
                  </Typography>
                )}
              </Box>
              {floodCapNote && (
                <Alert severity={floodCapNote.severity} sx={{ mt: 1, py: 0, fontSize: 12 }}>{floodCapNote.text}</Alert>
              )}
              <Button
                size="small"
                variant="outlined"
                startIcon={floodChecking ? <CircularProgress size={14} color="inherit" /> : <WavesIcon />}
                onClick={runFloodCheckAction}
                disabled={floodChecking || lead.floodZoneManual === true || lead.latitude == null}
                sx={{ mt: 1 }}
              >
                {floodChecking ? 'Checking…' : 'Re-check Flood (FEMA)'}
              </Button>
              {lead.floodZoneManual === true && (
                <Typography variant="caption" color="text.secondary" sx={{ display: 'block', mt: 0.25 }}>
                  Manual override active — clear it to re-check FEMA.
                </Typography>
              )}
            </Grid>

            {/* Pipeline */}
            <Grid size={{ xs: 12, sm: 6, lg: 4 }}>
              <SubHead>Pipeline</SubHead>
              <Row label="Engine" value={lead.engine === 1 ? '1 — New Purchase' : lead.engine === 2 ? '2 — Renewal/Win-Back' : undefined} />
              <Row label="Recording Date" value={lead.recordingDate} />
              <Row label="Renewal Target" value={lead.renewalTargetDate ? new Date(lead.renewalTargetDate).toLocaleDateString() : undefined} />
              <Row label="Effective Date" value={lead.effectiveDate ? new Date(lead.effectiveDate).toLocaleDateString() : undefined} />
              <Row label="Expiration Date" value={expirationDate ? `${expirationDate} (est.)` : undefined} />
            </Grid>

          </Grid>
        </Section>

        {/*
          Call logging (directive Sec. 10.5) — above the worksheet because it is what a
          producer does FIRST and what cannot be reconstructed later. An email event can
          be recovered from the tool's logs weeks afterwards; a call nobody logged never
          happened.
        */}
        <Box sx={{ mb: 3 }}>
          <CallDispositionPanel leadId={String(lead.propertyId ?? lead.id)} />
        </Box>

        {/* What happened after the call — Sec. 10.9 band accuracy, Sec. 10.6 the loss. */}
        <Box sx={{ mb: 3 }}>
          <QuoteOutcomePanel leadId={String(lead.propertyId ?? lead.id)} />
        </Box>

        <Divider textAlign="center"><Typography variant="body1" color="text.secondary" sx={{ fontWeight: 800, textTransform: 'uppercase', letterSpacing: 0.5 }}>PRODUCER WORKSHEET</Typography></Divider>


        {/* ══ ROW 2 · PRODUCER WORKSHEET (editable) ═════════════════════ */}
        {/* <Section title="Producer Worksheet (editable)" sx={{ bgcolor: 'transparent' }}>
        </Section> */}
        <Grid container spacing={{ xs: 2, md: 2.5 }} sx={{ mt: 0.5, alignItems: 'stretch', '& > .MuiGrid-root': { border: '1px solid', borderColor: 'divider', borderRadius: 2, p: 2, bgcolor: 'background.paper' } }}>

          {/* Insured Details (editable) */}
          <Grid size={{ xs: 12, md: 6 }}>
            <SubHead>Insured Details</SubHead>
            {/* Skip trace — Tracerfy ENHANCED tier ONLY (Frank Aug-2026, 15 credits). The
                5-credit standard lookup was removed, so this is the single trace button.
                Grade A/B/C, one run per lead, and it needs the insured first+last name
                because the enhanced endpoint keys off the named insured. */}
            {lead.skipTraced || lead.deepSkipTracedAt ? (
              <Stack direction="row" spacing={1} useFlexGap sx={{ alignItems: 'center', flexWrap: 'wrap', mt: 1, mb: 0.5 }}>
                <Chip size="small" color="success" variant="outlined" icon={<PersonSearchIcon />}
                  label={`Skip traced${lead.deepSkipTracedAt || lead.skipTracedAt ? ` · ${new Date((lead.deepSkipTracedAt || lead.skipTracedAt)!).toLocaleDateString()}` : ''}`} />
                {lead.skipTraceData && (
                  <Button size="small" variant="outlined" startIcon={<PersonSearchIcon />} onClick={() => setSkipDialogOpen(true)}>
                    View Skip Trace
                  </Button>
                )}
                {/* Re-run stays available (Frank Sep-2026) so a producer can check a lead
                    themselves rather than trusting a previous empty result. Confirms first
                    because a hit costs 15 credits; a miss costs nothing. */}
                {['A', 'B', 'C'].includes(String(lead.manualGrade || lead.grade)) && insuredNameOnFile && (
                  <Button
                    size="small" variant="outlined" color="warning"
                    startIcon={skipTracing ? <CircularProgress size={13} color="inherit" /> : <PersonSearchIcon />}
                    disabled={skipTracing}
                    onClick={() => {
                      if (confirm('Run the deep skip trace again for this lead?\n\nIt costs 15 credits only if Tracerfy returns a match — a miss is free.')) {
                        runSkipTraceAction();
                      }
                    }}
                  >
                    {skipTracing ? 'Tracing…' : 'Re-run Deep Skip Trace'}
                  </Button>
                )}
              </Stack>
            ) : (() => {
              /**
               * The button is always here; it refuses rather than disappears.
               *
               * A missing control reads as a missing feature — a producer looking at a
               * card with no deep-trace button cannot tell whether the tool is gone, the
               * lead is ineligible, or something is broken. Shown disabled with the
               * reason underneath, the answer is on screen.
               *
               * Both blocks are real: Tracerfy's endpoint looks the insured up BY NAME, so
               * no name means no lookup at all, and the A/B/C rule is Frank's.
               */
              const blocked = !['A', 'B', 'C'].includes(String(lead.manualGrade || lead.grade))
                ? 'Deep skip trace is available on Grade A, B or C leads. BatchData below works on any grade.'
                : !insuredNameOnFile
                  ? 'Tracerfy looks the insured up by name — add the first and last name to enable this. BatchData below works from the address alone.'
                  : null;
              return (
                <Box sx={{ mt: 1, mb: 0.5 }}>
                  <Button
                    size="small" variant="contained" color="warning"
                    startIcon={skipTracing ? <CircularProgress size={13} color="inherit" /> : <PersonSearchIcon />}
                    onClick={() => runSkipTraceAction()}
                    disabled={skipTracing || !!blocked}
                  >
                    {skipTracing ? 'Deep tracing…' : 'Deep Skip Trace'}
                  </Button>
                  {blocked && (
                    <Typography variant="caption" color="text.secondary" sx={{ display: 'block', mt: 0.25 }}>
                      {blocked}
                    </Typography>
                  )}
                </Box>
              );
            })()}
            {/*
              BatchData — the second opinion, available on EVERY grade.

              Offered unconditionally because the leads that most need it are the ones the
              deep trace button refuses: a lead downgraded to D with "Trace pulled no
              contact info nor DOB" is precisely the one a producer wants to retry, and the
              A/B/C rule locks them out of it. Only an address is required, because
              BatchData resolves the person from the property.
            */}
            {(() => {
              /**
               * Has BatchData already answered for this lead?
               *
               * Two independent signals, because either can be true on its own: the
               * pipeline stamps recoveryBatchDataAt, while a card-button run only leaves
               * its fingerprint on the stored payload.
               */
              const ranBefore = !!lead.recoveryBatchDataAt
                || lead.skipTraceData?.provider === 'batchdata'
                || (Array.isArray(lead.skipTraceData?.priorPersons)
                    && lead.skipTraceData.priorPersons.some((x: any) => x?._foundBy === 'batchdata'));
              const noAddress = !lead.addressStreet || !lead.addressZip;
              return (
              <Box sx={{ mt: 1, mb: 0.5 }}>
                <Button
                  size="small" variant="outlined"
                  startIcon={batchTracing ? <CircularProgress size={13} color="inherit" /> : <ContactPhoneIcon />}
                  onClick={() => {
                    // A repeat costs money and usually returns what it returned last
                    // time. Asking first is the same courtesy the deep trace extends.
                    if (ranBefore && !confirm(
                      'BatchData has already run on this lead.\n\n'
                      + 'Running it again costs another lookup and will usually return the same result. '
                      + 'Anything it does find is added to what is already held, never replacing it.\n\nRun it again?',
                    )) return;
                    runBatchDataAction();
                  }}
                  disabled={batchTracing || noAddress}
                >
                  {batchTracing
                    ? 'Checking BatchData…'
                    : ranBefore ? 'Re-run BatchData' : 'Try BatchData (2nd source)'}
                </Button>
                <Typography variant="caption" color="text.secondary" sx={{ display: 'block', mt: 0.25 }}>
                  {noAddress
                    ? 'BatchData looks a person up from the property — this lead has no street and ZIP on file.'
                    : <>Phones and emails only — BatchData returns no date of birth.
                        {lead.manualGrade && ' A manual grade is never lifted by this.'}</>}
                </Typography>
              </Box>
              );
            })()}

            {/* Insured-name mismatch (Frank Aug-2026): skip trace found a different name.
                Show both and let the producer override the on-file name. */}
            {nameMismatch && (
              <Box sx={{ mt: 1, mb: 1, p: 1.25, border: '1px solid #f2a3a3', borderRadius: 1.5, bgcolor: '#fff7f7' }}>
                <Typography variant="caption" sx={{ fontWeight: 700, color: '#b3261e', display: 'block' }}>
                  Name mismatch — skip trace differs from the insured on file
                </Typography>
                <Typography variant="caption" sx={{ display: 'block', color: 'text.secondary' }}>
                  On file: <b>{[lead.owner1FirstName, lead.owner1LastName].filter(Boolean).join(' ') || '—'}</b>
                  {'  ·  '}Skip trace: <b>{lead.skipTraceOwnerName}</b>
                </Typography>
                <Button size="small" variant="outlined" color="error" sx={{ mt: 0.75 }}
                  disabled={overridingName}
                  onClick={runOverrideInsuredName}>
                  {overridingName ? 'Updating…' : 'Override insured name with skip-trace name'}
                </Button>
              </Box>
            )}
            <Stack direction={{ xs: 'column', sm: 'row' }} spacing={1} sx={{ mt: 1, mb: 1 }}>
              <TextField label="Co-Insured First" size="small" fullWidth value={extra.owner2FirstName ?? ''} onChange={(e) => setEx('owner2FirstName', e.target.value)} slotProps={{ inputLabel: { shrink: true } }} placeholder="spouse / co-borrower" />
              <TextField label="Co-Insured Last" size="small" fullWidth value={extra.owner2LastName ?? ''} onChange={(e) => setEx('owner2LastName', e.target.value)} slotProps={{ inputLabel: { shrink: true } }} />
              <TextField label="Co-Insured Phone" size="small" fullWidth value={extra.owner2Phone ?? ''} onChange={(e) => setEx('owner2Phone', e.target.value)} slotProps={{ inputLabel: { shrink: true } }} placeholder="spouse — skip trace" />
              <TextField label="Co-Insured Email" size="small" fullWidth value={extra.owner2Email ?? ''} onChange={(e) => setEx('owner2Email', e.target.value)} slotProps={{ inputLabel: { shrink: true } }} />
            </Stack>
            <Box sx={{ mb: 1.7 }}>
              <FeatureSelect label="Married / Single" value={extra.maritalStatus ?? ''} onChange={(v) => setEx('maritalStatus', v)}
                options={[['married', 'Married (M)'], ['single', 'Single (S)']]} />
            </Box>
            {/*
              * Addresses the trace found and attributed to nobody.
              *
              * Directly under the email fields, because that is the gap it fills: this card
              * can read "no address belongs to the insured" while the insured's own address
              * sits in the trace results a few lines away, unattributed and therefore unused.
              *
              * It renders nothing at all on a lead with no unclaimed addresses, which is most
              * of them. Approving writes the address into the insured's slot and reloads the
              * card, so the email fields above show it immediately.
              */}
            <UnclaimedAddressPanel leadId={String(lead.id)} onChanged={() => void load()} />
            {/* A card can carry several of the insured's addresses, and outreach goes to all
                of them until one answers. From that moment the household has a single
                contact — shown here because a producer picking up the card needs to know
                which address is live before they email a different one. */}
            {lead.primaryContactEmail && (
              <Box sx={{ mb: 1.7, p: 1.25, borderRadius: 1, border: '1px solid', borderColor: 'success.light', bgcolor: 'success.50' }}>
                <Typography variant="caption" sx={{ display: 'block', fontWeight: 600 }}>
                  Replied from {lead.primaryContactEmail}
                  {lead.primaryContactRole ? ` (${lead.primaryContactRole})` : ''}
                  {lead.primaryContactAt ? ` · ${new Date(lead.primaryContactAt).toLocaleDateString()}` : ''}
                </Typography>
                <Typography variant="caption" color="text.secondary">
                  Outreach to this household&apos;s other addresses was stopped, and future campaigns go to this address only.
                </Typography>
              </Box>
            )}
            <Stack direction={{ xs: 'column', sm: 'row' }} spacing={1} sx={{ mb: 1.7 }}>
              <TextField label="Phone" size="small" fullWidth value={extra.phone1 ?? ''} onChange={(e) => setEx('phone1', e.target.value)} slotProps={{ inputLabel: { shrink: true } }} placeholder="skip-trace / call" />
              <TextField label="Email" size="small" fullWidth value={extra.email1 ?? ''} onChange={(e) => setEx('email1', e.target.value)} slotProps={{ inputLabel: { shrink: true } }} />
            </Stack>
            <Typography variant="caption" color="text.secondary" sx={{ display: 'block', mb: isAdmin ? 1 : 1.7 }}>
              DOB (skip-trace estimate) shows read-only under Account Data → Insured. Phone is a required Travelers portal field and drives the insurance score.
            </Typography>
            {isAdmin && (
              <Box sx={{ mb: 1.7, p: 1.25, borderRadius: 1, border: '1px dashed', borderColor: 'divider', bgcolor: 'action.hover' }}>
                <Typography variant="caption" color="text.secondary" sx={{ display: 'block', mb: 1, fontWeight: 600 }}>
                  Admin override — correct a wrong skip-trace DOB (year drives the estimate)
                </Typography>
                <Stack direction={{ xs: 'column', sm: 'row' }} spacing={1}>
                  <TextField label="Insured DOB (REAPI)" type="date" size="small" fullWidth value={extra.reapiDob ?? ''}
                    onChange={(e) => setEx('reapiDob', e.target.value)} slotProps={{ inputLabel: { shrink: true } }} />
                  <TextField label="Co-Insured DOB" type="date" size="small" fullWidth value={extra.owner2Dob ?? ''}
                    onChange={(e) => setEx('owner2Dob', e.target.value)} slotProps={{ inputLabel: { shrink: true } }} />
                </Stack>
              </Box>
            )}
            <Box sx={{ mb: 1 }}>
              <FeatureSelect label="Insurance History" value={extra.insuranceHistory ?? ''} onChange={(v) => setEx('insuranceHistory', v)}
                options={[['currently_insured', 'Currently insured (assumed)'], ['lapsed', 'Lapsed'], ['new', 'New / first-time']]} />
            </Box>

            {/*
              ── Verified emails ──────────────────────────────────────────────
              Frank, 25 Sep: "the non verified results need to speak directly back to the
              cards." The cohort ledger counts an account as verified when one of its
              insured addresses is deliverable, so this is the screen where that number is
              made — and it saves on change rather than with the worksheet, because a
              verdict is a fact about an address, not a draft of this form.
            */}
            <Box sx={{ mt: 2, p: 1.5, border: '1px solid #e3e6ea', borderRadius: 1, bgcolor: '#fbfcfd' }}>
              <Typography variant="caption" sx={{ fontWeight: 700, color: '#3d4658', display: 'block', mb: 1 }}>
                VERIFIED EMAILS
              </Typography>

              {(['insured', 'coInsured'] as const).map((role) => {
                const v = verify?.[role];
                const label = role === 'insured' ? 'Insured email' : 'Co-insured email';
                /**
                 * The two a person may set, plus whatever the verifier already said if it is
                 * outside that pair.
                 *
                 * Without the second half, a lead ZeroBounce called "catch-all" would open
                 * this dropdown on a value that is not in the list — MUI renders that as an
                 * empty box, so a checked address would read as unchecked and somebody would
                 * re-check 616 of them.
                 */
                const opts: Array<[string, string]> = VERIFY_CHOICES.map((k) => [k, VERIFY_LABELS[k]]);
                if (v?.status && !VERIFY_CHOICES.includes(v.status)) {
                  opts.push([v.status, `${VERIFY_LABELS[v.status] ?? v.status} — from the verifier`]);
                }
                return (
                  <Box key={role} sx={{ mb: role === 'insured' ? 1.5 : 0 }}>
                    <FeatureSelect
                      label={label}
                      value={v?.status ?? ''}
                      onChange={(val) => setVerification(role, val)}
                      options={opts}
                      unknownLabel="Not checked"
                      showEmpty
                    />
                    <Typography variant="caption" sx={{ display: 'block', mt: 0.4, color: '#6b7280' }}>
                      {verifyBusy === role
                        ? 'saving…'
                        : v?.email
                          ? <>
                              {v.email}
                              {/*
                                Where the verdict came from, always. A producer's mark and a
                                ZeroBounce result are the same two columns and mean different
                                things, and this is the number the cohort reports.
                              */}
                              {v.status && (
                                <Box component="span" sx={{ ml: 0.75, color: v.source?.startsWith('producer') ? '#b26a00' : '#1b6b2f', fontWeight: 600 }}>
                                  · {v.source?.startsWith('producer') ? 'set by hand' : 'ZeroBounce'}
                                  {v.verifiedAt ? ` ${v.verifiedAt}` : ''}
                                </Box>
                              )}
                            </>
                          : <em>no {role === 'insured' ? 'insured' : 'co-insured'} address on this card</em>}
                    </Typography>
                  </Box>
                );
              })}

              {verifyErr && (
                <Typography variant="caption" sx={{ display: 'block', mt: 0.75, color: '#b3261e' }}>
                  {verifyErr}
                </Typography>
              )}
              <Typography variant="caption" sx={{ display: 'block', mt: 1, color: '#8a8f98' }}>
                Counts toward the cohort&apos;s verified column. Only &quot;Verified — deliverable&quot; counts.
                A later ZeroBounce import replaces anything set here.
              </Typography>
            </Box>
          </Grid>

          {/* Grade Review */}
          <Grid size={{ xs: 12, md: 6 }}>
            <SubHead>Grade Review</SubHead>
            <Stack spacing={1.5} sx={{ mt: 0.5 }}>
              <Stack direction="row" spacing={1} sx={{ alignItems: 'center' }}>
                <Chip label={`Grade ${lead.grade ?? '?'}`} sx={gradeChipSx(lead.grade)} size="small" />
                {lead.manualGrade && (
                  <Chip label="Manual override" color="secondary" size="small" variant="outlined" />
                )}
              </Stack>

              {lead.grade && lead.grade !== 'A' && gradeInfo && (
                <Box sx={{ p: 1.25, borderRadius: 1, bgcolor: gradeInfo.backgroundColor, border: '1px solid', borderColor: gradeInfo.borderColor }}>
                  {missingFields.length > 0 ? (
                    <>
                      <Typography variant="caption" sx={{ fontWeight: 700, color: gradeInfo.color }}>
                        Missing for Grade A ({missingFields.length})
                      </Typography>
                      <Box sx={{ display: 'flex', flexWrap: 'wrap', gap: 0.5, mt: 0.5 }}>
                        {missingFields.map((f) => (
                          <Chip key={f} label={f} size="small" variant="outlined"
                            sx={{ color: gradeInfo.color, borderColor: gradeInfo.borderColor, bgcolor: 'transparent' }} />
                        ))}
                      </Box>
                    </>
                  ) : (
                    <Typography variant="caption" color="text.secondary">All quote-ready fields present.</Typography>
                  )}
                  {lead.grade === 'D' && ineligibleReasons.length > 0 && (
                    <Box sx={{ mt: missingFields.length > 0 ? 1 : 0 }}>
                      <Typography variant="caption" sx={{ fontWeight: 700, color: gradeInfo.color, display: 'block' }}>
                        Ineligible — carrier appetite
                      </Typography>
                      <Box component="ul" sx={{ m: 0, pl: 2 }}>
                        {ineligibleReasons.map((r, i) => (
                          <Typography key={i} component="li" variant="caption" color="text.secondary">{r}</Typography>
                        ))}
                      </Box>
                    </Box>
                  )}
                </Box>
              )}

              <FormControl size="small" fullWidth>
                <InputLabel>Manual Grade Override</InputLabel>
                <Select value={manualGrade} label="Manual Grade Override" onChange={(e) => setManualGrade(e.target.value)}>
                  <MenuItem value="">(no override — use computed)</MenuItem>
                  <MenuItem value="A">A — Quote-ready</MenuItem>
                  <MenuItem value="B">B — Needs info (1 field)</MenuItem>
                  <MenuItem value="C">C — Needs info (2+ fields)</MenuItem>
                  <MenuItem value="D">D — Discard / quarantine</MenuItem>
                </Select>
              </FormControl>

              {manualGrade && (
                <TextField
                  label="Reason for Producer Manual Override *"
                  value={gradeOverrideReason}
                  onChange={(e) => setGradeOverrideReason(e.target.value)}
                  size="small" fullWidth multiline rows={2}
                  required
                  error={!gradeOverrideReason}
                  helperText={!gradeOverrideReason ? 'Required — a comment is needed to save a grade override.' : ' '}
                  placeholder="e.g. Roof age confirmed 2019 on call — upgrade B→A"
                />
              )}
              {lead.gradeOverrideAt && (
                <Typography variant="caption" color="text.secondary">
                  Overridden {new Date(lead.gradeOverrideAt).toLocaleString()}
                  {lead.gradeOverrideBy ? ` · ${lead.gradeOverrideBy}` : ''}
                </Typography>
              )}

              {/* Phase 5b: roof, DOB, insurance history, dog, baths, heating relocated.
                    Grade Review now shows only: override + reason + effective date. */}
              <Divider sx={{ my: 0.5 }} />
              <TextField label="Effective Date" type="date" size="small" fullWidth value={extra.effectiveDate ?? ''}
                onChange={(e) => setEx('effectiveDate', e.target.value)} slotProps={{ inputLabel: { shrink: true } }}
                helperText="New purchase ≈ 90 days from sale · Renewal = x-date − 90 days" />
            </Stack>
          </Grid>

          {/* Carrier Pricing (indicative) */}
          <Grid size={{ xs: 12, md: 6 }}>
            <SubHead>Carrier Pricing (indicative)</SubHead>
            <Typography variant="caption" color="text.secondary" sx={{ display: 'block', mb: 1 }}>
              Enter the indicative band you ran in each portal. The cheaper carrier is auto-assigned to this lead.
            </Typography>
            {(() => {
              const t = parseFloat(extra.travelersPremium); const p = parseFloat(extra.plymouthPremium);
              const tOk = !isNaN(t); const pOk = !isNaN(p);
              const winner = tOk && pOk ? (t <= p ? 'travelers' : 'plymouth') : tOk ? 'travelers' : pOk ? 'plymouth' : null;
              const boxSx = (who: string) => ({
                p: 1, borderRadius: 1, border: '1px solid',
                borderColor: winner === who ? 'success.main' : 'divider',
                bgcolor: winner === who ? 'success.50' : 'transparent',
              });
              return (
                <Stack spacing={1.25}>
                  <Box sx={boxSx('travelers')}>
                    <TextField label={`Travelers $${winner === 'travelers' ? '  ✓ assigned' : ''}`} type="number" size="small" fullWidth
                      value={extra.travelersPremium ?? ''} onChange={(e) => setEx('travelersPremium', e.target.value)}
                      slotProps={{ inputLabel: { shrink: true } }} placeholder="e.g. 2800" />
                  </Box>
                  <Box sx={boxSx('plymouth')}>
                    <TextField label={`Plymouth Rock $${winner === 'plymouth' ? '  ✓ assigned' : ''}`} type="number" size="small" fullWidth
                      value={extra.plymouthPremium ?? ''} onChange={(e) => setEx('plymouthPremium', e.target.value)}
                      slotProps={{ inputLabel: { shrink: true } }} placeholder="e.g. 2500" />
                  </Box>
                  {winner && (
                    <Alert severity="success" sx={{ py: 0, fontSize: 12 }}>
                      Carrier Assigned: <strong>{winner === 'travelers' ? 'Travelers' : 'Plymouth Rock'}</strong>
                      {tOk && pOk && t !== p && ` — cheaper by ${fmtCurrency(Math.abs(t - p))}`}
                    </Alert>
                  )}

                  {/* Indicative Band Price — merged into the outreach email. */}
                  {(() => {
                    const s = suggestBand(tOk ? t : undefined, pOk ? p : undefined);
                    const applySuggestion = () => {
                      if (!s) return;
                      setEx('indicativeBandLow', String(s.low));
                      setEx('indicativeBandHigh', String(s.high));
                    };
                    const lowSet = (extra.indicativeBandLow ?? '') !== '';
                    const highSet = (extra.indicativeBandHigh ?? '') !== '';
                    return (
                      <Box sx={{ p: 1, borderRadius: 1, border: '1px dashed', borderColor: 'divider' }}>
                        <Typography variant="caption" color="text.secondary" sx={{ display: 'block', mb: 0.75, fontWeight: 600 }}>
                          Indicative Band Price — merged into the outreach email
                        </Typography>
                        <Stack direction="row" spacing={1}>
                          <TextField label="Band Low $" type="number" size="small" fullWidth
                            value={extra.indicativeBandLow ?? ''} onChange={(e) => setEx('indicativeBandLow', e.target.value)}
                            slotProps={{ inputLabel: { shrink: true } }} placeholder="725" />
                          <TextField label="Band High $" type="number" size="small" fullWidth
                            value={extra.indicativeBandHigh ?? ''} onChange={(e) => setEx('indicativeBandHigh', e.target.value)}
                            slotProps={{ inputLabel: { shrink: true } }} placeholder="900" />
                        </Stack>
                        {s ? (
                          <Stack direction="row" spacing={1} sx={{ alignItems: 'center', mt: 0.75, flexWrap: 'wrap' }}>
                            <Typography variant="caption" color="text.secondary">
                              Suggested from rated pricing: <strong>${s.low.toLocaleString()} – ${s.high.toLocaleString()}</strong>
                            </Typography>
                            <Button size="small" onClick={applySuggestion} sx={{ textTransform: 'none', py: 0 }}>
                              {lowSet || highSet ? 'Reset to suggestion' : 'Use suggestion'}
                            </Button>
                          </Stack>
                        ) : (
                          <Typography variant="caption" color="text.secondary" sx={{ display: 'block', mt: 0.75 }}>
                            Enter Travelers / Plymouth indicative pricing above and a band will be suggested.
                          </Typography>
                        )}
                      </Box>
                    );
                  })()}
                </Stack>
              );
            })()}
            {varDiff != null && (
              <>
                <Divider sx={{ my: 1 }} />
                <Row label="Bound Premium" value={<Typography color={varDiff >= 0 ? 'success.main' : 'error.main'} sx={{ fontWeight: 700 }}>{fmtCurrency(lead.boundPremium)}</Typography>} />
                <Row label="Variance" value={
                  <Tooltip title="Bound minus indicative expected">
                    <Typography variant="body2" color={varDiff >= 0 ? 'success.main' : 'error.main'} sx={{ fontWeight: 700 }}>
                      {varDiff >= 0 ? '+' : ''}{fmtCurrency(varDiff)} ({varDiff >= 0 ? '+' : ''}{Math.round((varDiff / lead.expectedPremium) * 100)}%)
                    </Typography>
                  </Tooltip>
                } />
                {lead.varianceReason && <Row label="Variance Reason" value={lead.varianceReason} />}
              </>
            )}
          </Grid>

          {/* Flood Zone Override */}
          <Grid size={{ xs: 12, md: 6 }}>
            <SubHead>Flood Zone Override</SubHead>
            <FormControlLabel
              control={<Checkbox size="small" checked={!!extra.floodZoneManual} onChange={(e) => setEx('floodZoneManual', e.target.checked)} />}
              label={<Typography variant="body2">Manually override FEMA flood zone</Typography>}
            />
            {extra.floodZoneManual && (
              <FeatureSelect label="Flood Zone" value={extra.floodZoneType ?? ''} onChange={(v) => setEx('floodZoneType', v)}
                options={[['X', 'X — minimal risk'], ['X500', 'X (shaded) — 0.2% / moderate'], ['AE', 'AE — SFHA'], ['A', 'A — SFHA'], ['AH', 'AH — SFHA'], ['AO', 'AO — SFHA'], ['AR', 'AR — SFHA'], ['VE', 'VE — coastal SFHA'], ['V', 'V — coastal SFHA']]} />
            )}
          </Grid>

          {/* Property Details — Home Features & QC */}
          <Grid size={{ xs: 12 }}>
            <SubHead>Property Details — Home Features & QC</SubHead>
            <Typography variant="caption" color="text.secondary" sx={{ display: 'block', mb: 1.5 }}>
              All editable for QC — flag REAPI inaccuracies or record info confirmed on the call.
              Source from a listing (Zillow / Realtor.com). Heat defaults to gas for NJ.
            </Typography>
            <Box sx={{ mb: 1.5, p: 1, borderRadius: 1, bgcolor: extra.propertyTypeMismatch ? '#fff3d6' : 'transparent', border: extra.propertyTypeMismatch ? '1px solid #eac36a' : '1px solid transparent' }}>
              <FormControlLabel
                control={<Checkbox size="small" checked={!!extra.propertyTypeMismatch} onChange={(e) => setEx('propertyTypeMismatch', e.target.checked)} />}
                label={<Typography variant="body2">Property type looks wrong (CRM says <strong>{lead.propertyType ?? '—'}</strong>, but it's actually a different type — verify on Zillow/Redfin)</Typography>}
              />
            </Box>
            {isCondoLead && !showCondoFields ? (
              <Box sx={{ p: 1.5, borderRadius: 1, bgcolor: '#eef7f0', border: '1px solid #cfe6d5' }}>
                <Typography variant="body2" sx={{ color: '#2e5540' }}>
                  <strong>Condo</strong> — carriers don&apos;t rate condos on roof, garage, bath/kitchen, foundation, or other home characteristics, so these fields are hidden to keep entry quick. Contact info, eligibility, and the type-mismatch flag above still apply.
                </Typography>
                <Button size="small" onClick={() => setShowCondoFields(true)} sx={{ mt: 0.5, textTransform: 'none' }}>Show all fields anyway</Button>
              </Box>
            ) : (
              <>
                {isCondoLead && (
                  <Button size="small" onClick={() => setShowCondoFields(false)} sx={{ mb: 1, textTransform: 'none' }}>Hide condo-N/A fields</Button>
                )}
            <Grid container spacing={1.5}>
              <Grid size={{ xs: 12, sm: 6, md: 4 }}>
                <FeatureSelect label="Garage Type" value={extra.garageType ?? ''} onChange={(v) => setEx('garageType', v)}
                  options={[['attached', 'Attached'], ['detached', 'Detached']]} />
              </Grid>
              <Grid size={{ xs: 12, sm: 6, md: 4 }}>
                <TextField label="# Garages" type="number" size="small" fullWidth value={extra.garageCount ?? ''}
                  onChange={(e) => setEx('garageCount', e.target.value)} slotProps={{ inputLabel: { shrink: true } }} />
              </Grid>
              <Grid size={{ xs: 12, sm: 6, md: 4 }}>
                <FeatureSelect label="Foundation" value={extra.foundationType ?? ''} onChange={(v) => setEx('foundationType', v)}
                  options={[['basement', 'Basement'], ['crawl_space', 'Crawl space'], ['slab', 'Slab']]} />
              </Grid>
              {extra.foundationType === 'basement' && (
                <Grid size={{ xs: 12, sm: 6, md: 4 }}>
                  <TextField label="Basement % Complete" size="small" fullWidth value={extra.basementFinishedPct ?? ''}
                    onChange={(e) => setEx('basementFinishedPct', e.target.value)} placeholder="e.g. 75%" slotProps={{ inputLabel: { shrink: true } }} />
                </Grid>
              )}
              <Grid size={{ xs: 12, sm: 6, md: 4 }}>
                <FeatureSelect label="Siding Type" value={extra.sidingType ?? ''} onChange={(v) => setEx('sidingType', v)}
                  options={[['vinyl', 'Vinyl'], ['wood', 'Wood'], ['brick', 'Brick'], ['stucco', 'Stucco'], ['fiber_cement', 'Fiber cement'], ['aluminum', 'Aluminum'], ['stone', 'Stone'], ['other', 'Other']]} />
              </Grid>
              <Grid size={{ xs: 12, sm: 6, md: 4 }}>
                <FeatureSelect label="Primary Heat" value={extra.heatSource ?? 'gas'} onChange={(v) => setEx('heatSource', v)}
                  options={[['gas', 'Gas'], ['oil', 'Oil'], ['electric', 'Electric'], ['propane', 'Propane'], ['heat_pump', 'Heat pump'], ['other', 'Other']]} />
              </Grid>
              <Grid size={{ xs: 12, sm: 6, md: 4 }}>
                <TextField label="Feet from Hydrant" type="number" size="small" fullWidth value={extra.feetFromHydrant ?? ''}
                  onChange={(e) => setEx('feetFromHydrant', e.target.value)} placeholder="e.g. 50" slotProps={{ inputLabel: { shrink: true } }} />
              </Grid>
              <Grid size={{ xs: 12, sm: 6, md: 4 }}>
                <FeatureSelect label="Dog Breed (restricted)" value={extra.dogBreed ?? ''} onChange={(v) => setEx('dogBreed', v)}
                  options={[['none', 'None / not restricted'], ...RESTRICTED_DOG_BREEDS.map((b) => [b, b] as [string, string])]} />
              </Grid>
            </Grid>
            {extra.dogBreed && extra.dogBreed !== 'none' && (
              <Alert severity="warning" sx={{ mt: 1, py: 0, fontSize: 12 }}>
                Restricted breed (Travelers Q#7) — may impact eligibility. Confirm with underwriting.
              </Alert>
            )}

            <Divider textAlign="left" sx={{ my: 1.5 }}>
              <Typography variant="caption" color="text.secondary">PROTECTIVE DEVICES</Typography>
            </Divider>
            <Grid container spacing={1.5}>
              <Grid size={{ xs: 12, sm: 6, md: 4 }}>
                <FeatureSelect label="Burglar Alarm" value={extra.burglarAlarm ?? ''} onChange={(v) => setEx('burglarAlarm', v)}
                  options={[['local', 'Local'], ['smart', 'Smart'], ['central', 'Central'], ['none', 'None']]} />
              </Grid>
              <Grid size={{ xs: 12, sm: 6, md: 4 }}>
                <FeatureSelect label="Fire Alarm" value={extra.fireAlarm ?? ''} onChange={(v) => setEx('fireAlarm', v)}
                  options={[['local', 'Local'], ['central', 'Central'], ['none', 'None']]} />
              </Grid>
              <Grid size={{ xs: 12, sm: 6, md: 4 }}>
                <FeatureSelect label="Smoke Detector" value={extra.smokeDetector ?? ''} onChange={(v) => setEx('smokeDetector', v)}
                  options={[['regular', 'Regular'], ['smart', 'Smart'], ['none', 'None']]} />
              </Grid>
              <Grid size={{ xs: 12, sm: 6, md: 4 }}>
                <FeatureSelect label="Water Sensor" value={extra.waterSensor ?? ''} onChange={(v) => setEx('waterSensor', v)}
                  options={[['regular', 'Regular'], ['smart', 'Smart'], ['central', 'Central'], ['none', 'None']]} />
              </Grid>
              <Grid size={{ xs: 12, sm: 6, md: 4 }}>
                <FeatureSelect label="Auto Water Shutoff" value={extra.autoWaterShutoff ?? ''} onChange={(v) => setEx('autoWaterShutoff', v)}
                  options={[['regular', 'Regular'], ['smart', 'Smart'], ['none', 'None']]} />
              </Grid>
              <Grid size={{ xs: 12, sm: 6, md: 4 }}>
                <FeatureSelect label="Low Temp Sensor" value={extra.lowTempSensor ?? ''} onChange={(v) => setEx('lowTempSensor', v)}
                  options={[['regular', 'Regular'], ['smart', 'Smart'], ['central', 'Central'], ['none', 'None']]} />
              </Grid>
              <Grid size={{ xs: 12, sm: 6, md: 4 }}>
                <FormControlLabel control={<Checkbox size="small" checked={!!extra.sprinklerSystem} onChange={(e) => setEx('sprinklerSystem', e.target.checked)} />} label="Sprinkler System" />
              </Grid>
              <Grid size={{ xs: 12, sm: 6, md: 4 }}>
                <FormControlLabel control={<Checkbox size="small" checked={!!extra.leedCertified} onChange={(e) => setEx('leedCertified', e.target.checked)} />} label="LEED Certified Home" />
              </Grid>
            </Grid>

            <Divider textAlign="left" sx={{ my: 1.5 }}>
              <Typography variant="caption" color="text.secondary">HOME UPGRADES</Typography>
            </Divider>
            <Grid container spacing={1.5}>
              <Grid size={{ xs: 6, sm: 4, md: 3 }}>
                <TextField label="Full Baths" type="number" size="small" fullWidth value={extra.bathroomsFull ?? ''}
                  onChange={(e) => setEx('bathroomsFull', e.target.value)} slotProps={{ inputLabel: { shrink: true } }} />
              </Grid>
              <Grid size={{ xs: 6, sm: 4, md: 3 }}>
                <TextField label="Half Baths" type="number" size="small" fullWidth value={extra.bathroomsHalf ?? ''}
                  onChange={(e) => setEx('bathroomsHalf', e.target.value)} slotProps={{ inputLabel: { shrink: true } }} />
              </Grid>
              <Grid size={{ xs: 12, sm: 4, md: 6 }}>
                <TextField label="Bathroom Grade" size="small" fullWidth value={extra.bathroomGrade ?? ''}
                  onChange={(e) => setEx('bathroomGrade', e.target.value)} placeholder="Builders Grade / Semi-Custom / Custom / Designer" slotProps={{ inputLabel: { shrink: true } }} />
              </Grid>
              <Grid size={{ xs: 6, sm: 4, md: 3 }}>
                <TextField label="# Kitchens" type="number" size="small" fullWidth value={extra.kitchenCount ?? ''}
                  onChange={(e) => setEx('kitchenCount', e.target.value)} slotProps={{ inputLabel: { shrink: true } }} />
              </Grid>
              <Grid size={{ xs: 12, sm: 8, md: 6 }}>
                <TextField label="Kitchen Grade" size="small" fullWidth value={extra.kitchenGrade ?? ''}
                  onChange={(e) => setEx('kitchenGrade', e.target.value)} placeholder="Builders Grade / Semi-Custom / Custom / Designer" slotProps={{ inputLabel: { shrink: true } }} />
              </Grid>
              <Grid size={{ xs: 6, sm: 4, md: 3 }}>
                <TextField label="Heating Renovated (year)" type="number" size="small" fullWidth value={extra.heatingRenovatedYear ?? ''}
                  onChange={(e) => setEx('heatingRenovatedYear', e.target.value)} placeholder="e.g. 2018" slotProps={{ inputLabel: { shrink: true } }} />
              </Grid>
            </Grid>

            <Divider textAlign="left" sx={{ my: 1.5 }}>
              <Typography variant="caption" color="text.secondary">ROOF</Typography>
            </Divider>
            <Stack direction={{ xs: 'column', sm: 'row' }} spacing={1}>
              <TextField label="Roof Year" type="number" value={roofYear} onChange={(e) => setRoofYear(e.target.value)} size="small" fullWidth placeholder="e.g. 2019" slotProps={{ inputLabel: { shrink: true } }} />
              <FormControl size="small" fullWidth>
                <InputLabel>Roof Type</InputLabel>
                <Select value={roofType} label="Roof Type" onChange={(e) => setRoofType(e.target.value)}>
                  <MenuItem value="">Unknown</MenuItem>
                  <MenuItem value="Asphalt Shingle">Asphalt Shingle</MenuItem>
                  <MenuItem value="Architectural Shingle">Architectural Shingle</MenuItem>
                  <MenuItem value="Metal (Standing Seam)">Metal (Standing Seam)</MenuItem>
                  <MenuItem value="Slate">Slate</MenuItem>
                  <MenuItem value="Flat Metal">Flat Metal ⚠</MenuItem>
                  <MenuItem value="Tile">Tile ⚠</MenuItem>
                  <MenuItem value="Wood Shake">Wood Shake ⚠</MenuItem>
                  <MenuItem value="Other">Other</MenuItem>
                </Select>
              </FormControl>
            </Stack>
            <Typography variant="caption" color="text.secondary">
              Confirming roof year clears the B/C roof-age gate (homes &gt;15 yrs). Flat-metal, tile and wood are carrier-ineligible.
            </Typography>
            {['Flat Metal', 'Tile', 'Wood Shake'].includes(roofType) && (
              <Alert severity="warning" sx={{ py: 0, fontSize: 12 }}>
                High-risk roof type — both carriers ineligible (grade D).
              </Alert>
            )}
              </>
            )}
          </Grid>

          {/* Producer Workflow */}
          <Grid size={{ xs: 12 }}>
            <SubHead>Producer Workflow</SubHead>
            <Grid container spacing={2} sx={{ mt: 1.5 }}>
              {/* POS Quote # removed (Frank Phase 5b). Carrier is auto-assigned from the cheaper indicative price. */}
              <Grid size={{ xs: 12, sm: 6 }}>
                {(() => {
                  const t = parseFloat(extra.travelersPremium); const p = parseFloat(extra.plymouthPremium);
                  const tOk = !isNaN(t); const pOk = !isNaN(p);
                  const winner = tOk && pOk ? (t <= p ? 'Travelers' : 'Plymouth Rock') : tOk ? 'Travelers' : pOk ? 'Plymouth Rock' : null;
                  return (
                    <Box sx={{ p: 1, borderRadius: 1, border: '1px solid', borderColor: winner ? 'success.main' : 'divider', bgcolor: winner ? 'success.50' : 'transparent', height: '100%' }}>
                      <Typography variant="caption" color="text.secondary" sx={{ display: 'block' }}>Carrier Assigned (cheaper indicative)</Typography>
                      <Typography variant="body2" sx={{ fontWeight: 700 }}>{winner ?? '— enter Travelers / PM indicative pricing first'}</Typography>
                    </Box>
                  );
                })()}
              </Grid>
              <Grid size={{ xs: 12, sm: 6 }}>
                <FormControl size="small" fullWidth>
                  {/* id/labelId tie the label to the control; MUI's Select is a div, so
                      without them it has no accessible name. */}
                  <InputLabel id="lead-status-label">Lead Status</InputLabel>
                  <Select
                    labelId="lead-status-label"
                    id="lead-status"
                    value={status}
                    label="Lead Status"
                    onChange={(e) => setStatus(e.target.value)}
                  >
                    {SELECTABLE_LEAD_STATUS_OPTIONS.map((o) => (
                      <MenuItem key={o.value} value={o.value}>{o.label}</MenuItem>
                    ))}
                  </Select>
                </FormControl>
              </Grid>

              {/*
                Isolated, beside the status rather than inside it.

                The two answer different questions — how far the lead has got, and whether
                we can reach it — and making them one field meant parking a lead for skip
                tracing wiped the fact that it was rated.
              */}
              <Grid size={{ xs: 12, sm: 6 }}>
                <FormControl size="small" fullWidth>
                  <InputLabel id="lead-isolated-label">Isolated</InputLabel>
                  <Select
                    labelId="lead-isolated-label"
                    id="lead-isolated"
                    value={isolated ? 'yes' : 'no'}
                    label="Isolated"
                    onChange={(e) => setIsolated(e.target.value === 'yes')}
                  >
                    <MenuItem value="no">No — reachable</MenuItem>
                    <MenuItem value="yes">Yes — no insured email</MenuItem>
                  </Select>
                  <Typography
                    variant="caption"
                    color="text.secondary"
                    sx={{ mt: 0.5 }}
                    data-testid="isolated-help"
                  >
                    {isolated
                      ? (lead?.isolatedReason
                        || 'Parked for skip tracing. The status above is unaffected.')
                      : 'Set when a Grade A lead has no insured email to send to.'}
                  </Typography>
                </FormControl>
              </Grid>

              <Grid size={{ xs: 12, sm: 6 }}>
                <TextField
                  label="POS Quote Premium ($)"
                  value={posQuotePremium}
                  onChange={(e) => setPosQuotePremium(e.target.value)}
                  size="small" fullWidth type="number"
                  placeholder="Actual carrier quote amount"
                  slotProps={{ input: { startAdornment: <Typography color="text.secondary" sx={{ mr: 0.5 }}>$</Typography> } }}
                />
              </Grid>


              {/* POS vs indicative variance preview */}
              {posQuotePremium && lead?.expectedPremium && (
                <Grid size={{ xs: 12, sm: 6 }}>
                  <Alert severity={parseFloat(posQuotePremium) > lead.expectedPremium ? 'warning' : 'success'} sx={{ py: 0, fontSize: 12 }}>
                    POS vs indicative: {parseFloat(posQuotePremium) > lead.expectedPremium ? '+' : ''}
                    {fmtCurrency(parseFloat(posQuotePremium) - lead.expectedPremium)}
                    {' '}({Math.round(((parseFloat(posQuotePremium) - lead.expectedPremium) / lead.expectedPremium) * 100)}%)
                  </Alert>
                </Grid>
              )}

              {/* Authorization method + one-click date stamp — visible when status >= qualified */}
              {['qualified', 'quote_sent', 'bound'].includes(status) && (
                <Grid size={12}>
                  <Stack direction={{ xs: 'column', sm: 'row' }} spacing={1.5} sx={{ alignItems: { sm: 'center' } }}>
                    <FormControl size="small" fullWidth>
                      <InputLabel>Authorization Method</InputLabel>
                      <Select value={authorizationMethod} label="Authorization Method" onChange={(e) => setAuthorizationMethod(e.target.value)}>
                        <MenuItem value="">(not recorded)</MenuItem>
                        <MenuItem value="verbal">Verbal — phone call</MenuItem>
                        <MenuItem value="web">Web — online opt-in</MenuItem>
                        <MenuItem value="email">Email — written consent</MenuItem>
                      </Select>
                    </FormControl>

                    {/* Authorization date stamp */}
                    {authorizationDate ? (
                      <Alert severity="success" icon={<GavelIcon fontSize="small" />} sx={{ py: 0.5, fontSize: 12, flex: 1 }}>
                        Authorized on {new Date(authorizationDate).toLocaleString()}
                      </Alert>
                    ) : (
                      <Button
                        variant="contained"
                        color="success"
                        size="small"
                        startIcon={stampingAuth ? <CircularProgress size={14} color="inherit" /> : <GavelIcon />}
                        onClick={stampAuthDate}
                        disabled={stampingAuth}
                        sx={{ flexShrink: 0 }}
                      >
                        {stampingAuth ? 'Stamping…' : 'Mark Authorized (now)'}
                      </Button>
                    )}
                  </Stack>
                </Grid>
              )}

              <Grid size={12}>
                <Divider textAlign="center"><Typography variant="caption" color="text.secondary" sx={{ fontWeight: 800, textTransform: 'uppercase', letterSpacing: 0.5 }}>Bound / Variance Tracking</Typography></Divider>
              </Grid>

              <Grid size={{ xs: 12, sm: 6 }}>
                <TextField
                  label="Bound Premium ($)"
                  value={boundPremium}
                  onChange={(e) => setBoundPremium(e.target.value)}
                  size="small" fullWidth type="number"
                  slotProps={{ input: { startAdornment: <Typography color="text.secondary" sx={{ mr: 0.5 }}>$</Typography> } }}
                />
              </Grid>

              <Grid size={{ xs: 12, sm: 6 }}>
                <FormControl size="small" fullWidth>
                  <InputLabel>Variance Reason</InputLabel>
                  <Select value={varianceReason} label="Variance Reason" onChange={(e) => setVarianceReason(e.target.value)}>
                    <MenuItem value="">(none)</MenuItem>
                    <MenuItem value="roof_age">Roof Age / Condition</MenuItem>
                    <MenuItem value="prior_claims">Prior Claims History</MenuItem>
                    <MenuItem value="construction_type">Construction Type</MenuItem>
                    <MenuItem value="coastal_surcharge">Coastal Surcharge Applied</MenuItem>
                    <MenuItem value="credit_score">Credit Score Impact</MenuItem>
                    <MenuItem value="deductible_change">Deductible Changed</MenuItem>
                    <MenuItem value="coverage_change">Coverage Adjusted</MenuItem>
                    <MenuItem value="underwriting_adjustment">Underwriting Adjustment</MenuItem>
                    <MenuItem value="other">Other</MenuItem>
                  </Select>
                </FormControl>
              </Grid>

              {boundPremium && lead?.expectedPremium && (
                <Grid size={12}>
                  <Alert severity={parseFloat(boundPremium) > lead.expectedPremium ? 'info' : 'success'} sx={{ py: 0, fontSize: 12 }}>
                    Variance: {parseFloat(boundPremium) > lead.expectedPremium ? '+' : ''}
                    {fmtCurrency(parseFloat(boundPremium) - lead.expectedPremium)} vs indicative expected ({fmtCurrency(lead.expectedPremium)})
                  </Alert>
                </Grid>
              )}

              <Grid size={12}>
                <TextField
                  label="Variance Notes"
                  value={varianceNotes}
                  onChange={(e) => setVarianceNotes(e.target.value)}
                  size="small" fullWidth multiline rows={2}
                  placeholder="Explain why bound premium differs from indicative..."
                />
              </Grid>

              {/* Lost reason + stage — only shown when status = lost */}
              {status === 'lost' && (
                <Grid size={12}>
                  <Stack spacing={2}>
                    <Typography variant="caption" color="error" sx={{ fontWeight: 600, textTransform: 'uppercase', letterSpacing: 0.5 }}>
                      Lost — Required Fields
                    </Typography>
                    <FormControl size="small" fullWidth required>
                      <InputLabel>Lost Reason *</InputLabel>
                      <Select value={lostReason} label="Lost Reason *" onChange={(e) => setLostReason(e.target.value)}>
                        <MenuItem value="">(select reason)</MenuItem>
                        <MenuItem value="price">Price — quote too high</MenuItem>
                        <MenuItem value="no_contact">No contact — could not reach</MenuItem>
                        <MenuItem value="not_authorized">Not authorized — declined to quote</MenuItem>
                        <MenuItem value="out_of_appetite">Out of appetite — carrier declined</MenuItem>
                        <MenuItem value="bought_elsewhere">Bought elsewhere — already has coverage</MenuItem>
                        <MenuItem value="not_interested">Not interested</MenuItem>
                        <MenuItem value="other">Other</MenuItem>
                      </Select>
                    </FormControl>
                    <FormControl size="small" fullWidth required>
                      <InputLabel>Lost at Stage *</InputLabel>
                      <Select value={lostStage} label="Lost at Stage *" onChange={(e) => setLostStage(e.target.value)}>
                        <MenuItem value="">(select stage)</MenuItem>
                        <MenuItem value="in_appetite">In-appetite — pre rating-complete</MenuItem>
                        <MenuItem value="rating_complete">Rating-complete — never contacted</MenuItem>
                        <MenuItem value="right_party">Right-party — could not reach decision-maker</MenuItem>
                        <MenuItem value="authorization">Authorization — reached, declined to quote</MenuItem>
                        <MenuItem value="quoted">Quoted — presented but did not bind</MenuItem>
                        <MenuItem value="unknown">Unknown</MenuItem>
                      </Select>
                    </FormControl>

                    {/* Lost-to-competitor price — what we're up against next year */}
                    <TextField
                      label="Competing Carrier"
                      value={competitorCarrier}
                      onChange={(e) => setCompetitorCarrier(e.target.value)}
                      size="small" fullWidth
                      placeholder="e.g. Geico, NJM, Allstate"
                    />
                    <TextField
                      label="Competitor Premium ($)"
                      value={competitorPremium}
                      onChange={(e) => setCompetitorPremium(e.target.value)}
                      size="small" fullWidth type="number"
                      placeholder="Their annual premium, if known"
                      slotProps={{ input: { startAdornment: <Typography color="text.secondary" sx={{ mr: 0.5 }}>$</Typography> } }}
                    />
                    {competitorPremium && lead?.expectedPremium && (
                      <Alert severity="info" sx={{ py: 0, fontSize: 12 }}>
                        We were {parseFloat(competitorPremium) < lead.expectedPremium ? 'higher' : 'lower'} by{' '}
                        {fmtCurrency(Math.abs(parseFloat(competitorPremium) - lead.expectedPremium))} vs our indicative expected
                      </Alert>
                    )}

                    {/* Mandatory close-out election (Frank Phase 5) */}
                    <Divider textAlign="left"><Typography variant="caption" color="error" sx={{ fontWeight: 600 }}>CLOSE-OUT *</Typography></Divider>
                    <FormControl size="small" fullWidth required>
                      <InputLabel>Revisit election *</InputLabel>
                      <Select
                        label="Revisit election *"
                        value={revisitFlag ? 'revisit' : extra.doNotRevisit ? 'no_revisit' : ''}
                        onChange={(e) => {
                          const v = e.target.value;
                          setRevisitFlag(v === 'revisit');
                          setEx('doNotRevisit', v === 'no_revisit');
                        }}
                      >
                        <MenuItem value="">(select — required to close)</MenuItem>
                        <MenuItem value="revisit">Revisit later / next year</MenuItem>
                        <MenuItem value="no_revisit">Do Not Revisit</MenuItem>
                      </Select>
                    </FormControl>
                    {revisitFlag && (
                      <>
                        <TextField label="Revisit Date" type="date" value={revisitDate} onChange={(e) => setRevisitDate(e.target.value)} size="small" fullWidth slotProps={{ inputLabel: { shrink: true } }} />
                        <TextField label="Revisit Note" value={revisitNote} onChange={(e) => setRevisitNote(e.target.value)} size="small" fullWidth multiline rows={2} placeholder="Why revisit? e.g. renewal X-date, price not competitive this year" />
                      </>
                    )}
                  </Stack>
                </Grid>
              )}

              <Grid size={12}><Divider /></Grid>

              <Grid size={12}>
                <TextField
                  label="Producer Note (logged as activity)"
                  value={producerNote}
                  onChange={(e) => setProducerNote(e.target.value)}
                  size="small"
                  fullWidth
                  multiline
                  rows={2}
                  placeholder="Optional note to log with this save..."
                />
              </Grid>
            </Grid>
          </Grid>

        </Grid>

        {/* Action bar (end of Row 2) — Save (persists changes) and Next (open next lead) are independent.
              Save is disabled until a field changes; Next is disabled while there are unsaved changes. */}

        <Section title='' >
          <Box sx={{ mt: 2 }}>
            {saveBlocked && dirty && (
              <Alert severity="warning" sx={{ py: 0, fontSize: 12, mb: 1 }}>{saveBlockedMsg}</Alert>
            )}
            <Stack direction={{ xs: 'column', sm: 'row' }} spacing={1}>
              <Tooltip title={!dirty ? 'No changes to save' : saveBlocked ? saveBlockedMsg : 'Save changes'}>
                <span style={{ flex: 1, display: 'flex' }}>
                  <Button
                    variant="contained"
                    startIcon={saving ? <CircularProgress size={16} color="inherit" /> : <SaveIcon />}
                    onClick={() => save(false)}
                    disabled={saving || !dirty || saveBlocked}
                    sx={{ flex: 1 }}
                  >
                    {saving ? 'Saving…' : 'Save'}
                  </Button>
                </span>
              </Tooltip>
              <Tooltip title={nextLeadId ? 'Open the next priority lead' : 'Back to the leads queue'}>
                <span style={{ flex: 1, display: 'flex' }}>
                  <Button
                    variant="outlined"
                    endIcon={<SkipNextIcon />}
                    onClick={() => router.push(nextLeadId ? keepOrigin(`/leads/${nextLeadId}`) : '/leads')}
                    sx={{ flex: 1 }}
                  >
                    Next
                  </Button>
                </span>
              </Tooltip>
            </Stack>
          </Box>
        </Section>

        {/* ══ ACTIVITY LOG (full width) ═════════════════════════════════ */}
        {lead.activities?.length > 0 && (
          <Section title={`Activity Log (${lead.activities.length})`}>
            <Stack spacing={1} sx={{ mt: 0.5 }}>
              {lead.activities.map((a: any) => {
                const det = Array.isArray(a.metadata?.changes) ? a.metadata.changes : [];
                /**
                 * A mass operation is marked, and carries the run it belonged to.
                 *
                 * Without this a blast trace and a hand-run trace are the same line of
                 * text, so "did something run across all of these?" can only be answered
                 * from the database. The run id is the same one the Blast Skip Traces
                 * report groups by, so this card can be tied back to the whole run.
                 */
                const runId: string | null = a.metadata?.blast?.runId ?? null;
                return (
                  <Box
                    key={a.id}
                    sx={{
                      borderLeft: '3px solid',
                      borderColor: runId ? '#8a5a00' : 'divider',
                      pl: 1.5, py: 0.25,
                    }}
                  >
                    <Stack direction="row" sx={{ justifyContent: 'space-between' }}>
                      {det.length > 0 ? (
                        <Tooltip
                          arrow
                          placement="top-start"
                          title={
                            <Box sx={{ py: 0.25 }}>
                              {det.map((d: any, i: number) => (
                                <Typography key={i} variant="caption" sx={{ display: 'block' }}>
                                  <strong>{d.field}:</strong> {d.from} → {d.to}
                                </Typography>
                              ))}
                            </Box>
                          }
                        >
                          <Typography variant="body2" sx={{ borderBottom: '1px dotted', borderColor: 'text.disabled', cursor: 'help' }}>
                            {a.content}
                          </Typography>
                        </Tooltip>
                      ) : (
                        <Typography variant="body2">
                          {runId && (
                            <Tooltip arrow placement="top-start" title={`Cohort blast run ${runId}`}>
                              <Box
                                component="span"
                                sx={{
                                  display: 'inline-block', mr: 0.75, px: 0.75, borderRadius: 0.5,
                                  bgcolor: '#fff3d6', color: '#8a5a00', fontSize: 10,
                                  fontWeight: 700, letterSpacing: '.06em', verticalAlign: 'middle',
                                  cursor: 'help',
                                }}
                              >
                                BLAST
                              </Box>
                            </Tooltip>
                          )}
                          {a.content}
                        </Typography>
                      )}
                      <Typography variant="caption" color="text.secondary" noWrap sx={{ ml: 2 }}>
                        {new Date(a.createdAt).toLocaleString()}
                        {a.createdBy ? ` · ${a.createdBy}` : ''}
                      </Typography>
                    </Stack>
                  </Box>
                );
              })}
            </Stack>
          </Section>
        )}

      </Stack>

      <SkipTraceDialog
        open={skipDialogOpen}
        onClose={() => setSkipDialogOpen(false)}
        data={lead.skipTraceData}
        tracedAt={lead.skipTracedAt}
        onFile={{
          insured: [lead.owner1FirstName, lead.owner1LastName].filter(Boolean).join(' ') || null,
          insuredDob: lead.owner1Dob ?? lead.reapiDob ?? null,
          coInsured: [lead.owner2FirstName, lead.owner2LastName].filter(Boolean).join(' ') || null,
          coInsuredDob: lead.owner2Dob ?? null,
          coInsuredPhone: lead.owner2Phone ?? null,
          coInsuredEmail: lead.owner2Email ?? null,
          emailsAll: lead.emailsAll ?? null,
          phonesAll: lead.phonesAll ?? null,
          // Computed on the client from the SAME lead object the card renders, using the
          // rules the campaign push uses, so the dialog cannot claim reach the push
          // would not act on.
          insuredEmails: lead.insuredEmailsOnFile ?? null,
          coInsuredEmails: lead.coInsuredEmailsOnFile ?? null,
          otherEmails: lead.otherHouseholdEmails ?? null,
        }}
        verifiedEmails={verifiedEmails}
      />

      <Snackbar
        open={snackbar.open}
        autoHideDuration={3000}
        onClose={() => setSnackbar((s) => ({ ...s, open: false }))}
        anchorOrigin={{ vertical: 'bottom', horizontal: 'center' }}
      >
        <Alert severity={snackbar.severity} onClose={() => setSnackbar((s) => ({ ...s, open: false }))}>
          {snackbar.msg}
        </Alert>
      </Snackbar>
    </Box>
  );
}
