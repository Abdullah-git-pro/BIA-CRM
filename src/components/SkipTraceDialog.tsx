'use client';

import {
  Dialog, DialogTitle, DialogContent, IconButton, Box, Typography, Chip, Stack, Divider, Link,
  Accordion, AccordionSummary, AccordionDetails, Tooltip,
} from '@mui/material';
import CloseIcon from '@mui/icons-material/Close';
import PhoneIcon from '@mui/icons-material/Phone';
import EmailIcon from '@mui/icons-material/Email';
import PersonSearchIcon from '@mui/icons-material/PersonSearch';
import ExpandMoreIcon from '@mui/icons-material/ExpandMore';
import EmailVerdictMark, { verdictKey, verdictForEither, type EmailVerdicts } from './EmailVerdictMark';

interface SkipTraceDialogProps {
  open: boolean;
  onClose: () => void;
  data: any;
  tracedAt?: string;
  /**
   * What the CRM itself holds, independent of any vendor payload.
   *
   * The columns and the payload are written at different moments: a trace patches the
   * co-insured name and DOB onto the lead and, until Sep-2026, the next trace replaced the
   * payload entirely. So a card could show a co-insured the dialog knew nothing about,
   * which reads as data loss even where the value is safe in a column.
   */
  onFile?: {
    insured?: string | null;
    insuredDob?: string | null;
    coInsured?: string | null;
    coInsuredDob?: string | null;
    coInsuredPhone?: string | null;
    coInsuredEmail?: string | null;
    emailsAll?: string[] | null;
    phonesAll?: string[] | null;
    /** Split by whose they are — computed with the same rule the campaign push uses. */
    insuredEmails?: string[] | null;
    coInsuredEmails?: string[] | null;
    otherEmails?: string[] | null;
  };
  /**
   * Identity verdicts keyed by address AND whose we asked about. Absent means never checked
   * — which is most of the book today, and must not be drawn as a failure.
   */
  verifiedEmails?: EmailVerdicts;
}

function fmtPhone(p?: string): string {
  const d = String(p ?? '').replace(/\D/g, '');
  return d.length === 10 ? `(${d.slice(0, 3)}) ${d.slice(3, 6)}-${d.slice(6)}` : (p ?? '');
}

const PHONE_TYPE: Record<string, string> = {
  L: 'Landline', W: 'Wireless', M: 'Mobile', V: 'VOIP', C: 'Wireless',
};

function fmtAddress(a: any): string {
  if (!a || typeof a !== 'object') return '';
  if (a.address) return a.address;
  return [a.streetAddress ?? a.street, a.city, a.state, a.zip].filter(Boolean).join(', ');
}

/** camelCase / snake_case key → "Title Case" label. */
function humanize(k: string): string {
  return k
    .replace(/_/g, ' ')
    .replace(/([a-z])([A-Z])/g, '$1 $2')
    .replace(/^./, (c) => c.toUpperCase())
    .trim();
}

// Person fields rendered explicitly elsewhere (name, formatted contacts/addresses,
// and the header chips) — excluded from the generic "all other fields" grid.
const HANDLED_KEYS = new Set([
  // REAPI shape
  'phones', 'emails', 'address', 'previousAddress',
  'fullName', 'firstName', 'middleName', 'lastName',
  'age', 'gender', 'occupationDescription', 'maritalStatusDescription',
  // Tracerfy shape (snake_case) — rendered explicitly, kept out of the generic grid
  'full_name', 'first_name', 'last_name', 'mailing_address', 'relatives', 'address_history',
  // Internal provenance markers — shown as chips, not as raw rows in the field grid.
  '_foundBy', '_archived', 'batchDataName',
]);

