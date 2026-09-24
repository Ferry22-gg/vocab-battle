"use client";

import { useActionState } from "react";
import { selectStarterDeck } from "@/app/actions/onboarding";
import type { StarterDeck } from "@/lib/decks/dal";

export function DeckForm({ decks }: { decks: StarterDeck[] }) {
  const [state, formAction, pending] = useActionState(
    selectStarterDeck,
    undefined
  );

  return (
    <div className="flex flex-1 items-center justify-center bg-zinc-50 px-4 dark:bg-black">
      <form
        action={formAction}
        className="w-full max-w-sm rounded-lg border border-zinc-200 bg-white p-8 dark:border-zinc-800 dark:bg-zinc-950"
      >
        <h1 className="mb-2 text-xl font-semibold text-zinc-950 dark:text-zinc-50">
          Pick a starter deck
        </h1>
        <p className="mb-6 text-sm text-zinc-600 dark:text-zinc-400">
          You can build your own decks later -- this just gets you started.
        </p>

        <fieldset className="mb-4 space-y-3">
          <legend className="sr-only">Starter deck</legend>
          {decks.map((deck) => (
            <label
              key={deck.id}
              className="flex cursor-pointer items-start gap-3 rounded-md border border-zinc-300 p-3 has-[:checked]:border-zinc-950 dark:border-zinc-700 dark:has-[:checked]:border-zinc-50"
            >
              <input
                type="radio"
                name="deckId"
                value={deck.id}
                required
                className="mt-1"
              />
              <span>
                <span className="block text-sm font-medium text-zinc-950 dark:text-zinc-50">
                  {deck.name}
                </span>
                {deck.description && (
                  <span className="block text-sm text-zinc-600 dark:text-zinc-400">
                    {deck.description}
                  </span>
                )}
              </span>
            </label>
          ))}
        </fieldset>

        {state?.error && (
          <p
            role="alert"
            className="mb-4 text-sm text-red-600 dark:text-red-400"
          >
            {state.error}
          </p>
        )}

        <button
          type="submit"
          disabled={pending}
          className="w-full rounded-md bg-zinc-950 px-4 py-2 text-sm font-medium text-white transition-colors hover:bg-zinc-800 disabled:opacity-60 dark:bg-zinc-50 dark:text-zinc-950 dark:hover:bg-zinc-200"
        >
          {pending ? "Setting up…" : "Continue"}
        </button>
      </form>
    </div>
  );
}
