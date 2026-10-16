-- A person's answer to a name the roll could not settle, and who gave it.
--
-- Abdullah, 16 Oct 2026: "there is no functionality to set that lead that yes now human eye
-- check it and now it is confirmed. Also keep record who confirm it."
--
-- ── The hole this fills ──────────────────────────────────────────────────────
-- The review queue finds the work and the lead card shows the evidence, but nothing let a
-- person finish. The card's only owner-name action re-asks the township, which returns the
-- same answer it gave last time. So a lead at partial/mismatch/ambiguous/not_found stayed in
-- the queue for ever — and because direct mail's Gate 0 requires a roll match, it could
-- never become mailable however many times somebody looked at it. 206 Grade A leads were in
-- that state.
--
-- ── Why this is NOT written into ownerVerifyStatus ───────────────────────────
-- Setting that column to 'match' would be the quickest fix and the wrong one. It would erase
-- the difference between "the township's deed confirms this name" and "a colleague looked at
-- it and was satisfied". Those are different kinds of evidence with different reliability,
-- and a screen that calls both 'match' cannot tell you which you are relying on — the same
-- collision that had two opposite things both labelled "verified" on the contact screen.
--
-- So the machine's finding stays untouched and the person's decision sits beside it. Gate 0
-- accepts either, and anything reporting on a household can say which one it has.
--
-- ── Why the roll's name is copied in ─────────────────────────────────────────
-- A decision is made about specific evidence: the deed as it read that day. If the roll is
-- later re-read and comes back naming somebody else, the decision was about a different fact
-- and should stop counting. Storing what was on screen at the time is what makes that
-- detectable instead of silent.

ALTER TABLE "Lead"
  -- 'confirmed'  a person is satisfied the name on the card is the policyholder
  -- 'rejected'   a person is satisfied it is NOT, and the card needs fixing or dropping
  ADD COLUMN IF NOT EXISTS "ownerReviewDecision" TEXT,
  ADD COLUMN IF NOT EXISTS "ownerReviewBy"       TEXT,
  ADD COLUMN IF NOT EXISTS "ownerReviewAt"       TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS "ownerReviewNote"     TEXT,
  -- What the roll said when the decision was taken, so later drift is visible.
  ADD COLUMN IF NOT EXISTS "ownerReviewRollName" TEXT,
  -- And the machine verdict it was overriding, for the same reason.
  ADD COLUMN IF NOT EXISTS "ownerReviewStatusAt" TEXT;

-- The queue reads this on every row; the mail list filters on it.
CREATE INDEX IF NOT EXISTS "Lead_owner_review_idx"
  ON "Lead" ("ownerReviewDecision");