export default function SkipTraceDialog({ open, onClose, data, tracedAt, onFile, verifiedEmails }: SkipTraceDialogProps) {
  /**
   * Current AND archived results, each labelled with the tool that produced it.
   *
   * Two vendors now write this payload. Showing only the newest made a BatchData run look
   * as though it had thrown Tracerfy's work away — the data was archived under
   * priorPersons the whole time, just never rendered — and the footer credited every
   * result to Tracerfy regardless of who found it.
   *
   * A payload with no provider is Tracerfy's raw response; that is how the current set is
   * attributed when nothing says otherwise.
   */
  const currentProvider: string = data?.provider ?? 'tracerfy';
  const vendorLabel = (v: string) => (v === 'batchdata' ? 'BatchData' : 'Tracerfy');
  const current: any[] = Array.isArray(data?.persons) ? data.persons : [];
  const archived: any[] = Array.isArray(data?.priorPersons) ? data.priorPersons : [];
  const persons: any[] = [
    ...current.map((x) => ({ ...x, _foundBy: x?._foundBy ?? currentProvider, _archived: false })),
    ...archived.map((x) => ({ ...x, _foundBy: x?._foundBy ?? 'tracerfy', _archived: true })),
  ];

  return (
    <Dialog open={open} onClose={onClose} maxWidth="md" fullWidth>
      <DialogTitle sx={{ display: 'flex', alignItems: 'center', gap: 1, pr: 6 }}>
        <PersonSearchIcon color="primary" />
        Skip Trace Results
        {data?.resultCount != null && (
          <Chip label={`${data.resultCount} match${data.resultCount === 1 ? '' : 'es'}`} size="small" color="primary" variant="outlined" />
        )}
        <IconButton onClick={onClose} sx={{ position: 'absolute', right: 8, top: 8 }}>
          <CloseIcon />
        </IconButton>
      </DialogTitle>
      <DialogContent dividers>
        {/*
          Held by the CRM, whatever the vendors currently say. Shown first and always:
          these values came from a trace at some point and are what the producer will
          actually work from.
        */}
        {onFile && (onFile.coInsured || onFile.insuredDob || onFile.coInsuredDob
          || (onFile.emailsAll?.length ?? 0) > 0 || (onFile.phonesAll?.length ?? 0) > 0) && (
          <Box sx={{ p: 2, mb: 2, borderRadius: 2, border: '1px solid #cfe0ee', bgcolor: '#f4f9fd' }}>
            <Typography variant="subtitle2" sx={{ fontWeight: 700, color: '#1f5f8b', mb: 0.75 }}>
              On file in the CRM
            </Typography>
            <Stack spacing={0.5}>
              {onFile.insured && (
                <Typography variant="body2">
                  <b>Insured:</b> {onFile.insured}
                  {onFile.insuredDob ? ` · DOB ${onFile.insuredDob}` : ''}
                </Typography>
              )}
              {onFile.coInsured && (
                <Typography variant="body2">
                  <b>Co-insured:</b> {onFile.coInsured}
                  {onFile.coInsuredDob ? ` · DOB ${onFile.coInsuredDob}` : ''}
                  {onFile.coInsuredPhone ? ` · ${fmtPhone(onFile.coInsuredPhone)}` : ''}
                  {onFile.coInsuredEmail ? ` · ${onFile.coInsuredEmail}` : ''}
                </Typography>
              )}
              {/*
                Split by WHOSE they are, not lumped into one list.
                
                A card can hold sixteen addresses of which none belong to the insured — the
                rest are relatives, prior owners and co-residents the trace returned for the
                property. Shown as one total it reads as sixteen ways to reach this
                homeowner, and someone will mail one of them. That is the mistake the
                insured-only rule exists to prevent, so the dialog has to make the
                distinction the rule makes.
              */}
              {/*
                Each address carries its own verdict, because the list is not uniform.

                "Belongs to the insured" is our own attribution from the trace payload; the
                identity check asks the provider whether the address is registered to that
                person, and on C2 it disagreed on 25 of 192. An address a campaign is about
                to use should say which of the two it is, and an unchecked one must look
                different from a failed one — most of the book has never been checked.
              */}
              {!!onFile.insuredEmails?.length && (
                <Typography variant="body2" sx={{ color: '#166534' }}>
                  <b>Insured&apos;s emails ({onFile.insuredEmails.length}):</b>{' '}
                  {onFile.insuredEmails.map((e, i) => (
                    <Box component="span" key={e}>
                      {i ? ', ' : ''}{e}
                      <EmailVerdictMark verdict={verifiedEmails?.[verdictKey(e, 'insured')]} />
                    </Box>
                  ))}
                </Typography>
              )}
              {!!onFile.coInsuredEmails?.length && (
                <Typography variant="body2">
                  <b>Co-insured&apos;s emails ({onFile.coInsuredEmails.length}):</b>{' '}
                  {onFile.coInsuredEmails.map((e, i) => (
                    <Box component="span" key={e}>
                      {i ? ', ' : ''}{e}
                      <EmailVerdictMark verdict={verifiedEmails?.[verdictKey(e, 'coInsured')]} />
                    </Box>
                  ))}
                </Typography>
              )}
              {!!onFile.otherEmails?.length && (
                <Typography variant="body2" sx={{ color: '#8a5a00' }}>
                  <b>Other people at this property ({onFile.otherEmails.length}):</b> {onFile.otherEmails.join(', ')}
                  <Box component="span" sx={{ display: 'block', fontSize: 11 }}>
                    Relatives, prior owners and co-residents the trace returned for the address. Not the
                    insured — never mailed by a campaign.
                  </Box>
                </Typography>
              )}
              {!onFile.insuredEmails?.length && !!onFile.emailsAll?.length && (
                <Typography variant="body2" sx={{ color: '#b3261e', fontWeight: 600 }}>
                  No address belongs to the insured — this lead cannot be emailed.
                </Typography>
              )}
              {!!onFile.phonesAll?.length && (
                <Typography variant="body2"><b>All phones held ({onFile.phonesAll.length}):</b> {onFile.phonesAll.map(fmtPhone).join(', ')}</Typography>
              )}
            </Stack>
            <Typography variant="caption" color="text.secondary" sx={{ display: 'block', mt: 0.75 }}>
              Kept on the lead itself, so it survives whatever a later trace returns.
            </Typography>
          </Box>
        )}
        {persons.length === 0 ? (
          <Typography color="text.secondary">No matched persons returned for this lead.</Typography>
        ) : (
          <Stack spacing={2}>
            {persons.map((p, i) => {
              const name = p.full_name || p.fullName
                || [p.first_name ?? p.firstName, p.middleName, p.last_name ?? p.lastName].filter(Boolean).join(' ')
                || 'Unknown';
              const foundBy: string = p._foundBy;
              const archivedRow: boolean = p._archived === true;
              const phones: any[] = Array.isArray(p.phones) ? p.phones : [];
              const emails: any[] = Array.isArray(p.emails) ? p.emails : [];
              // Every remaining scalar field, so nothing from the API is hidden.
              const otherFields = Object.entries(p).filter(
                ([k, v]) => !HANDLED_KEYS.has(k) && v != null && v !== '' && typeof v !== 'object',
              );
              return (
                <Box
                  key={`${p.personId || i}-${archivedRow ? 'prev' : 'cur'}`}
                  sx={{
                    p: 2, borderRadius: 2,
                    border: '1px solid',
                    borderColor: archivedRow ? '#e2e0d9' : 'divider',
                    bgcolor: archivedRow ? '#faf9f6' : 'transparent',
                  }}
                >
                  {/* Header: name + key demographics */}
                  <Stack direction={{ xs: 'column', sm: 'row' }} sx={{ justifyContent: 'space-between', alignItems: { sm: 'center' } }} spacing={1}>
                    <Stack direction="row" spacing={1} sx={{ alignItems: 'center', flexWrap: 'wrap' }} useFlexGap>
                      <Typography variant="subtitle1" sx={{ fontWeight: 700 }}>{name}</Typography>
                      {/* Which tool found this person — the question the old footer answered wrongly. */}
                      <Chip
                        size="small"
                        label={vendorLabel(foundBy)}
                        sx={{
                          height: 20, fontSize: 11, fontWeight: 700,
                          bgcolor: foundBy === 'batchdata' ? '#eaf1f6' : '#e9f4ec',
                          color: foundBy === 'batchdata' ? '#1f5f8b' : '#2e7d46',
                        }}
                      />
                      {archivedRow && (
                        <Chip size="small" variant="outlined" label="earlier trace — kept"
                          sx={{ height: 20, fontSize: 11, color: '#8a5a00', borderColor: '#f0dcae' }} />
                      )}
                    </Stack>
                    <Stack direction="row" spacing={0.5} useFlexGap sx={{ flexWrap: 'wrap' }}>
                      {p.age && <Chip size="small" variant="outlined" label={`Age ${p.age}`} />}
                      {p.gender && <Chip size="small" variant="outlined" label={p.gender === 'F' ? 'Female' : p.gender === 'M' ? 'Male' : p.gender} />}
                      {p.maritalStatusDescription && <Chip size="small" variant="outlined" label={p.maritalStatusDescription} />}
                      {p.occupationDescription && <Chip size="small" variant="outlined" label={p.occupationDescription} />}
                    </Stack>
                  </Stack>

                  <Divider sx={{ my: 1.5 }} />

                  {/* Phones */}
                  {phones.length > 0 && (
                    <Stack spacing={0.75} sx={{ mb: emails.length ? 1.5 : 0 }}>
                      {phones.map((ph, j) => {
                        const num = ph.number ?? ph.phone;                       // Tracerfy | REAPI
                        const type = ph.type ?? (ph.phoneType ? (PHONE_TYPE[ph.phoneType] ?? ph.phoneType) : undefined);
                        const dnc = ph.dnc ?? ph.phoneFtcDnc;
                        return (
                          <Stack key={j} direction="row" spacing={1} sx={{ alignItems: 'center', flexWrap: 'wrap' }}>
                            <PhoneIcon fontSize="small" color="action" />
                            <Link href={`tel:${String(num ?? '').replace(/\D/g, '')}`} sx={{ fontWeight: 600 }}>
                              {fmtPhone(num)}
                            </Link>
                            {type && <Chip size="small" variant="outlined" label={type} />}
                            {ph.carrier && <Chip size="small" variant="outlined" label={ph.carrier} />}
                            {dnc && <Chip size="small" color="error" label="DNC" title="On the Do-Not-Call registry" />}
                            {ph.tcpa && <Chip size="small" color="warning" label="TCPA" title="TCPA-flagged (litigation risk)" />}
                            {ph.rank && <Typography variant="caption" color="text.secondary">rank {ph.rank}</Typography>}
                            {ph.phoneLastSeen && (
                              <Typography variant="caption" color="text.secondary">last seen {ph.phoneLastSeen}</Typography>
                            )}
                          </Stack>
                        );
                      })}
                    </Stack>
                  )}

                  {/* Emails */}
                  {emails.length > 0 && (
                    <Stack spacing={0.5} sx={{ mb: 1.5 }}>
                      {emails.map((em, j) => {
                        const addr = typeof em === 'string' ? em : em?.email;
                        /*
                         * ── What the vendor says about the address, not just the address ──
                         *
                         * The phones above carry type, carrier, DNC, TCPA and rank. The
                         * emails were rendered as a bare mailto link, so `verified` and
                         * `rank` were read out of the payload by nothing and shown nowhere
                         * — on a screen whose whole job is to say what we know about a
                         * contact.
                         *
                         * It matters more than it looks. "Which of these is really the
                         * insured's" is the open question behind a 6.4% open rate and 148
                         * addresses mailed that failed the surname check, and `verified` is
                         * the only thing the vendor offers towards answering it.
                         *
                         * Coverage is partial and growing — none in August, 9% of emails
                         * traced in September, 25% in October — so absent is genuinely
                         * "not stated" and is left blank rather than shown as a failure.
                         *
                         * ── Why it names the vendor instead of saying "verified" ──────────
                         * It used to read "verified", the same word the paid identity check
                         * uses, and the two disagree: on property 152665880,
                         * carol_flres@hotmail.com carried a green "verified" here while the
                         * identity check said the address belongs to somebody else. One
                         * screen cannot call two opposite findings by the same name. Naming
                         * the source turns a contradiction into what it actually is — two
                         * providers who do not agree — and leaves "verified" meaning the one
                         * check that decides whether we campaign to an address.
                         */
                        const verified = typeof em === 'string' ? undefined : em?.verified;
                        const rank = typeof em === 'string' ? undefined : em?.rank;
                        return (
                          <Stack key={j} direction="row" spacing={1} sx={{ alignItems: 'center', flexWrap: 'wrap' }}>
                            <EmailIcon fontSize="small" color="action" />
                            <Link href={`mailto:${addr}`}>{addr}</Link>
                            <EmailVerdictMark verdict={verdictForEither(verifiedEmails ?? {}, String(addr ?? ''))} />
                            {verified === true && (
                              <Chip size="small" variant="outlined" color="success" label="Tracerfy: confirmed"
                                title="The TRACE vendor says this address is theirs. This is not the paid identity check — where the two disagree, the identity check is the one that decides." />
                            )}
                            {verified === false && (
                              <Chip size="small" variant="outlined" color="warning" label="Tracerfy: unconfirmed"
                                title="Tracerfy returned this address but could not confirm it. Not a finding that it is wrong." />
                            )}
                            {rank != null && (
                              <Typography variant="caption" color="text.secondary">rank {rank}</Typography>
                            )}
                          </Stack>
                        );
                      })}
                    </Stack>
                  )}

                  {/* Addresses */}
                  {fmtAddress(p.address ?? p.mailing_address) && (
                    <Typography variant="caption" color="text.secondary" sx={{ display: 'block' }}>
                      Address: {fmtAddress(p.address ?? p.mailing_address)}
                    </Typography>
                  )}
                  {fmtAddress(p.previousAddress) && (
                    <Typography variant="caption" color="text.secondary" sx={{ display: 'block' }}>
                      Previous: {fmtAddress(p.previousAddress)}
                    </Typography>
                  )}

                  {/* Relatives / household (deep trace) — where recovered contacts often live. */}
                  {Array.isArray(p.relatives) && p.relatives.length > 0 && (
                    <Box sx={{ mt: 1.5, pl: 1.5, borderLeft: '2px solid', borderColor: 'divider' }}>
                      <Typography variant="caption" sx={{ fontWeight: 700, color: 'text.secondary', display: 'block', mb: 0.5 }}>
                        Relatives / household ({p.relatives.length})
                      </Typography>
                      <Stack spacing={0.75}>
                        {p.relatives.map((rel: any, ri: number) => {
                          const rphones: any[] = Array.isArray(rel.phones) ? rel.phones : [];
                          const remails: any[] = Array.isArray(rel.emails) ? rel.emails : [];
                          return (
                            <Box key={ri}>
                              <Typography variant="caption" sx={{ fontWeight: 600 }}>
                                {rel.full_name || [rel.first_name, rel.last_name].filter(Boolean).join(' ') || 'Unknown'}
                                {rel.age ? ` · ${rel.age}` : ''}
                              </Typography>
                              <Stack direction="row" spacing={1} sx={{ flexWrap: 'wrap', alignItems: 'center' }}>
                                {rphones.map((ph, j) => (
                                  <Link key={`p${j}`} href={`tel:${String(ph.number ?? '').replace(/\D/g, '')}`} sx={{ fontSize: 12 }}>
                                    {fmtPhone(ph.number)}
                                  </Link>
                                ))}
                                {/* Same marking as the person's own addresses above — a
                                    relative's verified address is how a co-insured is
                                    reached on many of these cards. */}
                                {remails.map((em, j) => (
                                  <Stack key={`e${j}`} direction="row" spacing={0.5} sx={{ alignItems: 'center' }}>
                                    <Link href={`mailto:${em.email}`} sx={{ fontSize: 12 }}>{em.email}</Link>
                                    {em.verified === true && (
                                      <Chip size="small" variant="outlined" color="success" label="Tracerfy: confirmed"
                                        sx={{ height: 18, fontSize: 10 }}
                                        title="The trace vendor says this address belongs to them. Not the paid identity check." />
                                    )}
                                  </Stack>
                                ))}
                              </Stack>
                            </Box>
                          );
                        })}
                      </Stack>
                    </Box>
                  )}

                  {/* Every remaining field returned for this person */}
                  {otherFields.length > 0 && (
                    <Box sx={{ display: 'grid', gridTemplateColumns: { xs: '1fr', sm: '1fr 1fr' }, columnGap: 2, rowGap: 0.25, mt: 1.5 }}>
                      {otherFields.map(([k, v]) => (
                        <Typography key={k} variant="caption" color="text.secondary">
                          <strong>{humanize(k)}:</strong> {String(v)}
                        </Typography>
                      ))}
                    </Box>
                  )}
                </Box>
              );
            })}
          </Stack>
        )}

        {/* Absolute completeness — the full raw API response, nothing omitted. */}
        {data && (
          <Accordion disableGutters sx={{ mt: 2, bgcolor: 'transparent' }} elevation={0} variant="outlined">
            <AccordionSummary expandIcon={<ExpandMoreIcon />}>
              <Typography variant="caption" sx={{ fontWeight: 700 }}>Full raw API response</Typography>
            </AccordionSummary>
            <AccordionDetails>
              <Box component="pre" sx={{ m: 0, p: 1.5, bgcolor: 'grey.100', borderRadius: 1, fontSize: 11, lineHeight: 1.5, overflow: 'auto', maxHeight: 360, whiteSpace: 'pre-wrap', wordBreak: 'break-word' }}>
                {JSON.stringify(data, null, 2)}
              </Box>
            </AccordionDetails>
          </Accordion>
        )}

        <Typography variant="caption" color="text.secondary" sx={{ display: 'block', mt: 2 }}>
          {(() => {
            const used = [...new Set(persons.map((x) => x._foundBy))].map(vendorLabel);
            const src = used.length ? used.join(' + ') : vendorLabel(currentProvider);
            return `Source: ${src}${tracedAt ? ` · latest ${new Date(tracedAt).toLocaleString()}` : ''}. `
              + (archived.length ? 'Earlier results are kept and shown below the current ones. ' : '')
              + 'Verify DNC status before calling.';
          })()}
        </Typography>
      </DialogContent>
    </Dialog>
  );
}
