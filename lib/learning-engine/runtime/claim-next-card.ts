import "server-only";

/**
 * Learning Engine v1 -- Runtime Cutover RC-B: `claimNextLearningEngineCard`,
 * the trusted server-only orchestration function composing the already-
 * complete `chooseNextCard()` pure scheduler with the trusted read/claim
 * RPCs (lib/learning-engine/runtime/{snapshot-mapper,claim-dal}.ts).
 *
 * Source of truth: the RC-B task brief, section 8 ("READ -> DECIDE ->
 * CLAIM orchestration").
 *
 * Flow per call:
 *   FAST PATH -- if the session already has an OPEN claim (returned
 *     inline by the snapshot RPC), return it unchanged. chooseNextCard()
 *     is never invoked for this outcome: no admission is (re-)decided, no
 *     first-pass queue/shuffle bag is consumed again, no second trace is
 *     created, scheduler_revision does not move.
 *   A. READ -- the trusted snapshot RPC, mapped+validated by the pure
 *     snapshot-mapper.
 *   B. DECIDE -- chooseNextCard(snapshot, random), zero DB access inside.
 *   C. CLAIM -- the trusted claim RPC, passed the decision plus the
 *     snapshot's scheduler_position/scheduler_revision as the optimistic-
 *     concurrency token.
 *
 * On a stale-revision rejection (claim-dal.ts's STALE_SNAPSHOT_SQLSTATE):
 * re-read, re-run chooseNextCard() against the fresh snapshot, retry the
 * claim. Bounded at MAX_CLAIM_ATTEMPTS -- never an unbounded loop. Every
 * OTHER rejection (a referenced entity failed independent revalidation,
 * ownership mismatch, etc.) propagates immediately, unretried -- this is a
 * deliberate, narrower retry scope than "any claim failure", matching the
 * brief's own literal text ("On stale revision: ... retry"), not silently
 * widened to paper over a different class of failure.
 *
 * A stale-state retry always recomputes `chooseNextCard()` from the fresh
 * snapshot -- it never attempts to reuse a stale decision's random draws
 * (brief section 9: "do not attempt to reuse a stale decision merely to
 * preserve its earlier random result").
 *
 * Isolation: not imported by app/session/*, get_next_session_card(), or
 * any live Server Action. This is the primitive a future RC-D is expected
 * to call, not a live code path today.
 */

import { chooseNextCard, type RandomSource } from "@/lib/learning-engine/scheduler/next-card";
import { mapRawSchedulerSnapshot } from "@/lib/learning-engine/runtime/snapshot-mapper";
import {
  claimNextLearningEngineCardRpc,
  fetchSchedulerSnapshot,
  LearningEngineClaimError,
  STALE_SNAPSHOT_SQLSTATE,
} from "@/lib/learning-engine/runtime/claim-dal";
import { productionRandomSource } from "@/lib/learning-engine/runtime/random-source";
import { serializeSelectionTrace } from "@/lib/learning-engine/telemetry/selection-trace";

export { LearningEngineClaimError };

/** Brief section 8: "Use a small bounded retry count, e.g. 3. Do not loop indefinitely." */
export const MAX_CLAIM_ATTEMPTS = 3;

export interface ClaimNextLearningEngineCardResult {
  readonly reused: boolean;
  readonly cardId: string | null;
  readonly claimId: string | null;
  readonly selectionTraceId: string | null;
  readonly schedulerPosition: number;
  readonly schedulerRevision: number;
}

export class ClaimRetryExhaustedError extends Error {
  constructor(attempts: number, cause: unknown) {
    super(`claimNextLearningEngineCard: exceeded ${attempts} bounded retry attempts under persistent stale-revision conflicts`, { cause });
    this.name = "ClaimRetryExhaustedError";
  }
}

function isStaleSnapshotError(err: unknown): boolean {
  return err instanceof LearningEngineClaimError && err.code === STALE_SNAPSHOT_SQLSTATE;
}

/**
 * The trusted runtime primitive. `random` defaults to the production
 * RandomSource (Math.random, matching this codebase's own established
 * convention -- see random-source.ts) but is overridable for deterministic
 * tests.
 */
