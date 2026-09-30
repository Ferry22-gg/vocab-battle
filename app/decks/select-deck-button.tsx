"use client";

import { useActionState } from "react";
import { selectDeckAction } from "@/app/actions/decks";

/**
 * Low-friction inline "Select" affordance (P3 Decks section 5/6): no
 * confirmation screen, used both in the Decks list rows and the Deck
 * detail screen. `deckId` is bound as the action's first argument so
 * `useActionState` only needs to manage the trailing (prevState, formData)
 * pair -- the standard Next.js pattern for passing extra arguments to a
 * Server Action driven by `useActionState`.
 */
export function SelectDeckButton({ deckId, deckName }: { readonly deckId: string; readonly deckName: string }) {
  const [state, formAction, pending] = useActionState(selectDeckAction.bind(null, deckId), undefined);

  return (
    <form action={formAction} className="shrink-0">
      <button
        type="submit"
        disabled={pending}
        aria-label={`Select ${deckName}`}
        className="rounded-full bg-amber-400 px-3.5 py-1.5 text-xs font-bold text-emerald-950 shadow transition-opacity hover:bg-amber-300 disabled:opacity-60"
      >
        {pending ? "Selecting…" : "Select"}
      </button>
      {state?.error && (
        <p role="alert" className="mt-1 max-w-[7.5rem] text-right text-[11px] leading-tight text-red-300">
          {state.error}
        </p>
      )}
    </form>
  );
}
