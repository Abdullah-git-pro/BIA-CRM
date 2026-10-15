-- What the postal service tells us happened to a letter after we paid for it.
--
-- ── mailedAt had no source ───────────────────────────────────────────────────
-- 057 gave a letter a `mailedAt`, on the assumption that "we posted it" is an event. It is
-- not. Asked for the authoritative list, the vendor returns 27 letter events and there is no
-- plain `letter.mailed` among them — only `letter.certified.mailed`, which belongs to
-- certified mail, a service we are not buying.
--
-- A standard letter's life is: created -> in_transit -> in_local_area ->
-- processed_for_delivery -> delivered, or re-routed / returned_to_sender instead.
--
-- So the column is renamed to the event that actually exists. Leaving `mailedAt` in place
-- would have meant a timestamp nothing could ever fill, sitting on a screen next to ones
-- that fill — and the first person to read a column of nulls would reasonably conclude the
-- mail had never gone out.
--
-- The table is empty, so this is a rename rather than a migration of data.

ALTER TABLE "DirectMailSend" RENAME COLUMN "mailedAt" TO "processedAt";

-- The local depot has it; delivery is usually the next working day.
ALTER TABLE "DirectMailSend"
  ADD COLUMN IF NOT EXISTS "inLocalAreaAt" TIMESTAMPTZ;

/**
 * The last thing the vendor said, verbatim, and when.
 *
 * The named timestamps above cover the events we act on. This covers the ones we do not —
 * re-routed, rejected, failed, international_exit, the certified family — so an event we
 * have not modelled is still recorded rather than silently dropped. A webhook that quietly
 * discards what it does not recognise is one that tells you nothing on the day something
 * unusual happens.
 */
ALTER TABLE "DirectMailSend"
  ADD COLUMN IF NOT EXISTS "lastEvent"   TEXT,
  ADD COLUMN IF NOT EXISTS "lastEventAt" TIMESTAMPTZ;

/**
 * The vendor's event id, so a redelivered webhook changes nothing twice.
 *
 * Lob retries anything that does not answer 200, and a retry after a timeout is the normal
 * case rather than the exceptional one — the first attempt may well have succeeded and
 * simply answered too slowly.
 */
CREATE TABLE IF NOT EXISTS "DirectMailEvent" (
  "id"             TEXT PRIMARY KEY,
  "sendId"         TEXT REFERENCES "DirectMailSend"("id") ON DELETE CASCADE,
  "vendorLetterId" TEXT NOT NULL,
  "eventType"      TEXT NOT NULL,
  "occurredAt"     TIMESTAMPTZ,
  "payload"        JSONB,
  "createdAt"      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS "DirectMailEvent_send_idx" ON "DirectMailEvent" ("sendId");
CREATE INDEX IF NOT EXISTS "DirectMailEvent_letter_idx" ON "DirectMailEvent" ("vendorLetterId");

-- What a letter costs, so the send screen can price a batch before it is approved. Set to
-- the Developer-edition black-and-white first-class rate; change it when the plan changes.
INSERT INTO "AppConfig" ("key","value") VALUES ('cost_per_letter','1.06')
  ON CONFLICT ("key") DO NOTHING;
