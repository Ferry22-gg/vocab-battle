import Link from "next/link";
import { requireOnboardedTester } from "@/lib/auth/dal";
import { getDeckById } from "@/lib/decks/dal";
import { logout } from "@/app/actions/auth";

// requireOnboardedTester() is the single gate for this route: it already
// enforces unauthenticated -> /login, profile-missing -> /profile-missing,
// disabled -> /account-disabled, admin -> /admin, no nickname ->
// /onboarding/nickname, and onboarding incomplete -> /onboarding/deck.
// Only a fully onboarded active tester ever reaches the render below.
export default async function HomePage() {
  const tester = await requireOnboardedTester();

  // selectedDeckId is guaranteed set by the guard above, but the deck row
  // itself is supplementary display info -- if loading it fails, show the
  // rest of the page rather than taking down all of Home over it.
  const deck = tester.selectedDeckId
    ? await getDeckById(tester.selectedDeckId).catch(() => null)
    : null;

  return (
    <div className="flex flex-1 items-center justify-center bg-zinc-50 px-4 dark:bg-black">
      <div className="w-full max-w-sm rounded-lg border border-zinc-200 bg-white p-8 dark:border-zinc-800 dark:bg-zinc-950">
        <h1 className="mb-1 text-xl font-semibold text-zinc-950 dark:text-zinc-50">
          Welcome, {tester.nickname}
        </h1>
        <p className="mb-6 text-sm text-zinc-600 dark:text-zinc-400">
          Tester ID {tester.publicUserId}
        </p>

        {/*
          Zero-Cognitive-Load (MVP_UI_SPEC.md 2.2/8.3): a single obvious
          CTA, no "New session or Resume?" choice on this screen -- /session
          itself calls startOrResumeSession() (no deck argument) and
          transparently resumes any existing active session or starts a
          new one against the tester's selected deck.
        */}
        <Link
          href="/session"
          className="mb-6 block w-full rounded-md bg-indigo-600 px-4 py-3 text-center text-sm font-semibold text-white transition-colors hover:bg-indigo-500 dark:bg-indigo-500 dark:hover:bg-indigo-400"
        >
          SESSION START
        </Link>

        <div className="mb-6 rounded-md border border-zinc-200 p-3 dark:border-zinc-800">
          <p className="text-xs font-medium uppercase tracking-wide text-zinc-500 dark:text-zinc-500">
            Selected deck
          </p>
          <p className="mt-1 text-sm text-zinc-950 dark:text-zinc-50">
            {deck ? deck.name : "Unavailable"}
          </p>
        </div>

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
