-- The letter itself: an HTML template, edited in the CRM, printed by the mail vendor.
--
-- Frank, 15 Oct 2026: direct mail as a channel. Abdullah the same day: "I want to build the
-- editor in the CRM for the direct mail template."
--
-- ── Why HTML and not an uploaded PDF ─────────────────────────────────────────
-- Lob's letters endpoint takes an HTML string plus a merge_variables object, which is the
-- same shape the email copy already uses. A PDF would mean a designer round-trip for every
-- wording change and — worse — a band price baked into the artwork at design time instead of
-- resolved per household at send time. The whole point is that the letter and the email
-- quote the same number because they ask the same function for it.
--
-- ── Why the return address lives on the template ─────────────────────────────
-- Lob requires a `from` on every letter and it is printed on the envelope. It belongs with
-- the creative rather than in config, because a template for one campaign may legitimately
-- reply-to a different line than another, and a return address silently inherited from a
-- global is one nobody checks before it is posted 50 times.
--
-- ── printedVars ──────────────────────────────────────────────────────────────
-- The merge variables this template actually references, recorded at save time. It is how
-- the list builder can answer "would every household on this cohort's list render this
-- letter completely" without re-parsing the HTML on every request — and the save refuses a
-- template whose variables we cannot supply, so a letter can never go to the printer with
-- "somewhere between and " in it.

CREATE TABLE IF NOT EXISTS "DirectMailTemplate" (
  "id"           TEXT PRIMARY KEY,
  "name"         TEXT NOT NULL,
  "html"         TEXT NOT NULL DEFAULT '',

  -- Lob letter options. Defaults match Lob's own: first-class, double-sided, US letter.
  "size"         TEXT NOT NULL DEFAULT 'us_letter',
  "color"        BOOLEAN NOT NULL DEFAULT FALSE,
  "doubleSided"  BOOLEAN NOT NULL DEFAULT TRUE,

  -- Printed on the envelope. Required by the vendor on every letter.
  "fromName"     TEXT,
  "fromStreet"   TEXT,
  "fromCity"     TEXT,
  "fromState"    TEXT,
  "fromZip"      TEXT,

  -- The {{ variables }} found in the HTML when it was last saved.
  "printedVars"  TEXT[] NOT NULL DEFAULT '{}',

  /**
   * Only an approved template may be sent, and approval is a person's act.
   *
   * Frank's own compliance note: have E&O or counsel review the template once before any
   * mail goes out. NJ advertising rules govern the agency itself — the licensed name, the
   * producer license info, no savings claim we cannot substantiate. Recording WHO approved
   * it and WHEN is the difference between a reviewed letter and one somebody assumed was
   * reviewed. Editing the HTML clears it.
   */
  "approvedAt"   TIMESTAMPTZ,
  "approvedBy"   TEXT,

  "createdBy"    TEXT,
  "updatedBy"    TEXT,
  "createdAt"    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  "updatedAt"    TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE UNIQUE INDEX IF NOT EXISTS "DirectMailTemplate_name_key"
  ON "DirectMailTemplate" ("name");
