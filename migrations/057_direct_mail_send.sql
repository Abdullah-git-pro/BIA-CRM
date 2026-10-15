-- Every letter we have asked the vendor to print, and what became of it.
--
-- ── Why this is NOT a row on OutreachEvent ───────────────────────────────────
-- The 15 Oct plan said mail would reuse OutreachEvent, because that table already carries a
-- `channel` column and keeping the three channels together is the right instinct for
-- reporting. Writing it proved the instinct wrong about storage.
--
-- OutreachEvent is 43 columns and almost all of them are email: recipientEmail (NOT NULL),
-- emailStep, emailSubject, emailBody, openedAt, openCount, clickedAt, bouncedAt, bounceType,
-- unsubscribedAt, complainedAt, sendingMailbox, sendingDomain, subjectVariant, ctaVariant,
-- vendorMessageId. A letter has none of those. Reusing the table would mean a row whose one
-- required column is a lie — there is no email address on a letter — and twenty permanently
-- null columns beside it.
--
-- Worse, 68 query sites across the services and API read that table, 12 of them keyed on
-- recipientEmail. Every one would have to be audited to prove it does not now count a letter
-- as an email. That is the mixed-population error this codebase has already been bitten by
-- more than once: 1,829 leads summed into a 994-lead programme, a four-message sequence
-- counted as four people. Reporting can union two tables; it cannot un-mix one.
--
-- ── varsSnapshot ─────────────────────────────────────────────────────────────
-- What the letter actually SAID, frozen at send time. The band is derived from carrier
-- premiums that change — a home rated again next week moves its own band — so without this
-- a letter sent in October could only ever be described by November's numbers. A printed
-- page is a historical fact and has to be readable back as one, not re-derived.
--
-- ── idempotencyKey ───────────────────────────────────────────────────────────
-- Unique, so a double send is impossible in the DATABASE and not merely unlikely in the
-- code. A retried request, a double-clicked button or a re-run batch cannot print a second
-- copy, because the second insert cannot exist. Lob accepts the same value as its own
-- Idempotency-Key header, so the guarantee holds on both sides of the wire.
--
-- ── mode ─────────────────────────────────────────────────────────────────────
-- 'test' or 'live', recorded per letter rather than inferred from a config that may have
-- changed since. "Was this one real?" must be answerable from the row.

CREATE TABLE IF NOT EXISTS "DirectMailSend" (
  "id"              TEXT PRIMARY KEY,
  "leadId"          TEXT NOT NULL REFERENCES "Lead"("id") ON DELETE CASCADE,
  "propertyId"      TEXT,
  "cohort"          TEXT,
  "templateId"      TEXT REFERENCES "DirectMailTemplate"("id") ON DELETE SET NULL,

  -- One click of "send" over one cohort. How a batch is reported on and, if it comes to it,
  -- how its damage is bounded.
  "batchId"         TEXT NOT NULL,
  "mode"            TEXT NOT NULL DEFAULT 'test',

  -- The address as it was actually printed, not as the card reads today.
  "toName"          TEXT,
  "toStreet"        TEXT,
  "toCity"          TEXT,
  "toState"         TEXT,
  "toZip"           TEXT,
  -- True when the letter went somewhere other than the insured property.
  "mailsElsewhere"  BOOLEAN NOT NULL DEFAULT FALSE,

  "varsSnapshot"    JSONB,

  "vendor"          TEXT NOT NULL DEFAULT 'lob',
  "vendorLetterId"  TEXT,
  "vendorPdfUrl"    TEXT,
  "idempotencyKey"  TEXT NOT NULL,

  /**
   * The lifecycle, as the vendor reports it.
   *
   * Each is null until it happens; none is inferred from another. "Mailed" is not
   * "delivered", and a letter that is returned to sender was still printed and still cost
   * money — collapsing these into one status column is how a return becomes invisible.
   */
  "status"          TEXT NOT NULL DEFAULT 'queued',
  "expectedAt"      DATE,
  "sentAt"          TIMESTAMPTZ,
  "mailedAt"        TIMESTAMPTZ,
  "inTransitAt"     TIMESTAMPTZ,
  "deliveredAt"     TIMESTAMPTZ,
  "returnedAt"      TIMESTAMPTZ,

  "error"           TEXT,
  "createdBy"       TEXT,
  "createdAt"       TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  "updatedAt"       TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- The lock that makes a double print impossible rather than unlikely.
CREATE UNIQUE INDEX IF NOT EXISTS "DirectMailSend_idem_key"
  ON "DirectMailSend" ("idempotencyKey");

CREATE INDEX IF NOT EXISTS "DirectMailSend_lead_idx"  ON "DirectMailSend" ("leadId");
CREATE INDEX IF NOT EXISTS "DirectMailSend_batch_idx" ON "DirectMailSend" ("batchId");
-- "Has this household already had a letter this cohort?" — asked before every batch.
CREATE INDEX IF NOT EXISTS "DirectMailSend_cohort_idx" ON "DirectMailSend" ("cohort", "mode");
-- The webhook arrives knowing only the vendor's id.
CREATE INDEX IF NOT EXISTS "DirectMailSend_vendor_idx" ON "DirectMailSend" ("vendorLetterId");
