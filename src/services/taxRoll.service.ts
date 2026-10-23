/**
 * Municipal tax-roll owner lookup (Edmunds GovTech WIPP).
 *
 * Confirms the insured name we hold against the township's public tax roll.
 *
 * ── Scope, deliberately narrow ───────────────────────────────────────────────
 * The public site is a BILL-PAYMENT portal. We use exactly ONE read-only endpoint:
 *
 *     GET /wipp-core/v1/wippUtil/search?propertyLoc=<address>&size=<n>
 *
 * which returns the owner name for an address. We never call the account-detail
 * endpoint, never POST, and never touch anything on a payment path. `assertSafeUrl`
 * enforces that in code rather than by convention, so a future edit can't quietly
 * widen the blast radius.
 *
 * ── Etiquette ────────────────────────────────────────────────────────────────
 * Requests are serialised with a minimum gap between them. This is a small municipal
 * service; we behave like one careful person, not a crawler. Results are cached on the
 * lead (ownerVerify* columns) so a property is never looked up twice.
 *
 * NOTE: automated use of a third-party vendor's portal is a business/ToS decision for
 * BIA to confirm — this module is the mechanism, not the authorisation to run it at
 * volume. It is equally happy being fed a township-supplied data extract instead;
 * `compareOwnerNames` does the actual verification and is source-agnostic.
 */
// `type` on the interface: without it Node's type-stripping loader treats NameComparison as
// a real export and refuses to load this module at runtime, which tsc never sees because it
// erases the import anyway.
import { compareOwnerNames, type NameComparison } from './ownerNameMatch.service';

const API_ROOT = 'https://api.edmundsgovtech.cloud/wipp-core/v1';

/**
 * Two read-only search endpoints, tried in order.
 *
 * Property tax first: every property pays tax, but not every property has a
 * municipal water/sewer account — plenty of homes are on well and septic, and those
 * are simply absent from the utility roll (verified: "7 American Way, Marlboro" is
 * missing from utility but present on tax). Utility is kept as a fallback because
 * some records appear there and not on tax.
 */
const SEARCH_ENDPOINTS = [
  { kind: 'tax', path: '/wippPropInfo/search', extra: '&noBlqFlag=N' },
  { kind: 'utility', path: '/wippUtil/search', extra: '' },
] as const;

/**
 * ZIP → the municipalities that share it. Add a town by adding one entry (the wippId
 * is in the portal URL; note it is not always numeric — Manalapan's is "WMON").
 *
 * A ZIP is NOT a municipality, so this is a LIST. 07726 posts as "Englishtown" but
 * covers both the tiny Borough of Englishtown and the much larger Manalapan Township,
 * which keep separate tax rolls — and most "Englishtown" addresses are physically in
 * Manalapan (verified: 83 Sunnymede St is on Manalapan's roll, not Englishtown's).
 * Each town is tried in turn, most-likely first; a property that is on none of them
 * is simply left unverified rather than wrongly flagged.
 */
export interface Municipality { wippId: string; town: string }

