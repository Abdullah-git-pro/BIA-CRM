/**
 * Build the surname review list (Frank, 24 Sep 2026 · second email §7, item 5).
 *
 *   node --import ./scripts/lib/register-ts.mjs scripts/build-name-review.mjs
 *   node --import ./scripts/lib/register-ts.mjs scripts/build-name-review.mjs --write
 *
 * Checks only the ONE address per person the push would actually mail, and only where that
 * address came from a skip trace. Idempotent: a decision already recorded survives a re-run.
 */
import './lib/env.mjs';
import { buildReviewQueue, reviewSummary } from '@/services/emailNameReview.service';

const WRITE = process.argv.includes('--write');
const r = await buildReviewQueue({ effFrom: '2026-10-05', effTo: '2026-11-16', dryRun: !WRITE });

console.log(`${r.checked} trace-recovered addresses checked`);
console.log(`  match          ${String(r.matched).padStart(5)}`);
console.log(`  queued         ${String(r.queued).padStart(5)}`);
console.log(`  already queued ${String(r.alreadyQueued).padStart(5)}`);
console.log(`  producer-typed, not checked ${r.notTraced}`);
// The identity check already answered these, so the matcher never ran on them and no
// reviewer is asked. Printed because it is the number that explains a shrinking queue.
console.log(`  confirmed by the identity check ${r.confirmedTheirs}`);
console.log('\nheld, by renewal week:');
for (const c of r.byCohort) console.log(`   ${c.cohort}  ${String(c.n).padStart(3)}`);

if (!WRITE) { console.log('\nDRY RUN — nothing written. Re-run with --write.'); process.exit(0); }
const s = await reviewSummary();
console.log(`\nreview list: ${s.open} open · ${s.approved} approved · ${s.rejected} rejected`);
