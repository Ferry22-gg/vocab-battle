import { type NextRequest } from "next/server";
import { updateSession } from "@/lib/supabase/proxy";
import { applyAuthRedirects } from "@/lib/auth/optimistic-guard";

export async function proxy(request: NextRequest) {
  const { response, isAuthenticated } = await updateSession(request);
  return applyAuthRedirects(request, response, isAuthenticated);
}

export const config = {
  matcher: [
    "/((?!_next/static|_next/image|favicon.ico|.*\\.(?:svg|png|jpg|jpeg|gif|webp)$).*)",
  ],
};