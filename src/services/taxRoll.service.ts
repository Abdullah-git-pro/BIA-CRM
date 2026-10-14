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
  '07726': [
    { wippId: 'WMON', town: 'Manalapan' },    // ~213 of our 241 leads in this ZIP
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
  // Pull only, no WIPP verify: 08857 Old Bridge (in-house SharePoint portal; 1215 empty
  // on the Edmunds API). 08859 (Parlin) is shared Sayreville/Old Bridge — Sayreville side
  // verifies, Old Bridge side won't match and falls through unverified.
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
 */
const STREET_SUFFIX: Record<string, string> = {
  ST: 'STREET', RD: 'ROAD', DR: 'DRIVE', CT: 'COURT', LN: 'LANE', AVE: 'AVENUE', AV: 'AVENUE',
  BLVD: 'BOULEVARD', CIR: 'CIRCLE', TER: 'TERRACE', PL: 'PLACE', PKWY: 'PARKWAY', HWY: 'HIGHWAY',
  SQ: 'SQUARE', TRL: 'TRAIL', WAY: 'WAY',
  // Variants seen on the rolls themselves.
  CRT: 'COURT', CTS: 'COURT', TERR: 'TERRACE', DRV: 'DRIVE', CIRC: 'CIRCLE', CRCL: 'CIRCLE',
  LNE: 'LANE', AVEN: 'AVENUE', BLV: 'BOULEVARD', PKY: 'PARKWAY', PKWAY: 'PARKWAY',
  SQR: 'SQUARE', PLC: 'PLACE', RDG: 'RIDGE', HGTS: 'HEIGHTS', HTS: 'HEIGHTS',
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
    .replace(/[.,]/g, ' ')
    // "#" is a unit marker, not punctuation to be deleted: "24 Deepwater Cir # A".
    .replace(/#\s*/g, ' UNIT ')
    .replace(/\s+/g, ' ')
    .trim();

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

  return base
    .split(' ')
    .map((tok) => STREET_SUFFIX[tok] ?? tok)
    // APT, UNIT, STE and friends all name the same thing. One word, so the comparison is
    // about which unit it is rather than which word the clerk typed.
    .map((tok) => (UNIT_WORD.has(tok) ? 'UNIT' : tok))
    .join(' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/** Every word a municipality might use for the same sub-address. */
const UNIT_WORD = new Set(['APT', 'APARTMENT', 'UNIT', 'STE', 'SUITE', 'BLDG', 'BUILDING']);

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
 */
export function searchQueries(street: string): string[] {
  const norm = normalizeStreet(street);
  const raw = String(street ?? '').trim();
  const numberAndName = norm
    .replace(/\s+UNIT\s+\S+\s*$/, '')
    .replace(new RegExp(`\\s+(${Object.values(STREET_SUFFIX).join('|')})\\s*$`), '')
    .trim();
  return [...new Set([norm, raw, numberAndName].filter(Boolean))];
}

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
  return !!ka && ka === kb;
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
