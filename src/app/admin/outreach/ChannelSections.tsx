'use client';

import React from 'react';
import {
  Box, Typography, Paper, Table, TableHead, TableRow, TableCell, TableBody,
  Divider, Chip, LinearProgress, Tooltip, Stack,
} from '@mui/material';
/**
 * Type-only, every one. These services read @/lib/neon, and a value import would pull the
 * database client into this bundle — the failure the QC page already hit once.
 */
import type {
  OutreachChannels, ChannelFunnel, CrossChannelRow, DeliverabilityRow,
} from '@/services/outreachChannels.service';
import type { BandAccuracyCut, LossRow } from '@/services/quoteOutcomes.service';
import ColumnHeader from './ColumnHeader';
import { stickyFirstColumn, scrollableTable } from '@/lib/stickyColumn';

/**
 * The per-channel half of the Sec 10.7 dashboard.
 *
 * Split into its own file because the dashboard page was already long and these sections
 * are independent of the Grade A ladder above them — they answer "how is each channel
 * performing", not "is the list ready".
 *
 * ── Everything here is currently empty, and that is the hard part ───────────
 * Nothing has been emailed and one call has been logged, so almost every number is zero or
 * null. A screen full of zeroes and 0% bars reads as failure; a screen that says which
 * channels have not started, and which figures need a setting nobody has entered, reads as
 * what it is. The wording carries that distinction, because the numbers cannot.
 */