export async function claimNextLearningEngineCard(
  userId: string,
  sessionId: string,
  random: RandomSource = productionRandomSource,
): Promise<ClaimNextLearningEngineCardResult> {
  let lastStaleError: unknown;

  for (let attempt = 1; attempt <= MAX_CLAIM_ATTEMPTS; attempt += 1) {
    const raw = await fetchSchedulerSnapshot(userId, sessionId);

    if (raw.openClaim !== null) {
      return {
        reused: true,
        cardId: raw.openClaim.cardId,
        claimId: raw.openClaim.id,
        selectionTraceId: raw.openClaim.selectionTraceId,
        schedulerPosition: raw.openClaim.schedulerPosition,
        schedulerRevision: raw.openClaim.schedulerRevision,
      };
    }

    const snapshot = mapRawSchedulerSnapshot(raw);
    const decision = chooseNextCard(snapshot, random);

    const traceId = crypto.randomUUID();
    const payload = serializeSelectionTrace({
      trace: decision.trace,
      context: { traceId, userId, deckId: snapshot.deckId, sessionId, selectedAt: snapshot.now },
    });

    try {
      const result = await claimNextLearningEngineCardRpc({
        userId,
        sessionId,
        deckId: snapshot.deckId,

        expectedSchedulerPosition: snapshot.deckState.schedulerPosition,
        expectedSchedulerRevision: snapshot.deckState.schedulerRevision,

        cardId: decision.cardId,
        source: decision.source,
        selectionReason: decision.selectionReason,
        admittedCardIds: decision.admittedCardIds,
        firstPassQueueBefore: decision.trace.firstPassQueueBefore,
        firstPassQueueAfter: decision.firstPassQueueAfter,
        postMasteryShuffleBagBefore: decision.trace.postMasteryShuffleBagBefore,
        postMasteryShuffleBagAfter: decision.postMasteryShuffleBagAfter,

        traceId,
        occurredAt: payload.occurredAt,
        schedulerMode: payload.schedulerMode,
        dueCount: payload.dueCount,
        dailyGoalCompleteBefore: payload.dailyGoalCompleteBefore,
        candidateCountActive: payload.candidateCountActive,
        candidateCountDue: payload.candidateCountDue,
        candidateCountNear: payload.candidateCountNear,
        candidateCountRandomMastered: payload.candidateCountRandomMastered,
        sourceWeightActiveRaw: payload.sourceWeightActiveRaw,
        sourceWeightDueRaw: payload.sourceWeightDueRaw,
        sourceWeightNearRaw: payload.sourceWeightNearRaw,
        sourceWeightRandomMasteredRaw: payload.sourceWeightRandomMasteredRaw,
        sourceWeightActiveNormalized: payload.sourceWeightActiveNormalized,
        sourceWeightDueNormalized: payload.sourceWeightDueNormalized,
        sourceWeightNearNormalized: payload.sourceWeightNearNormalized,
        sourceWeightRandomMasteredNormalized: payload.sourceWeightRandomMasteredNormalized,
        cardPriorityWeight: payload.cardPriorityWeight,
        retrievability: payload.retrievability,
        intervalProgress: payload.intervalProgress,
        emergencyFallbackApplied: payload.emergencyFallbackApplied,
        randomDraws: payload.randomDraws,
        policyVersion: payload.policyVersion,
        tracePayload: payload.tracePayload,
      });

      if (result.reused) {
        const claim = result.claim;
        if (claim === null) {
          throw new Error("claimNextLearningEngineCard: RPC reported reused=true but returned no claim row");
        }
        return {
          reused: true,
          cardId: claim.card_id,
          claimId: claim.id,
          selectionTraceId: claim.selection_trace_id,
          schedulerPosition: claim.scheduler_position,
          schedulerRevision: claim.scheduler_revision,
        };
      }

      return {
        reused: false,
        cardId: result.claim?.card_id ?? null,
        claimId: result.claim?.id ?? null,
        selectionTraceId: result.trace?.id ?? null,
        schedulerPosition: snapshot.deckState.schedulerPosition,
        schedulerRevision: result.schedulerRevision,
      };
    } catch (err) {
      if (isStaleSnapshotError(err)) {
        lastStaleError = err;
        continue;
      }
      throw err;
    }
  }

  throw new ClaimRetryExhaustedError(MAX_CLAIM_ATTEMPTS, lastStaleError);
}
