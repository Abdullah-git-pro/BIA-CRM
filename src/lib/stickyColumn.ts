import type { SxProps, Theme } from '@mui/material';

/**
 * Keep a table's first column in place while the rest scrolls sideways.
 *
 * ── Why the dense tables are not reflowed into cards ─────────────────────────
 * Several screens here are twenty-plus columns wide and every column is load-bearing:
 * the QC exports, the call-outcome report, the email lists. Stacking those into cards
 * means choosing which four fields survive on a phone, and that choice is different for
 * each of the seventeen QC reports. The honest alternative is to let them scroll, which
 * they already do — every one of those tables is wrapped in `overflowX: 'auto'`.
 *
 * What scrolling loses is the anchor. Swipe three columns right and the row you are
 * reading is a line of figures with no name on it, and you have to swipe back to find out
 * whose house it is. Pinning the first column — the lead, the renewal week, the mailbox —
 * is what makes sideways scrolling usable rather than merely possible.
 *
 * ── Why it costs nothing on a desktop ───────────────────────────────────────
 * A sticky cell only does anything once its container actually scrolls. On a wide screen
 * the table fits, nothing scrolls, and this is inert — so it does not need hiding behind a
 * breakpoint, and there is no second layout to keep in step with the first.
 *
 * ── The background is not decoration ────────────────────────────────────────
 * A sticky cell with a transparent background lets the scrolling columns slide underneath
 * it, which reads as overlapping text rather than as a pinned column. Head cells take the
 * same grey the theme gives every header so the pinned corner does not look pasted on.
 */

/** The theme's own header grey — kept in step with the MuiTableHead override. */
const HEAD_BG = '#f8fafc';

export const stickyFirstColumn: SxProps<Theme> = {
  '& thead th:first-of-type, & tbody td:first-of-type': {
    position: 'sticky',
    left: 0,
    backgroundColor: 'background.paper',
    // Above the ordinary cells sliding past, below the header row.
    zIndex: 2,
    // A seam, so the pinned column reads as held rather than as part of the scroll.
    borderRight: '1px solid',
    borderRightColor: 'divider',
  },
  '& thead th:first-of-type': {
    backgroundColor: HEAD_BG,
    // The header corner sits above both the sticky body cells and the scrolling header.
    zIndex: 3,
  },
};

/**
 * The wrapper a scrolling table needs around it.
 *
 * `WebkitOverflowScrolling` keeps the momentum flick on iOS, which is how anyone actually
 * moves across a wide table on a phone. `overscrollBehaviorX: 'contain'` stops a sideways
 * swipe at the end of the table from being taken as a browser back-gesture — on a table
 * people swipe across repeatedly, that is the difference between reading a report and
 * being thrown off the page.
 */
export const scrollableTable: SxProps<Theme> = {
  overflowX: 'auto',
  WebkitOverflowScrolling: 'touch',
  overscrollBehaviorX: 'contain',
};
