import { NextResponse, type NextRequest } from "next/server";

/**
 * Optimistic route protection: a cheap, cookie/JWT-only allow/redirect
 * decision made in Proxy, with no DB query. This is UX-level routing only
 * -- it is not the security boundary. Every protected Server Component,
 * Server Action, and Route Handler must still call lib/auth/dal.ts's
 * require* functions, which remain authoritative (role, account_status,
 * and onboarding state all live in public.profiles, which Proxy never
 * reads).
 *
 * /onboarding/nickname, /onboarding/deck, /admin, /account-disabled, and
 * /profile-missing are all intentionally left out of PUBLIC_PATHS: each
 * must stay reachable by any authenticated JWT holder (Proxy has no
 * opinion on role/account_status/onboarding state -- that routing is the
 * DAL's job, see lib/auth/dal.ts) without Proxy bouncing them back to "/"
 * the way it does for /login, while still turning away an unauthenticated
 * visitor via the ordinary `needsLogin` path. Treating them as just more
 * protected routes gets both for free, with no change needed here.
 */

const PUBLIC_PATHS = new Set<string>(["/login"]);

export function applyAuthRedirects(
  request: NextRequest,
  response: NextResponse,
  isAuthenticated: boolean
): NextResponse {
  const path = request.nextUrl.pathname;
  const isPublicPath = PUBLIC_PATHS.has(path);

  const needsLogin = !isAuthenticated && !isPublicPath;
  const needsHome = isAuthenticated && isPublicPath;

  if (!needsLogin && !needsHome) {
    return response;
  }

  const url = request.nextUrl.clone();
  url.pathname = needsLogin ? "/login" : "/";
  // Drop the original request's query string -- it belongs to the page
  // that was requested, not to /login or "/", and carrying it over would
  // leak unrelated params onto the redirect target.
  url.search = "";

  const redirectResponse = NextResponse.redirect(url);

  // Carry over any cookies updateSession() refreshed on `response` (e.g. a
  // rotated session cookie) -- swapping in a bare NextResponse.redirect()
  // here would otherwise silently drop them.
  response.cookies.getAll().forEach((cookie) => {
    redirectResponse.cookies.set(cookie);
  });

  return redirectResponse;
}