export const WIPP_BY_ZIP: Record<string, Municipality[]> = {
  '07731': [{ wippId: '1321', town: 'Howell' }],
  '07746': [{ wippId: '1330', town: 'Marlboro' }],
  /**
   * ── 07726: the township's TAX roll comes before the utility authority ──────
   *
   * 'WMON' is not Manalapan Township. It is the Western Monmouth Utilities Authority
   * (103 Pension Road, Manalapan) — a water and sewer roll, which the portal itself labels
   * "Utility Quick Pay". It was configured as `town: 'Manalapan'` and every verdict from it
   * has been stored as `manalapan_tax_roll`, which reads as something it is not.
   *
   * That matters for the reason the tax roll is tried first everywhere else: every property
   * pays tax, but not every property has a municipal water account, and the account holder
   * is not always the person on the deed. On a condominium the utility frequently sits with
   * the management company — "TOWNHOUSE MANAGEMENT LLC" holds one at 124 Deepwater Circle —
   * while the deed names the owner we are trying to confirm.
   *
   * Manalapan Township's own tax roll is 1328 (Abdullah, 22 Oct 2026, from the portal:
   * wippId=1328 renders "MANALAPAN TOWNSHIP" over a property-tax search). WMON is kept
   * after it as a fallback, because a property absent from the tax roll may still appear on
   * the utility one — the same reason the utility endpoint exists for every other town.
   */
  '07726': [
    { wippId: '1328', town: 'Manalapan' },    // the township's property tax roll
    { wippId: 'WMON', town: 'Western Monmouth Utilities' },
    { wippId: '1313', town: 'Englishtown' },  // the borough proper
  ],
  // 07728 covers Freehold Township AND Freehold Borough — separate municipalities,
  // separate rolls (Township 1317, Borough 1316; verified live Jul-2026: "MAIN STREET"
  // returns Borough rows on 1316 and nothing on 1317, since Main St is Borough territory).
  '07728': [
    { wippId: '1317', town: 'Freehold Township' },
    { wippId: '1316', town: 'Freehold Borough' },
    /**
     * Howell, because a "Freehold" mailing address is not a statement about which township
     * collects the tax.
     *
     * Three C2 cards reported "not on the tax roll" and all three sat on Howell's roll under
     * the address we were already sending, correctly expanded: 13 DECOY LANE (MCMANAMAN,
     * ERICA), 44 ATLANTIS TERRACE (POSTEN, MARGARET T) and 21 SEABREEZE SQUARE, which also
     * names a co-insured — JANUS, KAITLYN — that the card did not have. The lookup was
     * never wrong about the address; it was asking the wrong towns.
     *
     * Adding a town is safe rather than risky: a record is only accepted when its full
     * normalised address, unit included, equals ours, so a wider search cannot return a
     * neighbour's property — it can only find one we were missing or report ambiguity.
     */
    { wippId: '1321', town: 'Howell' },
  ],
  '07730': [{ wippId: '1318', town: 'Hazlet' }],
  // Middletown publishes property tax only — no utility roll (the fallback handles it).
  '07748': [{ wippId: '1332', town: 'Middletown' }],
  // 07724 splits roughly evenly between Tinton Falls (30) and Eatontown (28).
  // (Eatontown's public link is on the legacy edmundsassoc.com domain, but the same id
  //  works against the modern API — no second integration needed.)
  '07724': [
    { wippId: '1349', town: 'Tinton Falls' },
    { wippId: '1312', town: 'Eatontown' },
  ],
  '07733': [{ wippId: '1320', town: 'Holmdel' }],
  '07722': [{ wippId: '1310', town: 'Colts Neck' }],   // property tax only

  /**
   * ── Monmouth towns that were never wired up (15 Oct 2026) ─────────────────
   *
   * 156 Grade A leads were coming back 'unsupported', which reads as "this town has no roll
   * we can reach" and was about to be sent to Frank as a list of nineteen townships to chase
   * data from. It was not true. 'unsupported' only ever meant "no municipality configured
   * for this ZIP", and almost all of these towns were sitting on the same provider as
   * Howell and Holmdel, never added.
   *
   * Found by asking each Monmouth id (1301–1353) what it holds rather than guessing, then
   * confirming each candidate the way the real lookup does: a full street from a real lead,
   * matched exactly against what the roll returns. Old Bridge was used as a control and
   * correctly failed — it is Middlesex and genuinely runs its own system.
   *
   * Three of these are not towns at all but villages inside townships we already queried,
   * which is why their leads should never have been unsupported: Morganville is Marlboro,
   * and Lincroft and Belford are Middletown.
   */
  '07721': [{ wippId: '1301', town: 'Aberdeen' }],     // Cliffwood is in Aberdeen Township
  '07751': [{ wippId: '1330', town: 'Marlboro' }],     // Morganville is in Marlboro
  '07738': [{ wippId: '1332', town: 'Middletown' }],   // Lincroft is in Middletown
  '07718': [{ wippId: '1332', town: 'Middletown' }],   // Belford is in Middletown
  '07701': [{ wippId: '1339', town: 'Red Bank' }],
  '07753': [{ wippId: '1335', town: 'Neptune Township' }],
  '07764': [{ wippId: '1353', town: 'West Long Branch' }],
  '08730': [{ wippId: '1309', town: 'Brielle' }],
  '07762': [{ wippId: '1347', town: 'Spring Lake' }],
  '07760': [{ wippId: '1341', town: 'Rumson' }],
  '07720': [{ wippId: '1308', town: 'Bradley Beach' }],

  /**
   * ── ZIPs that span more than one municipality ─────────────────────────────
   *
   * Each of these failed against the town it is named after and succeeded against a
   * neighbour, which is the normal shape here rather than an anomaly: 07727 is posted as
   * Farmingdale but five of six sampled properties are assessed by HOWELL, and 07712 is
   * posted as Asbury Park while five of six are OCEAN TOWNSHIP.
   *
   * Listing several is safe. lookupTaxRoll accepts a record only on an exact normalised
   * address match, so a municipality that does not hold the property simply returns
   * nothing — it cannot put the wrong town's owner on a card.
   *
   * Matawan is here despite the 14 Oct note that it "uses officialpayments.com". That was
   * about its PAYMENT portal; its roll is on this API like everybody else's — the same
   * split Dunellen has above. Worth remembering before writing another town off.
   */
  '07747': [
    { wippId: '1331', town: 'Matawan' },
    { wippId: '1301', town: 'Aberdeen' },
  ],
  '07727': [
    { wippId: '1321', town: 'Howell' },
    { wippId: '1315', town: 'Farmingdale' },
  ],
  '07712': [
    { wippId: '1337', town: 'Ocean Township' },
    { wippId: '1304', town: 'Asbury Park' },
  ],
  '07719': [{ wippId: '1352', town: 'Wall Township' }],
  '08510': [{ wippId: '1333', town: 'Millstone Township' }],
  '07732': [{ wippId: '1319', town: 'Highlands' }],
  '08701': [{ wippId: '1515', town: 'Lakewood' }],     // Ocean County, property tax only

  // ── Middlesex County (Frank Aug-2026) ───────────────────────────────────────
  // Every id below was read from the town's official tax portal AND confirmed
  // against the live Edmunds API (each returns that town's own roll). Edmunds
  // assigned Middlesex a consecutive block 1201-1225 alphabetically. Dunellen (1203) and
  // Old Bridge (1215) moved their PAYMENTS off Edmunds (Link2Gov / in-house portal), but
  // Dunellen's tax ROLL is still live on the read-only API, so it's wired below; Old
  // Bridge (1215) returns nothing on the API and is left out (its ZIP pulls, no verify).
  // A stale/wrong id can never mis-verify: lookupTaxRoll requires an exact street match,
  // so the worst case is "no match" (same as unverified), never a false tick.
  '07008': [{ wippId: '1201', town: 'Carteret' }],
  '08812': [{ wippId: '1203', town: 'Dunellen' }],     // payments on Link2Gov; roll still on Edmunds API
  '08512': [{ wippId: '1202', town: 'Cranbury' }],
  '08816': [{ wippId: '1204', town: 'East Brunswick' }],
  '08817': [{ wippId: '1205', town: 'Edison' }],
  '08820': [{ wippId: '1205', town: 'Edison' }],
  '08837': [{ wippId: '1205', town: 'Edison' }],
  '08828': [{ wippId: '1206', town: 'Helmetta' }],
  '08904': [{ wippId: '1207', town: 'Highland Park' }],
  // 08831 covers both Jamesburg Borough and the surrounding Monroe Township.
  '08831': [{ wippId: '1212', town: 'Monroe Township' }, { wippId: '1208', town: 'Jamesburg' }],
  '08840': [{ wippId: '1209', town: 'Metuchen' }],
  '08846': [{ wippId: '1210', town: 'Middlesex Borough' }],
  '08850': [{ wippId: '1211', town: 'Milltown' }],
  '08901': [{ wippId: '1213', town: 'New Brunswick' }],
  '08902': [{ wippId: '1214', town: 'North Brunswick' }],
  '08861': [{ wippId: '1216', town: 'Perth Amboy' }],
  '08854': [{ wippId: '1217', town: 'Piscataway' }],
  '08536': [{ wippId: '1218', town: 'Plainsboro' }],
  '08872': [{ wippId: '1219', town: 'Sayreville' }],
  // 08859 (Parlin) is split between Sayreville and Old Bridge; only Sayreville is on Edmunds.
  '08859': [{ wippId: '1219', town: 'Sayreville' }],
  '08879': [{ wippId: '1220', town: 'South Amboy' }],
  '08852': [{ wippId: '1221', town: 'South Brunswick' }],
  '08810': [{ wippId: '1221', town: 'South Brunswick' }],
  '08824': [{ wippId: '1221', town: 'South Brunswick' }],
  '07080': [{ wippId: '1222', town: 'South Plainfield' }],
  '08882': [{ wippId: '1223', town: 'South River' }],
  '08884': [{ wippId: '1224', town: 'Spotswood' }],
  // Woodbridge Township spans many sections/ZIPs; all share wippId 1225.
  '07095': [{ wippId: '1225', town: 'Woodbridge' }],
  '08830': [{ wippId: '1225', town: 'Woodbridge' }],  // Iselin
  '07067': [{ wippId: '1225', town: 'Woodbridge' }],  // Colonia
  '08863': [{ wippId: '1225', town: 'Woodbridge' }],  // Fords
  '07001': [{ wippId: '1225', town: 'Woodbridge' }],  // Avenel
  '07064': [{ wippId: '1225', town: 'Woodbridge' }],  // Port Reading
  '07077': [{ wippId: '1225', town: 'Woodbridge' }],  // Sewaren
  '08832': [{ wippId: '1225', town: 'Woodbridge' }],  // Keasbey
  /**
   * ── Towns that are NOT on this vendor, checked and ruled out ──────────────
   *
   * These are not missing entries waiting for somebody to find an id. Each runs its tax
   * portal on a different system, so there is no WIPP tenant to point at and no amount of
   * looking will produce one. Verified 14 Oct 2026 against each township's own site:
   *
   *   08857  Old Bridge          in-house SharePoint portal; id 1215 answers 403
   *   07747  Matawan             officialpayments.com
   *   07721  Cliffwood/Aberdeen  aberdeennj.qscend.com
   *
   * Together that is 546 leads, 96 of them Grade A, that this module can never verify.
   * They are reported as 'unsupported' — a different fact from "not on the roll" — and the
   * review queue keeps them out of the list of things a person can settle, because nobody
   * can resolve them by looking at the card.
   *
   * The way in, if it is ever wanted, is the one named at the top of this file: a
   * township-supplied data extract. compareOwnerNames does the verification and does not
   * care where the record came from.
   *
   * 08859 (Parlin) is shared Sayreville/Old Bridge — the Sayreville side verifies, the Old
   * Bridge side will not match and falls through unverified.
   */
};

