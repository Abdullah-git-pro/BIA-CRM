'use client';

import React from 'react';
import { Box, Tooltip } from '@mui/material';

/** One address's identity verdict for one person. */
export type EmailVerdict = {
  nameMatch: boolean | null;
  isValid: boolean | null;
  /** 0–100 longevity and activity. Null means never scored, NOT scored low. */
  ageScore?: number | null;
  contactGrade?: string | null;
};

/**
 * Verdicts keyed by address AND whose we asked about — "a@b.com|insured".
 *
 * Keyed by address alone at first, which was wrong: a household address can be attributed to
 * both people and the answers differ. On 50207264 barb9280@aol.com is Lauren Trapasso's and
 * is NOT Alana Ginsburg's, and with one key per address whichever row arrived last decided
 * what both headings showed — so the card either struck through a good address or put a tick
 * against a stranger's.
 */
export type EmailVerdicts = Record<string, EmailVerdict>;
export type PersonRole = 'insured' | 'coInsured';

export const verdictKey = (email: string, role: PersonRole) => `${email.toLowerCase()}|${role}`;

/**
 * The verdict for an address when we do not know whose line we are looking at.
 *
 * Used where a list is a trace provider's own block rather than one of the card's two
 * people. If the roles disagree there is no single answer, and the honest output is no mark
 * rather than whichever one happens to be found first.
 */
export function verdictForEither(map: EmailVerdicts, email: string): EmailVerdict | undefined {
  const ins = map[verdictKey(email, 'insured')];
  const co = map[verdictKey(email, 'coInsured')];
  if (ins && co && ins.nameMatch !== co.nameMatch) return undefined;
  return ins ?? co;
}

/**
 * The mark beside an email address: is this address registered to the person we named?
 *
 * ── Four states ─────────────────────────────────────────────────────────────
 *   registered to this person        green tick
 *   registered to somebody else      struck through, "not theirs"
 *   asked, no attribution, scored    the age score in muted grey
 *   never asked                      nothing at all
 *
 * The last one draws nothing on purpose: a card with no marks should read as "not checked
 * yet", not as a row of silent failures, and most of the book has never been checked.
 *
 * ── Why it lives here and not in the dialog ─────────────────────────────────
 * It was local to SkipTraceDialog, which is why for three days the verdicts existed, were
 * paid for, and could only be seen by opening a popup — the card body showed the same
 * addresses as plain text, so a dead one looked identical to a good one. Two places now
 * render it and they must not drift: the same address cannot carry a tick on the card and
 * nothing in the dialog.
 *
 * ── It is not deliverability ────────────────────────────────────────────────
 * This answers WHOSE the address is. Whether a send will land is ZeroBounce's question and
 * the campaign still gates on that. An address can be live and still belong to a stranger,
 * which is the case this mark exists to catch.
 */
export default function EmailVerdictMark({ verdict }: { verdict?: EmailVerdict }) {
  if (!verdict) return null;

  /**
   * ── Asked, no identity answer, but we know the mailbox's age ──────────────
   * A third state, and the one that was invisible.
   *
   * The mark used to draw only when nameMatch was a yes or a no, so the 45 C2 addresses the
   * provider could not attribute rendered nothing — and with no mark there is no tooltip, so
   * their age scores could not be seen anywhere. Every score below 70 is in that group,
   * including the two at 10: we paid for the field and hid exactly the half worth reading.
   *
   * Shown as the number in muted grey, never as a tick or a warning. It is not a verdict on
   * whose the address is — that is what we failed to learn — and it must not be mistaken for
   * one. For an address that carries no answer at all, it is the only evidence there is.
   */
  if (verdict.nameMatch == null) {
    if (verdict.ageScore == null) return null;
    return (
      <Tooltip
        arrow
        title={`Not attributed — the provider could not say whose this address is. Its age and activity score is ${verdict.ageScore}/100, which speaks to whether the mailbox is live, not to whose it is.`}
      >
        <Box component="span" sx={{
          ml: 0.5, px: 0.5, py: '1px', borderRadius: 0.75, fontSize: 10, fontWeight: 700,
          color: '#5a6675', bgcolor: '#eef1f5', whiteSpace: 'nowrap', cursor: 'help',
        }}>
          {verdict.ageScore}
        </Box>
      </Tooltip>
    );
  }

  /**
   * The age score rides in the tooltip, not in the mark.
   *
   * It is shown because it was paid for and somebody deciding whether to send should be
   * able to see it, but it changes no appearance — there is no measured threshold for email
   * yet, and a second visual state would imply a rule nobody has established. The phone
   * threshold took 221 lookups scored against known call outcomes before it was allowed to
   * withhold anything; this gets the same treatment or none.
   */
  const age = verdict.ageScore == null ? '' : ` · age and activity ${verdict.ageScore}/100`;

  return verdict.nameMatch
    ? (
      <Tooltip arrow title={`Verified — this address is registered to this person${age}`}>
        <Box component="span" sx={{ color: '#166534', fontWeight: 700, ml: 0.4 }}>✓</Box>
      </Tooltip>
    )
    : (
      <Tooltip arrow title={`NOT this person's — the address is registered to somebody else. Do not campaign to it.${age}`}>
        <Box component="span" sx={{
          ml: 0.5, px: 0.6, py: '1px', borderRadius: 0.75, fontSize: 10, fontWeight: 700,
          color: '#b3261e', bgcolor: '#fdeaea', whiteSpace: 'nowrap',
        }}>
          not theirs
        </Box>
      </Tooltip>
    );
}
