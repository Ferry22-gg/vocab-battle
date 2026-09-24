import { redirect } from "next/navigation";
import { getAuthContext } from "@/lib/auth/dal";
import { logout } from "@/app/actions/auth";

// Branches on getAuthContext() directly, the same way /profile-missing
// does, and for the same reason: requireActiveAccount() redirects a
// disabled profile to this exact route, so a page here using it (or any
// require* guard built on it) would redirect to itself. This also means a
// *healthy* account that manually visits /account-disabled gets routed to
// where it actually belongs instead of seeing a stale/wrong message.
export default async function AccountDisabledPage() {
  const ctx = await getAuthContext();

  if (ctx.status === "unauthenticated") {
    redirect("/login");
  }

  if (ctx.status === "profileMissing") {
    redirect("/profile-missing");
  }

  const { profile } = ctx;

  if (profile.accountStatus === "active") {
    redirect(profile.role === "admin" ? "/admin" : "/");
  }

  return (
    <div className="flex flex-1 items-center justify-center bg-zinc-50 px-4 dark:bg-black">
      <div className="w-full max-w-sm rounded-lg border border-zinc-200 bg-white p-8 text-center dark:border-zinc-800 dark:bg-zinc-950">
        <h1 className="mb-2 text-xl font-semibold text-zinc-950 dark:text-zinc-50">
          Account disabled
        </h1>
        <p className="mb-6 text-sm text-zinc-600 dark:text-zinc-400">
          Your account has been disabled. Please contact support if you
          believe this is a mistake.
        </p>
        <form action={logout}>
          <button
            type="submit"
            className="w-full rounded-md bg-zinc-950 px-4 py-2 text-sm font-medium text-white transition-colors hover:bg-zinc-800 dark:bg-zinc-50 dark:text-zinc-950 dark:hover:bg-zinc-200"
          >
            Log out
          </button>
        </form>
      </div>
    </div>
  );
}