export interface TaxRollRecord {
  ownerName: string;
  propertyLoc: string;
  accountId: string;
}

export interface OwnerVerification {
  status: NameComparison['result'];
  detail: string;
  /** Name exactly as the tax roll shows it. */
  recordName: string | null;
  source: string;
  checkedAt: Date;
}

// ── Safety rails ────────────────────────────────────────────────────────────

/** Only the two read-only search endpoints are ever permitted. */
function assertSafeUrl(url: string): void {
  const allowed = SEARCH_ENDPOINTS.some((e) => url.startsWith(`${API_ROOT}${e.path}?`));
  if (!allowed) {
    throw new Error(`taxRoll: refusing to call a non-search endpoint (${url.slice(0, 80)})`);
  }
  if (/\b(pay|payment|cart|checkout|charge|card|ach)\b/i.test(url)) {
    throw new Error('taxRoll: refusing to call a payment-related endpoint');
  }
}

// Serialise requests with a minimum gap — one careful person, not a crawler.
const MIN_GAP_MS = 1500;
let lastCall = 0;
let queue: Promise<unknown> = Promise.resolve();

function throttled<T>(fn: () => Promise<T>): Promise<T> {
  const run = async (): Promise<T> => {
    const wait = Math.max(0, lastCall + MIN_GAP_MS - Date.now());
    if (wait) await new Promise((r) => setTimeout(r, wait));
    lastCall = Date.now();
    return fn();
  };
  const next = queue.then(run, run);
  queue = next.catch(() => {});
  return next as Promise<T>;
}

