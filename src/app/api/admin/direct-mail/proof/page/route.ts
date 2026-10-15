import { NextRequest, NextResponse } from 'next/server';
import { getLetter } from '@/lib/integrations/lob';

/**
 * One page of a proof, as an image.
 *
 *   GET /api/admin/direct-mail/proof/page?letterId=ltr_…&page=1&size=large
 *
 * ── Why this proxies instead of redirecting ─────────────────────────────────
 * The vendor's image URLs are signed and expire within hours. Redirecting would hand the
 * browser a URL that works now and is a broken image tomorrow — including in anything the
 * page caches. Fetching a fresh URL per request and streaming the bytes means a proof looks
 * the same whenever it is opened, and the signature never leaves the server.
 */
export const dynamic = 'force-dynamic';

const SIZES = new Set(['small', 'medium', 'large']);

export async function GET(req: NextRequest) {
  try {
    const p = req.nextUrl.searchParams;
    const letterId = (p.get('letterId') ?? '').trim();
    const page = Math.max(1, Number(p.get('page') ?? 1) || 1);
    const size = SIZES.has(p.get('size') ?? '') ? String(p.get('size')) : 'large';

    // The id is interpolated into a vendor URL, so it is matched rather than trusted.
    if (!/^ltr_[a-zA-Z0-9]+$/.test(letterId)) {
      return NextResponse.json({ success: false, error: 'Not a letter id.' }, { status: 400 });
    }

    const letter = await getLetter(letterId, 'test');
    const thumbs = Array.isArray(letter.thumbnails) ? letter.thumbnails : [];
    const thumb = thumbs[page - 1];
    if (!thumb?.[size]) {
      return NextResponse.json(
        { success: false, error: 'That page has not been rendered yet.' },
        { status: 404 },
      );
    }

    const img = await fetch(thumb[size], { signal: AbortSignal.timeout(20_000) });
    if (!img.ok) {
      return NextResponse.json({ success: false, error: 'The vendor would not serve that page.' }, { status: 502 });
    }

    return new NextResponse(await img.arrayBuffer(), {
      headers: {
        'Content-Type': img.headers.get('content-type') ?? 'image/png',
        // Briefly cacheable so scrolling a multi-page proof does not re-fetch each page,
        // but short enough that a re-rendered letter is not shown stale.
        'Cache-Control': 'private, max-age=60',
      },
    });
  } catch (err) {
    console.error('GET /api/admin/direct-mail/proof/page error:', err);
    return NextResponse.json({ success: false, error: 'Could not load that page' }, { status: 500 });
  }
}
