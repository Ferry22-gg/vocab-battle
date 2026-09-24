"use client";

import { useActionState } from "react";
import { setNickname } from "@/app/actions/onboarding";
import { NICKNAME_MAX_LENGTH } from "@/lib/onboarding/constants";

export function NicknameForm() {
  const [state, formAction, pending] = useActionState(setNickname, undefined);

  return (
    <div className="flex flex-1 items-center justify-center bg-zinc-50 px-4 dark:bg-black">
      <form
        action={formAction}
        className="w-full max-w-sm rounded-lg border border-zinc-200 bg-white p-8 dark:border-zinc-800 dark:bg-zinc-950"
      >
        <h1 className="mb-2 text-xl font-semibold text-zinc-950 dark:text-zinc-50">
          Choose a nickname
        </h1>
        <p className="mb-6 text-sm text-zinc-600 dark:text-zinc-400">
          This is how other testers will see you.
        </p>

        <div className="mb-4">
          <label
            htmlFor="nickname"
            className="mb-1 block text-sm font-medium text-zinc-700 dark:text-zinc-300"
          >
            Nickname
          </label>
          <input
            id="nickname"
            name="nickname"
            type="text"
            maxLength={NICKNAME_MAX_LENGTH}
            autoComplete="off"
            required
            className="w-full rounded-md border border-zinc-300 bg-white px-3 py-2 text-zinc-950 focus:outline-none focus:ring-2 focus:ring-zinc-950 dark:border-zinc-700 dark:bg-zinc-900 dark:text-zinc-50 dark:focus:ring-zinc-50"
          />
        </div>

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
          {pending ? "Saving…" : "Continue"}
        </button>
      </form>
    </div>
  );
}
