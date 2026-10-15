-- Per-contact-point verification: is this number or address the insured's, and is it live?
--
-- Frank's SOP, 14 Oct 2026, Gates 2 and 3: run every contact point through an identity
-- check and a liveness check before it reaches the dialler or a campaign.
--
-- ── Why a table and not columns on Lead ───────────────────────────────────────
-- The other verify columns (ownerVerify*, coInsuredVerify*) describe ONE thing per lead:
-- the name on the deed. This describes a contact POINT, and a card holds several — 2,228
-- attributed phones across 993 Grade A leads, and more as traces re-run. Columns cannot
-- hold a per-number answer, and the question we need to ask is per-number: which of these
-- three is John's, and which of those is still alive.
--
-- Keyed on the value itself rather than a position, because phone1/phone2 are slots that
-- get reshuffled by the next trace. A number keeps its grade when it moves slot, and a
-- number that disappears from the card keeps its history here rather than being lost.
--
-- ── What the fields mean (Trestle Real Contact) ──────────────────────────────
--   nameMatch       the value is associated with the name we sent
--   isValid         the provider believes the line/address exists
--   activityScore   0-100, how recently the line has shown activity
--   contactGrade    A-F, the provider's own summary of the two above
--
-- Measured against 221 calls whose outcome we already knew (13 Oct):
--   nameMatch FALSE appeared on 73 numbers and NONE of them had ever reached the insured,
--   so it is safe to drop on. nameMatch TRUE is weaker — 28 of 148 were answered by
--   somebody else — so it narrows the list rather than confirming a number.
--   activityScore >= 70 blocked 87% of numbers that rang dead while keeping 93% of the
--   calls that connected. isValid was TRUE on all 158 dead numbers and is kept only for
--   the record; nothing should filter on it.
--
-- ── Deliberately not a gate yet ──────────────────────────────────────────────
-- Nothing reads this to block a call or a send on day one. The "keeps 93% of good calls"
-- figure rests on 14 observations, which is not enough to start silently withholding
-- numbers from the people making the calls. It is recorded, shown, and watched first.

CREATE TABLE IF NOT EXISTS "ContactVerification" (
  "id"            TEXT PRIMARY KEY,
  "leadId"        TEXT NOT NULL REFERENCES "Lead"("id") ON DELETE CASCADE,

  -- 'phone' or 'email'. The provider grades both from the same request.
  "channel"       TEXT NOT NULL,
  -- Normalised: digits only for a phone, lower-cased for an email, so the same contact
  -- point is never verified twice under two spellings.
  "value"         TEXT NOT NULL,
  -- Whose contact point we asked about — the answer is only meaningful against a name.
  "personRole"    TEXT NOT NULL,
  "nameSent"      TEXT,

  "nameMatch"     BOOLEAN,
  "isValid"       BOOLEAN,
  "activityScore" INTEGER,
  "contactGrade"  TEXT,
  "lineType"      TEXT,

  "provider"      TEXT NOT NULL DEFAULT 'trestle',
  -- An outage must never be recorded as a verdict; a failed check leaves this null and
  -- stores why, the same discipline the tax-roll lookup uses for unavailable vs not_found.
  "checkedAt"     TIMESTAMPTZ,
  "error"         TEXT,
  "createdAt"     TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- One verdict per contact point per person: re-checking updates rather than appends, so
-- a card cannot accumulate six stale grades for the same number.
CREATE UNIQUE INDEX IF NOT EXISTS "ContactVerification_value_role_key"
  ON "ContactVerification" ("leadId", "value", "personRole");

CREATE INDEX IF NOT EXISTS "ContactVerification_lead_idx"
  ON "ContactVerification" ("leadId");

-- The dialling question: give me this lead's numbers that are attributable and alive.
CREATE INDEX IF NOT EXISTS "ContactVerification_gate_idx"
  ON "ContactVerification" ("channel", "nameMatch", "activityScore");
