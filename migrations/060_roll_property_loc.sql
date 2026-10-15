-- The address as the municipality itself writes it.
--
-- We already store what the tax roll says about the OWNER (ownerVerifyName). We throw away
-- what it says about the ADDRESS, which turns out to be the more useful of the two when our
-- own two address columns disagree.
--
-- 81 leads in C1–C8 hold a mailing address that differs from the property address, and in
-- that family the difference is often a corruption rather than a genuine forwarding address:
-- on 189418486 the property reads "85i Winthrop Rd" and the mailing column reads "851
-- Winthrop Road". The roll settles it — "85I WINTHROP RD" — so the mailing column is the
-- damaged one. Without this we rediscover that by hand every time.
--
-- ── What this is NOT ─────────────────────────────────────────────────────────
-- It is not a postal address and must never be used as one. The township identifies a
-- parcel; USPS decides whether a letter arrives, and the two disagree about exactly these
-- addresses. "85I WINTHROP RD" is a valid parcel and may still be an invalid delivery
-- point. Deliverability comes from the address verification, and nowhere else.

ALTER TABLE "Lead"
  ADD COLUMN IF NOT EXISTS "rollPropertyLoc"   TEXT,
  ADD COLUMN IF NOT EXISTS "rollPropertyLocAt" TIMESTAMPTZ;
