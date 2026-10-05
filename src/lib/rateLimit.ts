/**
 * A client-side request budget, so a vendor's rate limit degrades into slowness
 * rather than into a broken screen.
 *
 * ── Why this exists ────────────────────────────────────────────────────────
 * The campaign platform allows 20 requests a minute and says so only in the body of a
 * 429. It sends no `X-RateLimit-*` headers and no `Retry-After`, so there is nothing to
 * read: the budget has to be known in advance and counted here.
 *
 * Reading the reply inbox used to spend ten of those twenty on one page load — it paged
 * the whole send log looking for the handful of messages somebody had answered. Two
 * refreshes inside a minute, or two people opening the tab at once, and the request threw
 * and the tab read "Could not read the inbox".
 *
 * ── A queue, not a failure ─────────────────────────────────────────────────
 * `take()` waits for a slot instead of rejecting, up to `maxWaitMs`. A screen that takes
 * four seconds is a screen; a screen that throws is an incident. The ceiling is there
 * because the caller is usually a route handler with its own timeout, and a request that
 * hangs for a minute is no better than one that fails.
 *
 * ── What this does NOT guarantee ───────────────────────────────────────────
 * The counter lives in this process. On a serverless deployment each instance keeps its
 * own, and they share one API key — so with several instances warm the real total can
 * still exceed the budget. That is what the 429 retry in the client is for: this limiter
 * makes the common case correct and cheap, and the retry covers the rest. Raising the
 * budget to the full 20 would remove the headroom that makes the retry survivable.
 */

export type RateLimiterClock = {
  now: () => number;
  sleep: (ms: number) => Promise<void>;
};

const realClock: RateLimiterClock = {
  now: () => Date.now(),
  sleep: (ms) => new Promise((resolve) => { setTimeout(resolve, ms); }),
};

export class RateLimitExceededError extends Error {
  constructor(waitedMs: number) {
    super(`Rate limit queue exceeded ${waitedMs}ms`);
    this.name = 'RateLimitExceededError';
  }
}

export class RateLimiter {
  private readonly budget: number;
  private readonly windowMs: number;
  private readonly maxWaitMs: number;
  private readonly clock: RateLimiterClock;

  /** Timestamps of the requests that have gone out inside the current window. */
  private sent: number[] = [];

  /**
   * No request before this time — set after the vendor says we are over the limit.
   *
   * ── Why this is not "mark the window fully spent" ─────────────────────────
   * It was, and that was wrong. Filling the window made the next free slot a whole
   * window away, which is longer than `maxWaitMs`, so `take()` stopped waiting and
   * started throwing — every caller failed instantly for the rest of the minute after a
   * single 429. One cross-instance blip took the screen down for a minute, which is the
   * failure this class was written to prevent.
   *
   * A bounded cooldown says the honest thing instead: hold off briefly, then try again.
   * The vendor's window rolls continuously, so a short pause is usually enough.
   */
  private blockedUntil = 0;

  /**
   * Slot handout is serialised through this.
   *
   * Without it two callers arriving together both read "one slot left" and both take it.
   * Chaining the decision — not the request — means the fetches still run concurrently;
   * only the counting is single-file.
   */
  private gate: Promise<unknown> = Promise.resolve();

  constructor(opts: {
    budget: number;
    windowMs: number;
    maxWaitMs: number;
    clock?: RateLimiterClock;
  }) {
    this.budget = opts.budget;
    this.windowMs = opts.windowMs;
    this.maxWaitMs = opts.maxWaitMs;
    this.clock = opts.clock ?? realClock;
  }

  /** Slots left right now. Diagnostics only — never branch on it, it races. */
  available(): number {
    this.forget();
    if (this.clock.now() < this.blockedUntil) return 0;
    return Math.max(0, this.budget - this.sent.length);
  }

  private forget(): void {
    const cutoff = this.clock.now() - this.windowMs;
    this.sent = this.sent.filter((t) => t > cutoff);
  }

  /**
   * Wait for a slot and claim it.
   *
   * Throws RateLimitExceededError only after waiting maxWaitMs, which means the budget is
   * genuinely oversubscribed rather than merely busy.
   */
  async take(): Promise<void> {
    const mine = this.gate.then(() => this.claim());
    // The chain must not break on a rejection, or every later caller inherits it.
    this.gate = mine.catch(() => undefined);
    return mine;
  }

  private async claim(): Promise<void> {
    const deadline = this.clock.now() + this.maxWaitMs;

    for (;;) {
      this.forget();
      const now = this.clock.now();

      // Whichever comes later: the cooldown ending, or a slot falling out of the window.
      let freeAt = 0;
      if (now < this.blockedUntil) freeAt = this.blockedUntil;
      else if (this.sent.length >= this.budget) freeAt = this.sent[0] + this.windowMs;

      if (!freeAt) {
        this.sent.push(now);
        return;
      }

      /*
       * Give up WITHOUT waiting first.
       *
       * If the slot arrives after the deadline it will still be too late when we wake, so
       * sleeping would spend the caller's patience to reach the same answer. Failing
       * immediately with a clear message beats failing slowly.
       */
      if (freeAt > deadline) throw new RateLimitExceededError(this.maxWaitMs);

      // +25ms so we wake up after the slot has actually expired, not on the boundary.
      await this.clock.sleep(Math.max(0, freeAt - now) + 25);
    }
  }

  /**
   * Hold off for a while — called after the vendor returns 429.
   *
   * The vendor counted requests this process did not: another instance sharing the key,
   * or its window not lining up with ours. Carrying straight on would earn another 429,
   * so new requests pause. Bounded, and never shortens a cooldown already in force.
   */
  block(ms: number): void {
    this.blockedUntil = Math.max(this.blockedUntil, this.clock.now() + ms);
  }
}
