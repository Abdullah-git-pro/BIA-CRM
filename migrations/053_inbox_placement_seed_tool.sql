-- 053: the seed tool is agreed, and placement readings now arrive from it.
--
-- Register A27 — "no seed tool has been agreed" — closes here. GlockApps is the tool, and
-- its API returns a reading per test, so InboxPlacement stops being a hand-entry table.
--
-- ── Why notDeliveredPct is added ───────────────────────────────────────────────
-- The table recorded inbox / promotions / spam, which sums to the mail that ARRIVED
-- somewhere. GlockApps also reports mail that reached none of them: accepted by the
-- receiving server and then dropped, with no bounce. That is the worst of the four
-- outcomes and the only one invisible from our own send log — a silent drop never
-- produces a bounce event, so it reads as "delivered" everywhere in this CRM (see the
-- DELIVERED_RULE note in outreachChannels.service).
--
-- Folding it into `note` would have put the single most alarming number in a free-text
-- field nothing reads.
ALTER TABLE "InboxPlacement" ADD COLUMN IF NOT EXISTS "notDeliveredPct" DOUBLE PRECISION;

-- Where the reading came from, so a reading can be traced back to the test that produced
-- it and re-read in full. Nullable: the hand-entered path still exists for a tool-less
-- reading, and the rows already in the table have no test behind them.
ALTER TABLE "InboxPlacement" ADD COLUMN IF NOT EXISTS "externalTestId" TEXT;
ALTER TABLE "InboxPlacement" ADD COLUMN IF NOT EXISTS "seedCount" INTEGER;

-- ── Why this index is UNIQUE ──────────────────────────────────────────────────
-- A sync re-reads the same finished tests every time it runs. Without this, each run
-- would append another copy of the same reading and the guardrail's "latest reading"
-- would keep finding a fresh timestamp on an old measurement — a stale number that
-- always looks current, which is worse than a number that is visibly old.
CREATE UNIQUE INDEX IF NOT EXISTS "InboxPlacement_tool_test_idx"
    ON "InboxPlacement" ("tool", "externalTestId")
 WHERE "externalTestId" IS NOT NULL;

COMMENT ON TABLE "InboxPlacement" IS
  'Seed-list inbox placement readings. Fed by the GlockApps seed tool (register A27, agreed 6 Oct 2026); hand entry remains possible for a reading taken any other way.';
COMMENT ON COLUMN "InboxPlacement"."notDeliveredPct" IS
  'Share of seed messages that arrived nowhere — no inbox, no spam folder, no bounce. Invisible from our own send log, where a silent drop counts as delivered.';
