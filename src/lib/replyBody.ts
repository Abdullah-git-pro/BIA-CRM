/**
 * What the person actually wrote, separated from the thread quoted underneath it.
 *
 * ── Why this is one function and not three ──────────────────────────────────
 * Three places needed this and each had grown its own version: the stored excerpt on
 * OutreachEvent, the collapsed preview line in the reply inbox, and the expanded message
 * body. They disagreed, and the disagreement was visible to Ruben — the board showed
 * Michael Odrobinak's reply as one clean sentence while the Replies tab showed the same
 * reply followed by thirty lines of our own campaign copy.
 *
 * ── The bug that caused this ────────────────────────────────────────────────
 * Every version matched the attribution line as `^\s*On .+ wrote:`. Apple Mail writes it
 * INSIDE the quote block:
 *
 *     > On Oct 5, 2026, at 10:54 AM, Anthony Marino <anthony@…> wrote:
 *
 * `\s` does not match `>`, so the marker was never found and nothing was trimmed. The
 * excerpt escaped only because it also cut at "Sent from my", which Michael's iPhone
 * happened to add — a message from a desktop client would have stored the whole chain.
 *
 * So every marker here is tested against the line with its quote prefix removed, and the
 * run of quoted lines is itself a marker, because some clients send the chain with no
 * attribution header at all.
 *
 * No imports and no DOM: the reply inbox is a client component and the webhook is a
 * route handler, and both read this.
 */

/**
 * HTML → plain text with the LINE STRUCTURE intact.
 *
 * ── Why the lines matter more than the words ────────────────────────────────
 * Every marker below is anchored to the start and end of a line, because that is the only
 * thing that distinguishes a sign-off from a sentence: "Sent from my iPhone" alone on a
 * line is a signature, and the same words inside a sentence are not. Collapsing the markup
 * to spaces throws that evidence away and the split can no longer be made.
 *
 * ── The pattern that was wrong in three files ───────────────────────────────
 * `<br\s*\/?>` does not match a `<br>` carrying an attribute, and Apple Mail emits
 * `<br id="lineBreakAtBeginningOfSignature">` — the one break that says where the message
 * ends. It became a space, the sign-off joined the sentence above it, and the excerpt read
 * "…Regards, Michael Sent from my iPhone". Block tags open as well as close a line, so
 * both ends are newlines here; a run of them collapses afterwards.
 *
 * Entities are decoded last, after the tags are gone, so nothing decoded can be read back
 * as markup.
 */
const BLOCK = 'p|div|li|tr|h[1-6]|blockquote|table|ul|ol|section|article';

export function htmlToPlainLines(raw: string | null | undefined): string {
  return String(raw ?? '')
    .replace(/<br\b[^>]*>/gi, '\n')
    .replace(new RegExp(`</?(?:${BLOCK})\\b[^>]*>`, 'gi'), '\n')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/gi, ' ')
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&quot;/gi, '"')
    .replace(/&#39;|&apos;/gi, "'")
    .replace(/&amp;/gi, '&')
    .replace(/[ \t]+/g, ' ')
    .replace(/[ \t]*\n[ \t]*/g, '\n')
    .replace(/\n{3,}/g, '\n\n');
}

export type SplitReply = {
  /** What they wrote this time. */
  body: string;
  /** Quoted history and sign-off — hidden, never discarded. */
  quoted: string;
};

/** The line without its quote prefix, so a marker is found at any nesting depth. */
const unquote = (line: string): string => line.replace(/^[\s>]+/, '').trim();

/**
 * The header a mail client writes above the message it is quoting.
 *
 * Anchored at both ends so a sentence that merely contains "wrote" is not a cut point.
 */
const ATTRIBUTION: RegExp[] = [
  /^On\b.{0,300}\bwrote:$/i,            // Gmail, Apple Mail, most mobile clients
  /^-{2,}\s*Original Message/i,         // Outlook, classic
  /^_{5,}$/,                            // Outlook's divider
  /^-{3,}\s*Forwarded message/i,
  /^ *(Begin forwarded message:)$/i,
];

/**
 * The sender's own sign-off.
 *
 * Hidden for the same reason as the quoted chain: it is not what they said this time, and
 * it is three lines in a two-line message.
 */
const SIGNATURE: RegExp[] = [
  /^--$/,
  /^Sent from my\b/i,
  /^Get Outlook for\b/i,
  /^Sent via\b/i,
];

/** Outlook quotes with a header block and no delimiter, so the block itself is the marker. */
const OUTLOOK_HEADER = /^From:\s/i;
const OUTLOOK_FIELD = /^(Sent|Date|To|Cc|Subject):\s/i;

/**
 * Where the trailing run of ">" lines begins, or -1.
 *
 * Only a run that reaches the end of the message counts. A quoted line in the middle is
 * someone answering point by point, and cutting there would throw away their answers.
 */
function trailingQuoteBlockStart(lines: string[]): number {
  let i = lines.length - 1;
  while (i >= 0 && !lines[i].trim()) i--;
  if (i < 0 || !/^\s*>/.test(lines[i])) return -1;
  while (i >= 0 && (/^\s*>/.test(lines[i]) || !lines[i].trim())) i--;
  return i + 1;
}

export function splitQuotedReply(raw: string | null | undefined): SplitReply {
  const text = String(raw ?? '').replace(/\r\n?/g, '\n');
  if (!text.trim()) return { body: '', quoted: '' };

  const lines = text.split('\n');

  let cut = -1;
  for (let i = 0; i < lines.length; i++) {
    const line = unquote(lines[i]);
    if (!line) continue;

    // Clients wrap a long attribution over two lines, so the pair is tested as well.
    const joined = `${line} ${unquote(lines[i + 1] ?? '')}`.trim();

    const isMarker =
      ATTRIBUTION.some((re) => re.test(line) || re.test(joined))
      || SIGNATURE.some((re) => re.test(line))
      || (OUTLOOK_HEADER.test(line)
          && lines.slice(i + 1, i + 5).some((n) => OUTLOOK_FIELD.test(unquote(n))));

    if (isMarker) { cut = i; break; }
  }

  const quoteStart = trailingQuoteBlockStart(lines);
  if (quoteStart >= 0 && (cut < 0 || quoteStart < cut)) cut = quoteStart;

  if (cut < 0) return { body: text.trim(), quoted: '' };

  const body = lines.slice(0, cut).join('\n').trim();
  const quoted = lines.slice(cut).join('\n').trim();

  /*
   * Never hide the whole message.
   *
   * Somebody who types their answer underneath the quote, or inside it, leaves no text
   * above the cut. Showing "(no text)" and a button would be worse than showing the chain:
   * the one thing this screen exists for is reading what they said.
   */
  if (!body) return { body: text.trim(), quoted: '' };

  return { body, quoted };
}
