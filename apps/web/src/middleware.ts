import { NextRequest, NextResponse } from 'next/server';

const API_URL = process.env.API_URL ?? 'http://localhost:4000';

/**
 * Première barrière de Mbolo TV Control.
 * Valide la session owner côté serveur en interrogeant l'API
 * (cookie httpOnly transmis, rôle, expiration, révocation).
 */
export async function middleware(request: NextRequest) {
  const path = request.nextUrl.pathname;
  const protectedPrefix = process.env.OWNER_CONSOLE_PATH;
  const isConsolePath = path === '/control' || path.startsWith('/control/') ||
    (protectedPrefix && path.startsWith(protectedPrefix));

  if (isConsolePath) {
    const ownerSessionCookie = request.cookies.get('mbolo_owner_session');
    if (!ownerSessionCookie) {
      return redirectToLogin(request, path);
    }

    try {
      const response = await fetch(`${API_URL}/api/owner/auth/session`, {
        headers: { cookie: `mbolo_owner_session=${ownerSessionCookie.value}` },
        cache: 'no-store',
        signal: AbortSignal.timeout(10000),
      });
      if (!response.ok) {
        console.warn(`[middleware] session invalide: HTTP ${response.status}`);
        return redirectToLogin(request, path);
      }
      const session = (await response.json()) as { me: { role: string } };
      if (session.me.role !== 'OWNER') {
        return redirectToLogin(request, path);
      }
    } catch (error) {
      console.warn('[middleware] session check failed', error);
      return redirectToLogin(request, path);
    }
  }
  return NextResponse.next();
}

function redirectToLogin(request: NextRequest, path: string): NextResponse {
  const login = new URL(`/owner/login?next=${encodeURIComponent(path)}`, request.url);
  return NextResponse.redirect(login);
}

export const config = { matcher: ['/control/:path*', '/control'] };