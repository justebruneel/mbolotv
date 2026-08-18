import { NextRequest, NextResponse } from 'next/server';

const API_URL = process.env.API_URL ?? 'http://localhost:4000';

export async function middleware(request: NextRequest) {
  const path = request.nextUrl.pathname;
  const protectedPrefix = normalizePrefix(process.env.OWNER_CONSOLE_PATH);
  const isConsolePath = path === '/control' || path.startsWith('/control/') || Boolean(protectedPrefix && (path === protectedPrefix || path.startsWith(`${protectedPrefix}/`)));

  if (!isConsolePath || path === '/owner/login') return NextResponse.next();

  const ownerSessionCookie = request.cookies.get('mbolo_owner_session');
  if (!ownerSessionCookie) return redirectToLogin(request, path);

  try {
    const response = await fetch(`${API_URL}/api/owner/auth/session`, {
      headers: { cookie: `mbolo_owner_session=${ownerSessionCookie.value}` },
      cache: 'no-store',
      signal: AbortSignal.timeout(10000),
    });
    if (!response.ok) return redirectToLogin(request, path);
    const session = (await response.json()) as { me?: { role?: string } };
    if (session.me?.role !== 'OWNER') return redirectToLogin(request, path);
  } catch {
    return redirectToLogin(request, path);
  }
  return NextResponse.next();
}

function normalizePrefix(value: string | undefined): string | undefined {
  if (!value) return undefined;
  const normalized = value.trim().replace(/^\/+/, '').replace(/\/+$/, '');
  return normalized ? `/${normalized}` : undefined;
}

function redirectToLogin(request: NextRequest, path: string): NextResponse {
  const login = new URL(`/owner/login?next=${encodeURIComponent(path)}`, request.url);
  return NextResponse.redirect(login);
}

export const config = { matcher: ['/:path*'] };