const fmtNum = (v: number) => v.toLocaleString();
const fmtMoney = (v: number | null) =>
  v == null ? '—' : `$${v.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

/**
 * A rate, honestly.
 *
 * One attempt against 7,790 assigned leads is 0.013%, which rounds to "0%" — a figure that
 * reads as "nothing happened" next to a count that says something did. Below a tenth of a
 * percent the number is shown as a bound rather than as zero.
 */
const fmtRate = (v: number | null, count?: number) => {
  if (v == null) return '—';
  if (v === 0 && (count ?? 0) > 0) return '<0.1%';
  return `${v}%`;
};

const MUTED = '#6b7280';

function FunnelCard({ f }: { f: ChannelFunnel }) {
  const top = Math.max(1, ...f.rungs.map((r) => r.count));
  // Tagged so a test can scope to one funnel without guessing at the DOM shape.
  return (
    <Paper variant="outlined" sx={{ mb: 2 }} data-testid={`funnel-${f.channel}`}>
      <Box sx={{ px: 2, pt: 2, pb: 1 }}>
        <Stack direction="row" spacing={1} sx={{ alignItems: 'center' }}>
          <Typography variant="subtitle1" sx={{ fontWeight: 700 }}>{f.label} funnel</Typography>
          {!f.started && (
            <Chip size="small" label="Not started" variant="outlined"
              sx={{ height: 20, fontSize: 11, color: MUTED }} />
          )}
        </Stack>
        <Typography variant="caption" color="text.secondary">{f.status}</Typography>
      </Box>
      <Divider />
      {/* Stage, count, share, rate and the stage it is measured against come to about
          420px — just wider than a phone, which is the most awkward kind of too wide: it
          pushed the whole page sideways for the sake of one column. It scrolls here
          instead, with the stage name pinned, because a rate whose denominator has
          scrolled out of view is the exact confusion this funnel is drawn to prevent. */}
      <Box sx={scrollableTable}>
      <Table size="small" sx={stickyFirstColumn}>
        <TableHead>
          <TableRow>
            <ColumnHeader
              label="Stage"
              help="One step of this channel's journey. Each step is a subset of the one above it, so the list narrows as leads drop out."
            />
            <ColumnHeader
              label="Count" align="right"
              help="How many leads or people reached this step. A dash means the channel has not started, which is not the same as zero."
            />
            <ColumnHeader
              label="Share" width="26%"
              help="The bar draws this step against the widest one, so the drop-off is visible without reading the numbers."
            />
            <ColumnHeader
              label="Rate" align="right"
              help="This step as a percentage of the step named beside it. Under a tenth of a percent it is shown as a bound rather than rounded down to nothing."
            />
            <ColumnHeader
              label="of"
              help="Which step the rate is measured against, named so a percentage is never read against the wrong starting point."
            />
          </TableRow>
        </TableHead>
        <TableBody>
          {f.rungs.map((r) => (
            <TableRow key={r.key} hover>
              <TableCell sx={{ fontSize: 13, fontWeight: 600 }}>
                {/*
                  Tagged because this exact text also appears one row down in the "of"
                  column as that row's denominator. Without a way to tell the two apart, a
                  test for "the rung is present" passes on the echo of a rung that was
                  dropped.
                */}
                <span data-testid="rung-label">{r.label}</span>
                {r.note && (
                  <Tooltip title={r.note}>
                    <Typography component="span" sx={{ ml: 0.75, fontSize: 11, color: MUTED, cursor: 'help' }}>ⓘ</Typography>
                  </Tooltip>
                )}
              </TableCell>
              <TableCell align="right" sx={{ fontSize: 13, fontWeight: 700 }}>
                {f.started ? fmtNum(r.count) : '—'}
              </TableCell>
              <TableCell>
                <LinearProgress
                  variant="determinate"
                  value={f.started ? Math.min(100, (r.count / top) * 100) : 0}
                  sx={{
                    height: 8, borderRadius: 1, backgroundColor: '#eef0f3',
                    '& .MuiLinearProgress-bar': { backgroundColor: r.count > 0 ? '#1565c0' : '#c8ccd2' },
                  }}
                />
              </TableCell>
              <TableCell align="right" sx={{ fontSize: 13, fontWeight: 700 }}>
                {fmtRate(r.rate, r.count)}
              </TableCell>
              <TableCell sx={{ fontSize: 12, color: MUTED }}>
                {f.rungs.find((x) => x.key === r.of)?.label ?? '—'}
              </TableCell>
            </TableRow>
          ))}
        </TableBody>
      </Table>
      </Box>
      {f.extras.length > 0 && (
        <Box sx={{ px: 2, py: 1.25, borderTop: '1px solid #e6e8eb' }}>
          <Stack direction="row" spacing={3} sx={{ flexWrap: 'wrap' }} useFlexGap>
            {f.extras.map((e) => (
              <Tooltip key={e.label} title={e.note ?? ''}>
                <Box>
                  <Typography sx={{ fontSize: 11, color: MUTED }}>{e.label}</Typography>
                  <Typography sx={{ fontSize: 15, fontWeight: 700 }}>
                    {e.value == null ? '—' : `${fmtNum(e.value)}${e.suffix ?? ''}`}
                  </Typography>
                </Box>
              </Tooltip>
            ))}
          </Stack>
        </Box>
      )}
    </Paper>
  );
}

export default function ChannelSections({
  channels, bandAccuracy, losses,
}: {
  channels: OutreachChannels;
  bandAccuracy: { by: string; cuts: BandAccuracyCut[] };
  losses: { rows: LossRow[]; totalLosses: number; missingCompetitor: number };
}) {
  // economics is deliberately not destructured: the API still returns which settings are
  // unset, for whoever is setting them, but this screen no longer says so out loud.
  const { funnels, crossChannel, responseTime, deliverability, headline } = channels;

  return (
    <>
      {/* ── The verdict metric ──────────────────────────────────────────── */}
      <Paper variant="outlined" sx={{ p: 2, mb: 2 }}>
        <Typography variant="subtitle1" sx={{ fontWeight: 700 }}>
          Bound premium and commission per 1,000 emails sent
        </Typography>
        <Typography variant="caption" color="text.secondary">
          Sec 10.7 calls this the headline metric for the POC.
        </Typography>
        <Stack direction="row" spacing={5} sx={{ mt: 1.5, flexWrap: 'wrap' }} useFlexGap>
          <Box>
            <Typography sx={{ fontSize: 11, color: MUTED }}>Emails sent</Typography>
            <Typography sx={{ fontSize: 22, fontWeight: 700 }}>{fmtNum(headline.emailsSent)}</Typography>
          </Box>
          <Box>
            <Typography sx={{ fontSize: 11, color: MUTED }}>Bound premium / 1,000</Typography>
            <Typography sx={{ fontSize: 22, fontWeight: 700 }}>{fmtMoney(headline.boundPremiumPer1k)}</Typography>
          </Box>
          <Box>
            <Typography sx={{ fontSize: 11, color: MUTED }}>Commission / 1,000</Typography>
            <Typography sx={{ fontSize: 22, fontWeight: 700 }}>{fmtMoney(headline.commissionPer1k)}</Typography>
          </Box>
        </Stack>
        <Typography variant="caption" sx={{ display: 'block', mt: 1, color: '#8a5a00' }}>
          {headline.note}
        </Typography>
      </Paper>

      {/*
        No banner about unset settings.

        There was one, naming the four AppConfig keys. It was a developer's note on a screen
        Frank reads: it turned a rate nobody had agreed yet into something that looked like a
        fault in the CRM, and the only action it suggested was one he cannot take.
        `economics.missing` is still returned by the API for whoever is setting them.

        The absence still shows, where it belongs — commission and every cost-per figure read
        as a dash rather than zero, because zero would claim this channel costs nothing.
      */}

      {funnels.map((f) => <FunnelCard key={f.channel} f={f} />)}

      {/* ── Cross-channel decision view ─────────────────────────────────── */}
      <Paper variant="outlined" sx={{ mb: 2, overflowX: 'auto' }}>
        <Box sx={{ px: 2, pt: 2, pb: 1 }}>
          <Typography variant="subtitle1" sx={{ fontWeight: 700 }}>Cross-channel — the decision view</Typography>
          <Typography variant="caption" color="text.secondary">
            Sec 10.7: “This is how we decide where the next dollar goes.” Cost is each
            channel’s own direct spend. Skip-trace credits are deliberately not split across
            channels — one trace serves both email and phone, and dividing it needs a rule
            rather than an assumption.
          </Typography>
        </Box>
        <Divider />
        <Table size="small">
          <TableHead>
            <TableRow>
              {([
                ['Channel', 'How the lead was reached: email, phone, or direct mail. This table is how we decide where the next pound of effort goes.'],
                ['Contacts', 'A two-way contact, not an attempt. For email that is a reply or a click; for phone it is actually reaching a person.'],
                ['Quotes', 'Leads given a firm, bindable premium after being reached through this channel.'],
                ['Binds', 'Policies written off the back of this channel. Alongside the cost columns, this is what decides whether the channel pays for itself.'],
                ['Bound premium', 'Total annual premium on those policies.'],
                ['Commission', 'Our share of that premium. Blank until a commission rate has been agreed.'],
                ['Cost', 'What this channel spent directly. Skip-trace credits are deliberately not split across channels, because one trace serves both email and phone and dividing it needs a rule rather than a guess.'],
                ['Cost / contact', 'Channel spend divided by contacts. Blank until the cost figures are set.'],
                ['Cost / quote', 'Channel spend divided by quotes. Blank until the cost figures are set.'],
                ['Cost / bind', 'Channel spend divided by binds — what it costs us to win one policy through this channel.'],
              ] as const).map(([h, help], i) => (
                <ColumnHeader key={h} label={h} help={help} align={i === 0 ? 'left' : 'right'} />
              ))}
            </TableRow>
          </TableHead>
          <TableBody>
            {crossChannel.map((r: CrossChannelRow) => (
              <TableRow key={r.channel} hover>
                <TableCell sx={{ fontSize: 13, fontWeight: 700 }}>{r.channel}</TableCell>
                {[r.contacts, r.quotes, r.binds].map((v, i) => (
                  <TableCell key={i} align="right" sx={{ fontSize: 13, color: v === 0 ? '#9ca3af' : 'inherit' }}>
                    {fmtNum(v)}
                  </TableCell>
                ))}
                {[r.boundPremium, r.commission, r.costTotal, r.costPerContact, r.costPerQuote, r.costPerBind]
                  .map((v, i) => (
                    <TableCell key={i} align="right" sx={{ fontSize: 13, color: v == null ? '#9ca3af' : 'inherit' }}>
                      {fmtMoney(v)}
                    </TableCell>
                  ))}
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </Paper>

      {/* ── Response time ───────────────────────────────────────────────── */}
      <Paper variant="outlined" sx={{ p: 2, mb: 2 }}>
        <Typography variant="subtitle1" sx={{ fontWeight: 700 }}>Response time</Typography>
        <Typography variant="caption" color="text.secondary">
          Engagement to first contact attempt. The clock starts at the reply or click and
          stops at the first call placed <i>after</i> it — a call made earlier is not a
          response to it.
        </Typography>
        <Stack direction="row" spacing={5} sx={{ mt: 1.5, flexWrap: 'wrap' }} useFlexGap>
          {[
            ['Leads measured', responseTime.measured == null ? '—' : fmtNum(responseTime.measured)],
            ['Median', responseTime.medianMinutes == null ? '—' : `${fmtNum(responseTime.medianMinutes)} min`],
            ['Mean', responseTime.meanMinutes == null ? '—' : `${fmtNum(responseTime.meanMinutes)} min`],
            ['Slowest', responseTime.slowestMinutes == null ? '—' : `${fmtNum(responseTime.slowestMinutes)} min`],
            ['Within 15 min', fmtRate(responseTime.withinSlaPct)],
          ].map(([label, value]) => (
            <Box key={label as string}>
              <Typography sx={{ fontSize: 11, color: MUTED }}>{label}</Typography>
              <Typography sx={{ fontSize: 18, fontWeight: 700 }}>{value}</Typography>
            </Box>
          ))}
        </Stack>
        <Typography variant="caption" sx={{ display: 'block', mt: 1, color: MUTED }}>
          {responseTime.note}
        </Typography>
      </Paper>

      {/* ── Deliverability per mailbox ──────────────────────────────────── */}
      <Paper variant="outlined" sx={{ mb: 2, overflowX: 'auto' }}>
        <Box sx={{ px: 2, pt: 2, pb: 1 }}>
          <Typography variant="subtitle1" sx={{ fontWeight: 700 }}>Deliverability, per sending mailbox</Typography>
          <Typography variant="caption" color="text.secondary">
            Last 7 days. Split per mailbox because, as the playbook puts it, an aggregate
            hides which mailbox is burning. Per-domain is not available: the send log records
            the mailbox, not a separate domain.
          </Typography>
        </Box>
        <Divider />
        {deliverability.length === 0 ? (
          <Box sx={{ p: 2 }}>
            <Typography variant="body2" color="text.secondary">
              No mailbox has sent anything in the last 7 days, so there is nothing to split.
            </Typography>
          </Box>
        ) : (
          <Table size="small">
            <TableHead>
              <TableRow>
                {([
                  ['Mailbox', 'The address the email was sent from. Split per mailbox because an average hides which single mailbox is in trouble.'],
                  ['Sent', 'Messages sent from this mailbox in the last 7 days.'],
                  ['Bounces', 'Messages the receiving server rejected.'],
                  ['Bounce %', 'Bounces as a share of what this mailbox sent. A high figure means the list is worse than we think.'],
                  ['Complaints', 'Recipients who marked the message as spam.'],
                  ['Complaint %', 'Complaints as a share of what this mailbox sent. This is the one that can compromise every mailbox at once, not just this one.'],
                  ['Unsubscribes', 'Recipients who opted out.'],
                  ['Unsub %', 'Unsubscribes as a share of what this mailbox sent. A message-market signal rather than a compliance one: rising means the argument is wrong, not that the list is bad.'],
                ] as const).map(([h, help], i) => (
                  <ColumnHeader key={h} label={h} help={help} align={i === 0 ? 'left' : 'right'} />
                ))}
              </TableRow>
            </TableHead>
            <TableBody>
              {deliverability.map((d: DeliverabilityRow) => (
                <TableRow key={d.mailbox} hover>
                  <TableCell sx={{ fontSize: 12, fontFamily: 'monospace' }}>{d.mailbox}</TableCell>
                  <TableCell align="right" sx={{ fontSize: 13, fontWeight: 700 }}>{fmtNum(d.sent)}</TableCell>
                  <TableCell align="right" sx={{ fontSize: 13 }}>{fmtNum(d.bounces)}</TableCell>
                  <TableCell align="right" sx={{ fontSize: 13 }}>{fmtRate(d.bounceRate, d.bounces)}</TableCell>
                  <TableCell align="right" sx={{ fontSize: 13 }}>{fmtNum(d.complaints)}</TableCell>
                  <TableCell align="right" sx={{ fontSize: 13 }}>{fmtRate(d.complaintRate, d.complaints)}</TableCell>
                  <TableCell align="right" sx={{ fontSize: 13 }}>{fmtNum(d.unsubscribes)}</TableCell>
                  <TableCell align="right" sx={{ fontSize: 13 }}>{fmtRate(d.unsubRate, d.unsubscribes)}</TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        )}
      </Paper>

      {/* ── Band accuracy ───────────────────────────────────────────────── */}
      <Paper variant="outlined" sx={{ mb: 2, overflowX: 'auto' }}>
        <Box sx={{ px: 2, pt: 2, pb: 1 }}>
          <Typography variant="subtitle1" sx={{ fontWeight: 700 }}>
            Band accuracy, by {bandAccuracy.by === 'propertyType' ? 'property type' : bandAccuracy.by}
          </Typography>
          <Typography variant="caption" color="text.secondary">
            Share of quotes landing inside the indicative band. Quote-time and bind-time are
            shown side by side and never combined — a band that holds at bind but misses at
            quote means the misses are walking away rather than binding.
          </Typography>
        </Box>
        <Divider />
        {bandAccuracy.cuts.length === 0 ? (
          <Box sx={{ p: 2 }}>
            <Typography variant="body2" color="text.secondary">
              Nothing has been quoted against a published band yet, so there is no accuracy to
              report. This fills in from the first rated quote.
            </Typography>
          </Box>
        ) : (
          <Table size="small">
            <TableHead>
              <TableRow>
                {([
                  ['Cut', 'What the rows are grouped by — carrier, property type, municipality or renewal week.'],
                  ['Quoted', 'How many quotes had a published price band to be compared against.'],
                  ['Inside at quote', 'Of those, how many came in inside the band the homeowner was actually shown.'],
                  ['Accuracy at quote', 'Inside at quote as a percentage. This is the number that says whether the band we advertise is honest.'],
                  ['Bound', 'How many of those went on to be written.'],
                  ['Inside at bind', 'Of the policies written, how many landed inside the band.'],
                  ['Accuracy at bind', 'Inside at bind as a percentage. Shown beside quote-time accuracy and never combined with it: a band that holds at bind but misses at quote means the misses are walking away rather than buying.'],
                  ['Avg variance vs midpoint', 'On average, how far the premium landed from the middle of the band. Positive means we came in above it.'],
                ] as const).map(([h, help], i) => (
                  <ColumnHeader key={h} label={h} help={help} align={i === 0 ? 'left' : 'right'} />
                ))}
              </TableRow>
            </TableHead>
            <TableBody>
              {bandAccuracy.cuts.map((b: BandAccuracyCut) => (
                <TableRow key={b.cut} hover>
                  <TableCell sx={{ fontSize: 13, fontWeight: 700 }}>{b.cut}</TableCell>
                  <TableCell align="right" sx={{ fontSize: 13 }}>{fmtNum(b.quoted)}</TableCell>
                  <TableCell align="right" sx={{ fontSize: 13 }}>{fmtNum(b.insideAtQuote)}</TableCell>
                  <TableCell align="right" sx={{ fontSize: 13, fontWeight: 700 }}>{fmtRate(b.accuracyAtQuote, b.insideAtQuote)}</TableCell>
                  <TableCell align="right" sx={{ fontSize: 13 }}>{fmtNum(b.bound)}</TableCell>
                  <TableCell align="right" sx={{ fontSize: 13 }}>{fmtNum(b.insideAtBind)}</TableCell>
                  <TableCell align="right" sx={{ fontSize: 13, fontWeight: 700 }}>{fmtRate(b.accuracyAtBind, b.insideAtBind)}</TableCell>
                  <TableCell align="right" sx={{ fontSize: 13 }}>
                    {b.avgVarianceVsMidpointPct == null ? '—' : `${b.avgVarianceVsMidpointPct}%`}
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        )}
      </Paper>

      {/* ── Lost analysis ───────────────────────────────────────────────── */}
      <Paper variant="outlined" sx={{ mb: 2, overflowX: 'auto' }}>
        <Box sx={{ px: 2, pt: 2, pb: 1 }}>
          <Typography variant="subtitle1" sx={{ fontWeight: 700 }}>Lost analysis</Typography>
          <Typography variant="caption" color="text.secondary">
            Who beats us, by how much, and where. Losses with no competitor premium are
            counted but excluded from the average gap, and that count is shown — an average
            over the losses that happened to carry a figure would describe a different
            population from the one it is labelled with.
          </Typography>
        </Box>
        <Divider />
        {losses.rows.length === 0 ? (
          <Box sx={{ p: 2 }}>
            <Typography variant="body2" color="text.secondary">
              {losses.totalLosses === 0
                ? 'Nothing has been lost yet.'
                : `${losses.totalLosses} loss(es) recorded, none with a competing carrier named.`}
            </Typography>
          </Box>
        ) : (
          <Table size="small">
            <TableHead>
              <TableRow>
                {([
                  ['Carrier', 'Who took the business instead of us, where the producer recorded it.'],
                  ['Losses', 'How many accounts we lost to them.'],
                  ['With premium', 'Of those, how many told us the competing price. Only these count toward the averages beside them.'],
                  ['Avg gap', 'On average, how much more expensive we were, across only the losses where we know both prices.'],
                  ['Avg gap %', 'The same gap as a percentage of their price, which compares better across different sized homes.'],
                  ['Reasons', 'The reason the producer recorded at the time, with a count for each.'],
                  ['Municipalities', 'Where these losses happened. A rating and appetite signal rather than a sales note: a carrier that beats us in one town is a different problem from one that beats us everywhere.'],
                ] as const).map(([h, help], i) => (
                  <ColumnHeader key={h} label={h} help={help} align={i > 0 && i < 5 ? 'right' : 'left'} />
                ))}
              </TableRow>
            </TableHead>
            <TableBody>
              {losses.rows.map((l: LossRow) => (
                <TableRow key={l.carrier} hover>
                  <TableCell sx={{ fontSize: 13, fontWeight: 700 }}>{l.carrier}</TableCell>
                  <TableCell align="right" sx={{ fontSize: 13 }}>{fmtNum(l.losses)}</TableCell>
                  <TableCell align="right" sx={{ fontSize: 13 }}>{fmtNum(l.withPremium)}</TableCell>
                  <TableCell align="right" sx={{ fontSize: 13 }}>{fmtMoney(l.avgGap)}</TableCell>
                  <TableCell align="right" sx={{ fontSize: 13 }}>
                    {l.avgGapPct == null ? '—' : `${l.avgGapPct}%`}
                  </TableCell>
                  <TableCell sx={{ fontSize: 12, color: MUTED }}>
                    {Object.entries(l.byReason).map(([k, v]) => `${k} (${v})`).join(', ') || '—'}
                  </TableCell>
                  <TableCell sx={{ fontSize: 12, color: MUTED }}>
                    {l.municipalities.slice(0, 6).join(', ') || '—'}
                    {l.municipalities.length > 6 ? ` +${l.municipalities.length - 6}` : ''}
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        )}
        {losses.missingCompetitor > 0 && (
          <Box sx={{ p: 1.5, borderTop: '1px solid #e6e8eb' }}>
            <Typography variant="caption" sx={{ color: '#8a5a00' }}>
              {losses.missingCompetitor} loss(es) carry no competitor premium and are excluded
              from the average gap.
            </Typography>
          </Box>
        )}
      </Paper>
    </>
  );
}
