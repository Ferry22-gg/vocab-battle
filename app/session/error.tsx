"use client";

import Link from "next/link";

/**
 * Route error boundary for /session (Next.js App Router convention).
 * Catches a thrown failure from app/session/page.tsx -- e.g.
 * startOrResumeSession()/getNextSessionCard() hitting a genuine RPC/DB
 * failure -- and shows a generic, safe message rather than the thrown
 * error's own text (which may carry raw DB/service-role detail; see
 * lib/sessions/dal.ts's own "Failed to..." wrapping). `error` is
 * intentionally unused in the rendered output for that reason.
 *
 * Exiting is the only recovery this prototype offers beyond a retry --
 * there is no dedicated "session failed to start" product flow yet
 * (MVP_UI_SPEC.md leaves this unresolved); this is the smallest
 * reversible fallback.
 */
export default function SessionError({ reset }: { error: Error & { digest?: string }; reset: () => void }) {
  return (
    <div className="flex flex-1 items-center justify-center bg-zinc-50 px-4 dark:bg-black">
      <div className="w-full max-w-sm rounded-lg border border-zinc-200 bg-white p-8 text-center dark:border-zinc-800 dark:bg-zinc-950">
        <h1 className="mb-2 text-lg font-semibold text-zinc-950 dark:text-zinc-50">
          Couldn&apos;t load your session
        </h1>
        <p className="mb-6 text-sm text-zinc-600 dark:text-zinc-400">
          Something went wrong. Please try again.
        </p>
        <div className="flex flex-col gap-2">
          <button
            type="button"
            onClick={reset}
            className="w-full rounded-md bg-zinc-950 px-4 py-2 text-sm font-medium text-white transition-colors hover:bg-zinc-800 dark:bg-zinc-50 dark:text-zinc-950 dark:hover:bg-zinc-200"
          >
            Try again
          </button>
          <Link
            href="/"
            className="w-full rounded-md border border-zinc-300 px-4 py-2 text-center text-sm font-medium text-zinc-950 transition-colors hover:bg-zinc-100 dark:border-zinc-700 dark:text-zinc-50 dark:hover:bg-zinc-900"
          >
            Back to Home
          </Link>
        </div>
      </div>
    </div>
  );
}
