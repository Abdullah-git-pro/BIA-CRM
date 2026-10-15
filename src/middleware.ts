import { NextRequest, NextResponse } from 'next/server';
import { jwtVerify } from 'jose';

const JWT_SECRET = new TextEncoder().encode(
  process.env.JWT_SECRET || 'bia-crm-secret-change-in-production-2026'
);

// '/api/webhooks/campaign' is public by necessity — the campaign platform cannot
// authenticate as a CRM user. It carries its own auth instead: a shared secret on
// the x-bia-campaign-key header, compared in constant time, failing closed in
// production. Nothing else should be added here without an equivalent check.
// '/c/' is the public CTA landing page and '/api/cta/' its confirm endpoint
// (playbook §05). Both are reached from a homeowner's email, so neither can require a
// session — the signed link token is the only credential, and it is verified in the route.
// '/api/cron/' is Vercel Cron, which presents `Authorization: Bearer $CRON_SECRET` and
// has no CRM session to offer. Each route under it verifies that secret in constant time
// and fails closed in production — see outreach-reconcile. The same rule as above holds:
// nothing joins this list without carrying its own equivalent check.
// '/api/webhooks/lob' is public for the same reason as the campaign one: the print vendor
// delivers tracking events — in transit, delivered, returned to sender — and has no CRM
// session to present. It carries its own auth, and a stronger one: every request is signed
// HMAC-SHA256 over `${timestamp}.${rawBody}` with the webhook secret, compared in constant
// time, with a five-minute replay window. A missing secret verifies nothing and therefore
// refuses everything, so it fails closed. It is the only separation between a real delivery
// and a forged one — and a forged 'returned_to_sender' would retire a good address.
const PUBLIC_PATHS = ['/login', '/api/auth/login', '/api/enrich', '/api/webhooks/campaign', '/api/webhooks/lob', '/c/', '/api/cta/', '/api/cron/'];

export async function middleware(request: NextRequest) {
  const { pathname } = request.nextUrl;

  // Allow public paths through
  if (PUBLIC_PATHS.some((p) => pathname.startsWith(p))) {
    return NextResponse.next();
  }

  // Allow internal Next.js assets
  if (pathname.startsWith('/_next') || pathname.startsWith('/favicon')) {
    return NextResponse.next();
  }

  const token = request.cookies.get('bia_session')?.value;

  if (!token) {
    // API routes return 401; page routes redirect to login
    if (pathname.startsWith('/api/')) {
      return NextResponse.json({ success: false, error: 'Not authenticated' }, { status: 401 });
    }
    return NextResponse.redirect(new URL('/login', request.url));
  }

  try {
    const { payload } = await jwtVerify(token, JWT_SECRET);

    // Guard /admin routes:
    //   • User management (/admin/users) → superadmin only (manages roles/admins).
    //   • Other admin pages (Weekly Pull, Seed) → superadmin + admin.
    //   • Regular users (BIA producers) → leads-only, no admin pages.
    const isUserMgmt = pathname.startsWith('/admin/users') || pathname.startsWith('/api/admin/users');
    const isAdminArea = pathname.startsWith('/admin') || pathname.startsWith('/api/admin');
    const allowed = isUserMgmt
      ? payload.role === 'superadmin'
      : isAdminArea
        ? (payload.role === 'superadmin' || payload.role === 'admin')
        : true;
    if (!allowed) {
      if (pathname.startsWith('/api/')) {
        return NextResponse.json({ success: false, error: 'Forbidden' }, { status: 403 });
      }
      return NextResponse.redirect(new URL('/', request.url));
    }

    return NextResponse.next();
  } catch {
    if (pathname.startsWith('/api/')) {
      return NextResponse.json({ success: false, error: 'Session expired' }, { status: 401 });
    }
    const response = NextResponse.redirect(new URL('/login', request.url));
    response.cookies.delete('bia_session');
    return response;
  }
}

export const config = {
  matcher: ['/((?!_next/static|_next/image|favicon.ico).*)'],
};
