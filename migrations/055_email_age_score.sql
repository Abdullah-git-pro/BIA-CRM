-- The email side of the liveness question: how old and how active is this address.
--
-- Abdullah, 14 Oct 2026, on being shown the gap: "Yes add the email age score."
--
-- ── Why it is needed ─────────────────────────────────────────────────────────
-- 054 recorded two things about an address — whose it is (nameMatch) and whether the
-- provider thinks it exists (isValid). The second turned out to be worthless on the phone
-- side, where isValid was TRUE on all 158 numbers we already knew were dead, and there is
-- no reason to expect it to behave differently for email. That left nameMatch carrying the
-- whole decision by itself.
--
-- The phone rows do not have that problem because they carry activityScore, which is the
-- single most useful field the provider returns: >= 70 blocked 87% of dead numbers while
-- keeping 93% of connecting calls. The email equivalent exists — a 0-100 longevity and
-- activity score — but it is a paid add-on and we were not asking for it, so every address
-- we graded came back with the identity answer and nothing about whether anybody still
-- reads the mailbox.
--
-- ── Its own column, not activityScore ────────────────────────────────────────
-- They are different measurements: one is recent telecom activity on a line, the other is
-- an address's age and use. Sharing a column would make "activityScore >= 70" silently mix
-- the two the moment somebody wrote that filter without a channel clause — the same
-- mixed-population error that put 1,829 leads in a 994-lead programme's totals.
--
-- ── It gates nothing ─────────────────────────────────────────────────────────
-- The phone threshold was earned by scoring 221 lookups against outcomes already known.
-- No such measurement exists for email yet, and choosing a cut-off before it does would be
-- guessing with somebody's campaign. Stored and displayed; it decides nothing until it has
-- been scored against real opens and bounces.

ALTER TABLE "ContactVerification"
  ADD COLUMN IF NOT EXISTS "emailAgeScore" INTEGER;

-- The provider's own A-F summary for the address, read from the same response. 054 stored
-- this for phones only, so the email half of every row was thrown away for free.
ALTER TABLE "ContactVerification"
  ADD COLUMN IF NOT EXISTS "emailContactGrade" TEXT;
