"use server";

/**
 * Public Server Action surface for answer submission. Deliberately thin:
 * all orchestration -- including which engine owns this answer -- lives
 * in lib/learning/engine-router.ts's `submitAnswerForEngine` (Runtime
 * Cutover RC-D), which itself routes a legacy session to
 * lib/learning/submit-answer.ts's `runSubmitAnswer`
 * (commit_answer_transaction()) or a v1 session to RC-C's
 * `commitLearningEngineAnswer` by the session's own pinned
 * engine_version. This file only resolves the authenticated identity and
 * delegates. See engine-router.ts's and submit-answer.ts's own headers
 * for the full trust-boundary and idempotency contract.
 *
 * `submitAnswer` is defined directly in this file (not re-exported from
 * elsewhere) because Next.js's "use server" directive marks functions
 * *defined in* the directive-carrying file as Server Actions -- a
 * re-export of a function defined in a plain module is not the documented
 * pattern (see node_modules/next/dist/docs/01-app/03-api-reference/
 * 01-directives/use-server.md). `runSubmitAnswer`/`submitAnswerForEngine`
 * themselves are intentionally NOT exported from this file: a `deps`
 * parameter carrying function values is not serializable across the
 * Server Action boundary.
 */

import { requireActiveTester } from "@/lib/auth/dal";
import { submitAnswerForEngine } from "@/lib/learning/engine-router";
import type { SubmitAnswerInput, SubmitAnswerResult } from "@/lib/learning/submit-answer";

export type { SubmitAnswerInput, SubmitAnswerResult };

/**
 * Resolves `userId` exclusively from requireActiveTester() -- never from
 * `input`, which has no field for it -- then routes the full trusted
 * answer-submission flow by this answer's session's own engine_version.
 * requireActiveTester() redirects (unauthenticated -> /login,
 * profileMissing -> /profile-missing, disabled -> /account-disabled,
 * admin -> /admin) rather than returning an error; that existing auth DAL
 * behavior is used as-is. The client never supplies, and this action
 * never trusts, an engine_version -- only `input`'s documented browser
 * fields (clientEventId, sessionId, cardId, correct, responseTimeMs,
 * claimId) ever cross this boundary.
 */
export async function submitAnswer(input: SubmitAnswerInput): Promise<SubmitAnswerResult> {
  const tester = await requireActiveTester();
  return submitAnswerForEngine(input, tester.id);
}
