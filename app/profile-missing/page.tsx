import { redirect } from "next/navigation";
import { getAuthContext } from "@/lib/auth/dal";
import { logout } from "@/app/actions/auth";

// Calls getAuthContext() directly rather than a require* guard: every
// require* function redirects the profileMissing case to this exact route,
// so using one here would redirect this page to itself. Branching on the
// raw AuthContext lets this page redirect a *healthy* profile elsewhere
// (unauthenticated -> /login, active tester -> /, active admin -> /admin,
// disabled -> /account-disabled) while only rendering for the one state
// that actually belongs here: a verified session with no profile row.
export default async function ProfileMissingPage() {
  const ctx = await getAuthContext();

  if (ctx.status === "unauthenticated") {
    redirect("/login");
  }

  if (ctx.status === "authenticated") {
    const { profile } = ctx;

    if (profile.accountStatus !== "active") {
      redirect("/account-disabled");
    }

    redirect(profile.role === "admin" ? "/admin" : "/");
  }

  return (
    <div className="flex flex-1 items-center justify-center bg-zinc-50 px-4 dark:bg-black">
      <div className="w-full max-w-sm rounded-lg border border-zinc-200 bg-white p-8 text-center dark:border-zinc-800 dark:bg-zinc-950">
        <h1 className="mb-2 text-xl font-semibold text-zinc-950 dark:text-zinc-50">
          Account issue
        </h1>
        <p className="mb-6 text-sm text-zinc-600 dark:text-zinc-400">
          We couldn&apos;t find an account profile for your session. Please
          contact support.
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