// ── Address handling ────────────────────────────────────────────────────────

/**
 * Both sides are abbreviated, and not with the same abbreviations.
 *
 * We shorten Court to "Ct"; Holmdel's roll shortens it to "CRT". Expanding only our side
 * left "66 LAGUNA HILLS COURT" against the roll's "66 LAGUNA HILLS CRT" — the broad query
 * FOUND the property and the exact-match test then threw it away, which reads as "not on
 * the tax roll" and is the most misleading answer available.
 *
 * CRT, TERR, DRV and CIRC are observed on live rolls; the rest are the ordinary USPS
 * forms. Everything maps to the long word, so it does not matter which side is short.
 *
 * ── The second batch (22 Oct 2026) ──────────────────────────────────────────
 * Abdullah checked "20 Oxford Ky, Colts Neck" by hand and the portal returned
 * SALVA, FRANCIA at 20 OXFORD KEY while the card read "not on the tax roll". KY was simply
 * missing here. Auditing every trailing word in all 11,127 addresses against this table
 * turned up twelve more of the same kind, and they are not evenly spread: PLZ alone is 20
 * cards and every one of them is Grade A, because Monroe's Society Hill plazas are a
 * renewal-heavy condo development. The roll writes "148C MACLURA PLAZA"; we wrote
 * "148c Maclura Plz"; nothing matched.
 *
 * An abbreviation missing from this table is worse than one spelled out on both sides,
 * because it also suppresses the broad fallback in searchQueries — see the note there.
 */
const STREET_SUFFIX: Record<string, string> = {
  ST: 'STREET', RD: 'ROAD', DR: 'DRIVE', CT: 'COURT', LN: 'LANE', AVE: 'AVENUE', AV: 'AVENUE',
  BLVD: 'BOULEVARD', CIR: 'CIRCLE', TER: 'TERRACE', PL: 'PLACE', PKWY: 'PARKWAY', HWY: 'HIGHWAY',
  SQ: 'SQUARE', TRL: 'TRAIL', WAY: 'WAY',
  // Variants seen on the rolls themselves.
  CRT: 'COURT', CTS: 'COURT', TERR: 'TERRACE', DRV: 'DRIVE', CIRC: 'CIRCLE', CRCL: 'CIRCLE',
  LNE: 'LANE', AVEN: 'AVENUE', BLV: 'BOULEVARD', PKY: 'PARKWAY', PKWAY: 'PARKWAY',
  SQR: 'SQUARE', PLC: 'PLACE', RDG: 'RIDGE', HGTS: 'HEIGHTS', HTS: 'HEIGHTS',
  // Found by audit, 22 Oct 2026 — each one observed in our own address data.
  PLZ: 'PLAZA', TPKE: 'TURNPIKE', TPK: 'TURNPIKE', KY: 'KEY', HL: 'HILL', HLS: 'HILLS',
  CV: 'COVE', GDNS: 'GARDENS', GDN: 'GARDEN', KNL: 'KNOLL', MNR: 'MANOR', GRN: 'GREEN',
  HOLW: 'HOLLOW', XING: 'CROSSING', CRES: 'CRESCENT', COR: 'CORNER', PRT: 'PORT',
  EXT: 'EXTENSION', CTR: 'CENTER', GLN: 'GLEN', MDW: 'MEADOW', MDWS: 'MEADOWS',
  VLG: 'VILLAGE', VW: 'VIEW', FRST: 'FOREST', PT: 'POINT', PNE: 'PINE', BRG: 'BRIDGE',
};

