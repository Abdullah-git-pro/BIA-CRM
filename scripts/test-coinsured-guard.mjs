/**
 * The co-insured slot holds ONE person, tested.
 *
 * Usage:  node --import ./scripts/lib/register-ts.mjs scripts/test-coinsured-guard.mjs
 *
 * ── The fault this exists to prevent ────────────────────────────────────────
 * Every co-insured field used to be guarded on its own — write the name if the name is
 * empty, the email if the email is empty. Each line reads correctly; the combination does
 * not. A card that already named a co-insured kept that name and took the EMAIL from
 * whichever person the trace happened to hand over.
 *
 * Lead 251520882 is what that produced. Insured Waqas Ashraf, co-insured Zebunnisa Saeed.
 * Tracerfy returned a "relative" called Ashraf Waqas — the insured with his name the
 * other way up — carrying waqas24@yahoo.com. The name guard held, the email guard did
 * not, and the card came to read "Zebunnisa Saeed · waqas24@yahoo.com". An email opening
 * "Dear Zebunnisa" would have arrived in Waqas's inbox, and every report would have
 * counted that lead reachable at the co-insured. 29 Grade A cards were in that state.
 *
 * ── Written adversarially ───────────────────────────────────────────────────
 * The happy path was never the problem — the old code passed it. These cases are the ones
 * where being wrong is expensive: a stranger's address accepted into a named slot, the
 * policyholder filed as his own co-insured, a sibling mistaken for a spouse. The last two
 * assertions are the reverse risk: a rule so strict it refuses the person it is meant to
 * accept costs us reach we have already paid for.
 *
 * No database. Pure functions, so this runs anywhere and cannot touch live data.
 */
import { coInsuredPatch, insuredPatchFromPersons } from '@/services/skipTrace.service';

let pass = 0;
let fail = 0;

function check(name, got, want) {
  const g = JSON.stringify(got);
  const w = JSON.stringify(want);
  if (g === w) { pass++; console.log(`  ok    ${name}`); return; }
  fail++;
  console.log(`  FAIL  ${name}`);
  console.log(`          got  ${g}`);
  console.log(`          want ${w}`);
}

console.log('\ncoInsuredPatch — one person, or nothing\n');

// ── The reported fault, in both the shapes it arrived in ────────────────────

check('a named slot refuses a different person',
  coInsuredPatch(
    { owner1FirstName: 'Waqas', owner1LastName: 'Ashraf',
      owner2FirstName: 'Zebunnisa', owner2LastName: 'Saeed' },
    { firstName: 'Ashraf', lastName: 'Waqas', email: 'waqas24@yahoo.com', phone: '7324246214' }),
  {});

check('the insured is never his own co-insured',
  coInsuredPatch(
    { owner1FirstName: 'Waqas', owner1LastName: 'Ashraf' },
    { firstName: 'Waqas', lastName: 'Ashraf', email: 'waqas24@yahoo.com' }),
  {});

check('...nor with his name reversed, which is how it arrived',
  coInsuredPatch(
    { owner1FirstName: 'Waqas', owner1LastName: 'Ashraf' },
    { firstName: 'Ashraf', lastName: 'Waqas', email: 'waqas24@yahoo.com' }),
  {});

// ── A contact with no name must never land in a named slot ──────────────────

check('an unnamed contact is refused outright',
  coInsuredPatch(
    { owner1FirstName: 'John', owner1LastName: 'Smith' },
    { email: 'mystery@x.com', phone: '5551234567' }),
  {});

// ── Relatives are not spouses ───────────────────────────────────────────────

check('same surname, different first name — a sibling, not the co-insured',
  coInsuredPatch(
    { owner1FirstName: 'John', owner1LastName: 'Smith',
      owner2FirstName: 'Mary', owner2LastName: 'Smith' },
    { firstName: 'Peter', lastName: 'Smith', email: 'peter@x.com' }),
  {});

// ── The producer always wins ────────────────────────────────────────────────

check('a hand-typed address is never overwritten',
  coInsuredPatch(
    { owner1FirstName: 'John', owner1LastName: 'Smith',
      owner2FirstName: 'Mary', owner2LastName: 'Jones', owner2Email: 'typed@byhand.com' },
    { firstName: 'Mary', lastName: 'Jones', email: 'vendor@x.com', phone: '5551234567' }),
  { owner2Phone: '5551234567' });

// ── The reverse risk: too strict is also a fault ────────────────────────────

check('an empty slot takes the name and the contacts together',
  coInsuredPatch(
    { owner1FirstName: 'John', owner1LastName: 'Smith' },
    { firstName: 'Mary', lastName: 'Jones', email: 'mary@x.com', phone: '5551234567', dob: '1980-04-01' }),
  { owner2FirstName: 'Mary', owner2LastName: 'Jones', owner2Phone: '5551234567',
    owner2Email: 'mary@x.com', owner2Dob: '1980-04-01' });

check('the slot’s own person, offered reversed, may still fill it',
  coInsuredPatch(
    { owner1FirstName: 'John', owner1LastName: 'Smith',
      owner2FirstName: 'Mary', owner2LastName: 'Jones' },
    { firstName: 'Jones', lastName: 'Mary', email: 'mary@x.com' }),
  { owner2Email: 'mary@x.com' });

check('a first name that is a prefix of the stored one — Alla / Allan',
  coInsuredPatch(
    { owner1FirstName: 'John', owner1LastName: 'Smith',
      owner2FirstName: 'Alla', owner2LastName: 'Petrov' },
    { firstName: 'Allan', lastName: 'Petrov', email: 'allan@x.com' }),
  { owner2Email: 'allan@x.com' });

// ── End to end, through the function both vendors actually call ─────────────

console.log('\ninsuredPatchFromPersons — the same guard, as the vendors reach it\n');

const patch = insuredPatchFromPersons(
  [
    { firstName: 'Waqas', lastName: 'Ashraf', age: 52,
      address: { streetAddress: '58 Demarest Dr' },
      phones: [{ phone: '2158487957' }], emails: [] },
    { firstName: 'Ashraf', lastName: 'Waqas', age: 52,
      address: { streetAddress: '58 Demarest Dr' },
      phones: [{ phone: '7324246214' }], emails: [{ email: 'waqas24@yahoo.com' }] },
  ],
  { owner1FirstName: 'Waqas', owner1LastName: 'Ashraf',
    owner2FirstName: 'Zebunnisa', owner2LastName: 'Saeed',
    addressStreet: '58 Demarest Dr' },
);

if (patch.owner2Email || patch.owner2Phone) {
  fail++;
  console.log(`  FAIL  lead 251520882 still writes into the co-insured slot: ${JSON.stringify(patch)}`);
} else {
  pass++;
  console.log('  ok    lead 251520882 writes nothing into Zebunnisa’s slot');
}

console.log(`\n${pass} passed, ${fail} failed\n`);
process.exit(fail ? 1 : 0);
