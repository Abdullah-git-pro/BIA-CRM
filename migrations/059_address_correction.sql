-- What USPS says a questionable address really is.
--
-- 261 addresses across C1–C8 carry a unit squashed into the house number — "121d Muhlen
-- Platz", "502-7 Harding Rd" — and the print vendor refused one outright as undeliverable.
-- 73 of them are Grade A mailing addresses, roughly a fifth of every letter we would post.
--
-- ── Why the answer is stored rather than applied and forgotten ───────────────
-- Because a correction to somebody's address is a change to the record of where a person
-- lives, made on the strength of a pattern match. Three things have to stay answerable
-- afterwards: what it said before, what we asked, and what came back. Overwriting the Lead
-- column alone answers none of them, and the first time a correction turns out wrong there
-- would be no way to find the others like it.
--
-- It also makes the fix reversible. `applied` records whether the Lead row was changed, so
-- a bad batch can be walked back to `original` rather than reconstructed from memory.
--
-- ── Why not simply trust the rule ────────────────────────────────────────────
-- Because the rule is wrong often enough to matter. "85i Winthrop Rd" is not unit I — the
-- same card's mailing address reads "851 Winthrop Road", so the trailing letter is a
-- mistyped 1 and the house number is correct as it stands. USPS is the only authority that
-- settles that, and this is where its answer lives.

CREATE TABLE IF NOT EXISTS "AddressCorrection" (
  "id"          TEXT PRIMARY KEY,
  "leadId"      TEXT NOT NULL REFERENCES "Lead"("id") ON DELETE CASCADE,
  "propertyId"  TEXT,

  -- 'mail' or 'property' — the two address columns disagree, and often only one is wrong.
  "field"       TEXT NOT NULL,
  "original"    TEXT NOT NULL,
  -- The shape the detector recognised: suffix_letter or hyphen_unit.
  "shape"       TEXT,
  -- Every form we asked about, in the order we asked.
  "candidates"  TEXT[] NOT NULL DEFAULT '{}',

  -- The form USPS accepted, if any, and its verdict on it.
  "verified"       TEXT,
  "deliverability" TEXT,
  -- Which of the candidates won, or 'original' when the address was right all along.
  "winner"         TEXT,

  "applied"     BOOLEAN NOT NULL DEFAULT FALSE,
  "appliedAt"   TIMESTAMPTZ,
  "appliedBy"   TEXT,

  "checkedAt"   TIMESTAMPTZ,
  "error"       TEXT,
  "createdAt"   TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- One verdict per address per field: re-checking updates rather than appends.
CREATE UNIQUE INDEX IF NOT EXISTS "AddressCorrection_lead_field_key"
  ON "AddressCorrection" ("leadId", "field");

CREATE INDEX IF NOT EXISTS "AddressCorrection_applied_idx"
  ON "AddressCorrection" ("applied", "deliverability");
