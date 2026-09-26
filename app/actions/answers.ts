"use server";

/**
 * Public Server Action surface for answer submission. Deliberately thin:
 * all orchestration (trusted reads, rating/FSRS/battle calculation,
 * commitAnswerTransaction(), result shaping) lives in
 * lib/learning/submit-answer.ts's `runSubmitAnswer` -- this file only
 * resolves the authenticated identity and delegates to it. See that
 * module's header for the full trust-boundary and idempotency contract.
 *
 * `submitAnswer` is defined directly in this file (not re-exported from
 * elsewhere) because Next.js's "use server" directive marks functions
 * *defined in* the directive-carrying file as Server Actions -- a
 * re-export of a function defined in a plain module is not the documented
 * pattern (see node_modules/next/dist/docs/01-app/03-api-reference/
 * 01-directives/use-server.md). `runSubmitAnswer` itself is intentionally
 * NOT exported from this file: its `deps` parameter carries function
 * values, which are not serializable across the Server Action boundary.
 */

import { requireActiveTester } from "@/lib/auth/dal";
import { runSubmitAnswer, defaultSubmitAnswerDeps } from "@/lib/learning/submit-answer";
import type { SubmitAnswerInput, SubmitAnswerResult } from "@/lib/learning/submit-answer";

export type { SubmitAnswerInput, SubmitAnswerResult };

/**
 * Resolves `userId` exclusively from requireActiveTester() -- never from
 * `input`, which has no field for it -- then runs the full trusted
 * answer-submission flow. requireActiveTester() redirects
 * (unauthenticated -> /login, profileMissing -> /profile-missing,
 * disabled -> /account-disabled, admin -> /admin) rather than returning
 * an error; that existing auth DAL behavior is used as-is.
 */
export async function submitAnswer(input: SubmitAnswerInput): Promise<SubmitAnswerResult> {
  const tester = await requireActiveTester();
  return runSubmitAnswer(input, tester.id, defaultSubmitAnswerDeps);
}