/**
 * Canonical form for comparing two street addresses ("21 Moonlight Way" ≡ "21 MOONLIGHT WAY").
 *
 * ── Why the unit word is flattened ──────────────────────────────────────────
 * The roll and the card disagree about what to call the same thing. Our card holds "73
 * Overlook Way Unit D"; Manalapan's roll holds "73 Overlook Way Apt D". Compared literally
 * those are two different properties, so the strict filter below threw away an exact match
 * — and the card came back "not on tax roll" with a co-insured (Esther Lin) sitting in the
 * record nobody could see. Frank found that one by hand on 30 Sep and asked why we hadn't.
 *
 * ── Why "51b" is split ──────────────────────────────────────────────────────
 * Frank, item 8: "75b" should be read as "75 Unit B". The roll writes the unit as its own
 * field; our source sometimes glues it to the house number. Left alone, "51B PIAZZA TASSO"
 * matches nothing at all, because no roll has a house numbered 51B.
 */
export function normalizeStreet(s: unknown): string {
  let base = String(s ?? '')
    .toUpperCase()
    /**
     * Apostrophes are DELETED, not turned into spaces.
     *
     * Our source writes "100 John T O Leary Blvd"; South Amboy's roll writes
     * "100 JOHN T O'LEARY BLVD". Deleting the apostrophe turns theirs into "OLEARY"; the
     * single-letter join below turns ours into the same thing, so the two meet. Replacing
     * it with a space instead would leave "O LEARY" against "OLEARY" and match nothing.
     *
     * Seven leads sit in that one building, across C2, C4, C6, C7 and C8. The curly
     * apostrophe is covered too — it arrives from anything that has been through a word
     * processor.
     */
    .replace(/['’ʼ`]/g, '')
    .replace(/[.,]/g, ' ')
    // "#" is a unit marker, not punctuation to be deleted: "24 Deepwater Cir # A".
    .replace(/#\s*/g, ' UNIT ')
    .replace(/\s+/g, ' ')
    .trim();

  /**
   * A lone letter joins the word after it: "O LEARY" → "OLEARY", "CHAIN O HILLS" → "OHILLS".
   *
   * This is the other half of the apostrophe fix. Whichever side kept the apostrophe and
   * whichever dropped it, both now arrive at the same token — and because this runs on OUR
   * address and on the roll's `propertyLoc` alike, a street that one side spells "Chain O'
   * Hills" and the other "Chain O Hills" lands in the same place either way.
   *
   * Restricted to O, D and L — the letters that actually carry an apostrophe in a name.
   * Any letter would be too eager: the roll's "100 JOHN T O'LEARY" becomes "JOHN T OLEARY"
   * once the apostrophe goes, and a general rule then joins the middle initial as well to
   * give "JOHN TOLEARY", which matches nothing on our side. A middle initial is not a
   * name prefix.
   *
   * Requires the following word to be three characters or more, so "1611 L St" is untouched
   * — a street type is not part of a name. Runs BEFORE the suffix table for that reason.
   */
  base = base.replace(/\b([ODL]) ([A-Z]{3,})\b/g, '$1$2');

  base = dropPhantomDesignator(base);

  // "51B PIAZZA TASSO" → "51 PIAZZA TASSO UNIT B". Only when a single letter is glued to
  // the leading house number, which is the shape the source actually produces.
  const glued = base.match(/^(\d+)([A-Z])\s+(.*)$/);
  if (glued) base = `${glued[1]} ${glued[3]} UNIT ${glued[2]}`;

  /**
   * "UNIT 5-A" and "UNIT 5A" are the same flat.
   *
   * Woodbridge's roll hyphenates the sub-unit, our source does not, and the exact-match
   * test compares the whole string — so the two forms never met. Scoped to the token after
   * UNIT so a genuinely hyphenated STREET name is untouched.
   */
  base = base.replace(/\b(UNIT|APT|APARTMENT|STE|SUITE|BLDG|BUILDING)\s+([A-Z0-9]+)-([A-Z0-9]+)\b/g, '$1 $2$3');

  /**
   * ── Why the suffix table is applied to ONE token, not every token ─────────
   *
   * It used to run over the whole address, which reads "St" as Street wherever it appears.
   * "157 Rue De St Germaine" became "157 RUE DE STREET GERMAINE" — that St is Saint — and
   * "Ste" was flattened to a unit marker, so "104 Stevens St Ste Vens" became
   * "104 STEVENS STREET UNIT VENS", inventing a flat called Vens. 25 cards read like that.
   *
   * A street type is the last word of the street name, so that is the only place it is
   * expanded. Two exceptions, both of which still want the word before the last one:
   *   - a trailing directional, "50 Pearl St E"
   *   - a street whose NAME is a letter, "6512 Ave C" — nine of these in Monroe
   * Everything after a unit marker is set aside first, so "73 Overlook Way Apt D" still
   * expands Way.
   */
  const toks = base.split(' ');

  /**
   * APT, UNIT, STE and friends all name the same thing — but only when a unit actually
   * follows. A unit designator carries a digit ("508", "2105", "11N", "2E") or is one or
   * two characters ("A", "D"). A four-letter word after "Ste" is part of the street name,
   * not a flat number, and flattening it was how "Ste Vens" turned into "UNIT VENS".
   */
  const isUnitDesignator = (tok: string | undefined) =>
    !!tok && (/\d/.test(tok) || tok.length <= 2);
  const flat = toks.map((tok, i) =>
    (UNIT_WORD.has(tok) && isUnitDesignator(toks[i + 1]) ? 'UNIT' : tok));

  const unitAt = flat.indexOf('UNIT');
  const streetPart = unitAt === -1 ? flat : flat.slice(0, unitAt);
  const unitPart = unitAt === -1 ? [] : flat.slice(unitAt);

  const last = streetPart.length - 1;
  if (last >= 0) {
    const tail = streetPart[last];
    // The street type sits one word earlier when a directional or a letter-name follows it.
    const shifted = (DIRECTIONAL.has(tail) || /^[A-Z]$/.test(tail)) && last >= 1 ? last - 1 : last;
    streetPart[shifted] = STREET_SUFFIX[streetPart[shifted]] ?? streetPart[shifted];
  }

  return [...streetPart, ...unitPart]
    .join(' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * Drop the phantom unit designator Real Estate API appends to some street names.
 *
 * 64 of our addresses arrive from the vendor like this:
 *   "7 Florence Dr Fl Orence"        "104 Stevens St Ste Vens"
 *   "77 Sterling Dr Ste Rling"       "8 Stephenville Pkwy Ste Phenville"
 * The tail is the street name split in two: "Florence" = "Fl" + "orence", "Sterling" =
 * "Ste" + "rling". Something upstream read the first letters of the street name as a
 * secondary unit designator — FL is Floor, STE is Suite in the USPS tables — and appended
 * the designator plus the remainder of the word. It is not our doing: storage.service
 * copies `property.address.street` verbatim, and `addressFull` carries the same tail.
 *
 * Repaired here rather than in the Lead table on purpose. The next import would write the
 * vendor's spelling back over any cleanup, and the vendor is not going to fix this for us.
 * `mailStreet` holds the correct street on 63 of the 64 — worth knowing, but not a
 * substitute, since it is the MAILING address and need not be the property at all.
 *
 * The test is self-verifying: the tail is only removed when the designator and what follows
 * it rebuild a word that is already in the address. "Ste Vens" goes because the street is
 * already "Stevens"; a genuine "Ste 200" or "Unit B" has nothing to rebuild and stays.
 */
function dropPhantomDesignator(s: string): string {
  const m = s.match(/^(.*?)\s+(FL|STE|APT|RM|BLDG|DEPT|UNIT)\s+([A-Z]{2,})$/);
  if (!m) return s;
  const [, head, designator, rest] = m;
  const rebuilt = `${designator}${rest}`;
  return head.split(' ').includes(rebuilt) ? head : s;
}

/** Every word a municipality might use for the same sub-address. */
const UNIT_WORD = new Set(['APT', 'APARTMENT', 'UNIT', 'STE', 'SUITE', 'BLDG', 'BUILDING']);

/** Abbreviated compass points, which trail the street type rather than replace it. */
const DIRECTIONAL = new Set(['N', 'S', 'E', 'W', 'NE', 'NW', 'SE', 'SW']);

/**
 * The queries to ask the roll for, broadest last.
 *
 * The search was previously given the address exactly as we hold it, which is the one form
 * least likely to work: "33 Hummingbird Ct" returns nothing, while "33 HUMMINGBIRD COURT"
 * returns the property. The roll spells its suffixes out and we abbreviate them, so every
 * abbreviated address — 46 of 62 cards in C1 — was asking for a street that, as far as the
 * search was concerned, does not exist.
 *
 * The last form drops the suffix and the unit entirely. That is Frank's fallback and it is
 * deliberately last: "73 OVERLOOK" finds the building when "73 OVERLOOK WAY" finds nothing,
 * but it also returns every unit in it, so it is only safe behind the match test below.
 *
 * ── Why the broad form is now built by word, not by regex ───────────────────
 * It used to strip a trailing suffix by matching the canonical words against the end of the
 * string, which quietly did nothing for the two cases that needed it most. An abbreviation
 * missing from STREET_SUFFIX left the short form in place ("20 OXFORD KY"), so the strip
 * found no canonical word to remove and the fallback came out identical to the exact query —
 * the roll was asked the same failing question twice and the one that works, "20 OXFORD",
 * was never sent. A trailing directional did the same thing ("138 COACHMAN DRIVE N"), since
 * the suffix was no longer last.
 *
 * Popping words handles both: the directional comes off, then the street type. Never below
 * two words, so a bare house number is never sent — that would return the whole street.
 */
export function searchQueries(street: string): string[] {
  const norm = normalizeStreet(street);
  const raw = String(street ?? '').trim();
  const words = norm.replace(/\s+UNIT\s+\S+\s*$/, '').trim().split(' ');
  if (words.length > 2 && DIRECTIONAL.has(words[words.length - 1])) words.pop();
  if (words.length > 2 && SUFFIX_WORDS.has(words[words.length - 1])) words.pop();
  const numberAndName = words.join(' ').trim();
  return [...new Set([norm, raw, numberAndName].filter(Boolean))];
}

/** The canonical long forms, for recognising a street type wherever it has been expanded. */
const SUFFIX_WORDS = new Set(Object.values(STREET_SUFFIX));

// ── Lookup ──────────────────────────────────────────────────────────────────

/** Trim the fixed-width padding the tax roll returns on every field. */
const clean = (v: unknown) => String(v ?? '').replace(/\s+/g, ' ').trim();

/**
 * Look up a property by street address, trying each municipality that shares the ZIP
 * and each roll (property tax, then utility) until one has it.
 * Returns the matching records plus which town they came from; null if nowhere.
 */
export type TaxRollLookup =
  | { outcome: 'found'; records: TaxRollRecord[]; municipality: Municipality }
  /** Every roll answered, none of them holds this address. A fact about the property. */
  | { outcome: 'not_found' }
  /**
   * The building is on the roll but we cannot tell which unit is ours. Frank, item 9:
   * these get flagged to him rather than resolved by picking one.
   */
  | { outcome: 'ambiguous'; candidates: TaxRollRecord[]; municipality: Municipality }
  /** No roll is configured for this ZIP. We cannot know either way. */
  | { outcome: 'unsupported' }
  /** At least one roll could not be reached. We cannot know either way. */
  | { outcome: 'unavailable'; errors: string[] };

export async function lookupTaxRoll(
  street: string,
  zip: string,
): Promise<TaxRollLookup> {
  const munis = WIPP_BY_ZIP[String(zip ?? '').trim()];
  if (!munis?.length || !String(street ?? '').trim()) return { outcome: 'unsupported' };
  const want = normalizeStreet(street);
  const queries = searchQueries(street);
  /** Rolls that errored rather than answering "no". */
  const failures: string[] = [];
  /**
   * Near misses from the broadest query — same building, and we could not tell which unit.
   *
   * Collected rather than discarded so the caller can say so. Frank, item 9: accept the
   * fallback "only when exactly one parcel or unit comes back; otherwise flag it to me".
   * Silently picking the first of four would put a neighbour's name on the card.
   */
  const nearby: Array<{ record: TaxRollRecord; municipality: Municipality }> = [];

  for (const muni of munis) {
    for (const endpoint of SEARCH_ENDPOINTS) {
      for (const query of queries) {
      const url = `${API_ROOT}${endpoint.path}?propertyLoc=${encodeURIComponent(query)}${endpoint.extra}&size=50`;
      assertSafeUrl(url);

      let json: any;
      try {
        json = await throttled(async () => {
          const res = await fetch(url, {
            method: 'GET',
            headers: { Accept: 'application/json, text/plain, */*', 'X-Wipp-Id': muni.wippId },
            signal: AbortSignal.timeout(15000),
          });
          if (!res.ok) throw new Error(`Tax roll lookup failed (${res.status})`);
          return res.json();
        });
      } catch (err) {
        // Remember WHY this attempt produced nothing. Swallowing it and carrying on made
        // an outage indistinguishable from an absence: the lookup returned null either
        // way, and the caller then recorded "this property is not on the tax roll" —
        // a permanent, wrong fact about the property.
        //
        // Observed in practice: the roll answers 403 to some clients, and a run against it
        // produced a page of empty results that read exactly like genuine misses.
        failures.push(`${muni.town}/${endpoint.kind}: ${(err as Error)?.message ?? 'request failed'}`);
        continue; // still try the next roll / town — one being down does not mean all are
      }

      const rows: any[] = Array.isArray(json) ? json : (json?.content ?? []);
      const parsed = rows
        .map((r) => ({ ownerName: clean(r?.ownerName), propertyLoc: clean(r?.propertyLoc), accountId: clean(r?.accountId) }))
        .filter((r) => r.ownerName);

      // The search is fuzzy — only trust records whose address actually matches ours,
      // otherwise we could verify against a neighbouring property.
      const hits = parsed.filter((r) => normalizeStreet(r.propertyLoc) === want);
      if (hits.length) return { outcome: 'found', records: hits, municipality: muni };

      /**
       * Same building, different unit — or the same street with no unit on our side.
       * Held back for the ambiguity test rather than treated as a miss.
       */
      for (const r of parsed) {
        if (sameBuilding(r.propertyLoc, street)) nearby.push({ record: r, municipality: muni });
      }
      }
    }
  }

  /**
   * Frank's last resort, with his condition on it.
   *
   * One parcel back means we found the property under a spelling we did not predict, and
   * that is a real answer. More than one means we found the BUILDING — "73 Overlook" returns
   * units A, B, C and D — and which of those is our household is exactly what we were trying
   * to establish. He asked for those to come to him, so they are reported, not guessed.
   */
  const distinct = new Map(nearby.map((n) => [normalizeStreet(n.record.propertyLoc), n]));
  if (distinct.size === 1) {
    const only = [...distinct.values()][0];
    return { outcome: 'found', records: [only.record], municipality: only.municipality };
  }
  if (distinct.size > 1) {
    return {
      outcome: 'ambiguous',
      candidates: [...distinct.values()].map((n) => n.record),
      municipality: [...distinct.values()][0].municipality,
    };
  }

  // Only claim the property is absent when every roll actually answered. If any attempt
  // errored, the truthful answer is "we do not know".
  return failures.length ? { outcome: 'unavailable', errors: failures } : { outcome: 'not_found' };
}

/**
 * Same house number and street, whatever each side calls the unit.
 *
 * Used only to decide whether a row is worth holding for the ambiguity test above — never
 * to accept a match, which still requires the full normalised address to be equal.
 */
function sameBuilding(a: string, b: string): boolean {
  const key = (s: string) => normalizeStreet(s).replace(/\s+UNIT\s+\S+\s*$/, '').trim();
  const ka = key(a);
  const kb = key(b);
  if (!ka || !kb) return false;
  if (ka === kb) return true;

  /**
   * One side carries a street type the other never had.
   *
   * Our source holds four Monroe addresses as bare "1136 Vanderbergh" with no type at all,
   * and the broad query deliberately drops the type — so the roll answers "1136 VANDERBERGH
   * AVENUE" to a question asked as "1136 VANDERBERGH" and strict equality threw it away.
   * That made the fallback unable to use its own result.
   *
   * Deliberately narrow: the house number must be identical, the shorter address must be a
   * whole-word prefix of the longer, and the longer may run to exactly one extra word. A
   * substring test would read "20 OXFORD" into "20 OXFORDSHIRE", and allowing two extra
   * words would reach across genuinely different streets.
   *
   * This only decides whether a row is worth HOLDING for the ambiguity test. Two different
   * streets that both extend our address still come back as two parcels, which is Frank's
   * case 9 — reported to him rather than resolved by picking one.
   */
  const wa = ka.split(' ');
  const wb = kb.split(' ');
  if (wa[0] !== wb[0]) return false;
  const [short, long] = wa.length <= wb.length ? [wa, wb] : [wb, wa];
  if (short.length < 2 || long.length - short.length > 1) return false;
  return short.every((w, i) => long[i] === w);
}

/**
 * Verify one lead's insured name against the tax roll.
 * Returns null when the town isn't supported or the property isn't on the roll —
 * callers should leave the lead unverified rather than record a false negative.
 */
export async function verifyOwnerName(lead: {
  addressStreet?: string | null;
  addressZip?: string | null;
  owner1FirstName?: string | null;
  owner1LastName?: string | null;
}): Promise<OwnerVerification | {
  status: 'not_found' | 'unsupported' | 'unavailable' | 'ambiguous';
  detail: string;
}> {
  const zip = String(lead.addressZip ?? '').trim();
  if (!WIPP_BY_ZIP[zip]?.length) {
    return { status: 'unsupported', detail: `No tax roll is configured for ZIP ${zip || '(none)'}.` };
  }

  const lookup = await lookupTaxRoll(String(lead.addressStreet ?? ''), zip);

  // "We could not reach the roll" is NOT "the property is not on the roll". Returning the
  // two as one value is what let an outage be written down as a verification failure.
  if (lookup.outcome === 'unavailable') {
    return {
      status: 'unavailable',
      detail: `Tax roll could not be reached: ${lookup.errors.slice(0, 2).join('; ')}`,
    };
  }
  if (lookup.outcome === 'unsupported') {
    return { status: 'unsupported', detail: `No tax roll is configured for ZIP ${zip}.` };
  }
  if (lookup.outcome === 'not_found') {
    return {
      status: 'not_found',
      detail: `No matching property found on the tax roll for "${lead.addressStreet ?? ''}".`,
    };
  }
  /**
   * The building is there; which unit is ours is not established. Frank asked for these
   * rather than a best guess, so the detail names the units found — that list is the whole
   * point of surfacing it, and resolving one by eye takes seconds with it in front of you.
   */
  if (lookup.outcome === 'ambiguous') {
    const locs = lookup.candidates.map((c) => c.propertyLoc).slice(0, 6);
    return {
      status: 'ambiguous',
      detail: `${lookup.candidates.length} units at this address on ${lookup.municipality.town}'s roll `
        + `and none matches "${lead.addressStreet ?? ''}" exactly: ${locs.join(' · ')}`,
    };
  }

  const { records, municipality: muni } = lookup;

  // Compare against every party on the roll and keep the strongest outcome —
  // a property can legitimately be listed under a spouse or co-owner.
  const rank = { match: 3, partial: 2, mismatch: 1, unknown: 0 } as const;
  let best: NameComparison | null = null;
  let bestRecord = records[0];
  for (const rec of records) {
    const cmp = compareOwnerNames({ first: lead.owner1FirstName, last: lead.owner1LastName }, rec.ownerName);
    if (!best || rank[cmp.result] > rank[best.result]) { best = cmp; bestRecord = rec; }
  }
  // Records exist but none could be compared — the roll gave us rows with no usable owner
  // name. Not an absence, so it must not be written down as one.
  if (!best) {
    return { status: 'unavailable', detail: 'Tax roll returned records with no comparable owner name.' };
  }

  return {
    status: best.result,
    detail: best.detail,
    recordName: bestRecord.ownerName,
    source: `${muni.town.toLowerCase()}_tax_roll`,
    checkedAt: new Date(),
  };
}
