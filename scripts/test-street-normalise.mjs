/**
 * The street normaliser, against addresses this system actually holds.
 *
 *   npm run test:street
 *
 * Every case below is a real address from the Lead table or a real propertyLoc returned by
 * a municipal roll, not an invented one. The pairs marked `same` are the point of the whole
 * file: our spelling and the township's spelling have to arrive at one string, because the
 * match test compares them with ===.
 */
import './lib/env.mjs';
import { normalizeStreet, searchQueries } from '@/services/taxRoll.service';

let failed = 0;
const check = (label, got, want) => {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  if (!ok) failed++;
  console.log(`  ${ok ? 'ok  ' : 'FAIL'}  ${label}`);
  if (!ok) {
    console.log(`          got:  ${JSON.stringify(got)}`);
    console.log(`          want: ${JSON.stringify(want)}`);
  }
};

/** Our spelling and the roll's spelling must meet. */
console.log('\nours === theirs');
[
  ['20 Oxford Ky', '20 OXFORD KEY', 'Colts Neck'],
  ['148c Maclura Plz', '148C MACLURA PLAZA', 'Monroe'],
  ['33 Hummingbird Ct', '33 HUMMINGBIRD COURT', 'suffix expansion'],
  ['66 Laguna Hills Ct', '66 LAGUNA HILLS CRT', 'roll abbreviates too'],
  ['73 Overlook Way Unit D', '73 Overlook Way Apt D', 'unit word'],
  ['24 Deepwater Cir # A', '24 DEEPWATER CIRCLE UNIT A', 'hash is a unit'],
  ['100 John T O Leary Blvd', "100 JOHN T O'LEARY BLVD", 'apostrophe'],
  ['29 Mariners Cv', '29 MARINERS COVE', 'cove'],
  ['20 Cedar Xing', '20 CEDAR CROSSING', 'crossing'],
  ['2 Curtins Cor', '2 CURTINS CORNER', 'corner'],
  ['22 Gramercy Gdns # A', '22 GRAMERCY GARDENS APT A', 'gardens + unit'],
  ['1011 Old Bridge Tpke', '1011 OLD BRIDGE TURNPIKE', 'turnpike'],
].forEach(([ours, theirs, why]) => check(
  `${why.padEnd(22)} "${ours}" = "${theirs}"`,
  normalizeStreet(ours),
  normalizeStreet(theirs),
));

/** A street type is the last word. Anywhere else it is part of the name. */
console.log('\nno over-expansion');
[
  ['157 Rue De St Germaine # A', '157 RUE DE ST GERMAINE UNIT A', 'St = Saint, not Street'],
  ['11 St James Pl', '11 ST JAMES PLACE', 'St = Saint at the front too'],
  ['4 Mt Vernon Rd', '4 MT VERNON ROAD', 'Mt is not a street type'],
  ['213 Main St Unit 4', '213 MAIN STREET UNIT 4', 'but a real trailing St expands'],
  ['358 Rector St Apt 508', '358 RECTOR STREET UNIT 508', 'apt flattens to unit'],
  ['1700 Webb St Apt 2e', '1700 WEBB STREET UNIT 2E', 'alphanumeric unit'],
  ['50 Pearl St E', '50 PEARL STREET E', 'type sits before a directional'],
  ['6512 Avenue C', '6512 AVENUE C', 'street named for a letter'],
  ['22 Avenue A', '22 AVENUE A', 'and another'],
].forEach(([input, want, why]) => check(`${why.padEnd(34)} "${input}"`, normalizeStreet(input), want));

/** The vendor's phantom designator tail, and the genuine units it must not touch. */
console.log('\nphantom designator from the vendor');
[
  ['7 Florence Dr Fl Orence', '7 FLORENCE DRIVE', 'Florence = Fl + orence'],
  ['104 Stevens St Ste Vens', '104 STEVENS STREET', 'Stevens = Ste + vens'],
  ['77 Sterling Dr Ste Rling', '77 STERLING DRIVE', 'Sterling = Ste + rling'],
  ['8 Stephenville Pkwy Ste Phenville', '8 STEPHENVILLE PARKWAY', 'long tail'],
  ['15 Steeple Rd Ste Eple', '15 STEEPLE ROAD', 'the card this would have broken'],
  ['998 Florida Grove Rd Fl Orida', '998 FLORIDA GROVE ROAD', 'name is two words'],
  ['30b Plaza De Las Flores Fl Ores', '30 PLAZA DE LAS FLORES UNIT B', 'rebuilds a later word'],
  ['157 Rue De St Germaine # A', '157 RUE DE ST GERMAINE UNIT A', 'St with nothing to rebuild'],
  ['24 Deepwater Cir # A', '24 DEEPWATER CIRCLE UNIT A', 'a real one-letter unit'],
  ['358 Rector St Apt 508', '358 RECTOR STREET UNIT 508', 'a real numbered unit'],
  ['22 Gramercy Gdns # A', '22 GRAMERCY GARDENS UNIT A', 'a real unit after a new suffix'],
].forEach(([input, want, why]) => check(`${why.padEnd(32)} "${input}"`, normalizeStreet(input), want));

/** The broad query is what finds a property we have spelled differently. */
console.log('\nbroad fallback is generated');
[
  ['20 Oxford Ky', '20 OXFORD'],
  ['148c Maclura Plz', '148 MACLURA'],
  ['138 Coachman Dr N', '138 COACHMAN'],
  ['73 Overlook Way Unit D', '73 OVERLOOK'],
  ['6 Wycoff Way E', '6 WYCOFF'],
].forEach(([input, want]) => {
  const qs = searchQueries(input);
  check(`"${input}" -> includes "${want}"`, qs.includes(want), true);
});

/** Never ask for a bare house number — that returns the whole street. */
console.log('\nbroad fallback stays safe');
[
  ['1136 Vanderbergh', '1136 VANDERBERGH'],
  ['132 Broadway', '132 BROADWAY'],
].forEach(([input, want]) => {
  const qs = searchQueries(input);
  check(`"${input}" -> no bare number, broadest is "${want}"`, qs.includes(want) && !qs.includes(want.split(' ')[0]), true);
});

console.log(failed ? `\n${failed} FAILED\n` : '\nall passed\n');
process.exit(failed ? 1 : 0);
