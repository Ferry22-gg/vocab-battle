/**
 * Learning Engine v1 -- Runtime Cutover RC-A: deterministic seeded
 * randomness for the one-time legacy-normalization script.
 *
 * Approved Runtime Cutover plan, clarification 2 ("Deterministic RNG for
 * normalization"): the one-time normalization of a legacy FORGOTTEN
 * card into a complete v1 RepairObligation must NOT consume
 * nondeterministic process randomness (`Math.random`). Re-running the
 * normalization script against the same input must reproduce the exact
 * same sampled repair target every time -- "retrying normalization
 * cannot silently change the obligation."
 *
 * This module does nothing scheduling-specific: it is a generic,
 * deterministic string -> RandomSource builder, reused across every
 * cutover-only caller. `lib/learning-engine/repair-scheduler.ts`'s
 * `createRepairObligation()` remains the only repair-obligation
 * constructor -- this module only supplies that function's `random`
 * parameter deterministically instead of via `Math.random`, exactly the
 * same role tests' own `scriptedRandom`/`lcg` helpers already play in
 * this codebase's test suite (see e.g.
 * tests/unit/learning-engine-repair-scheduler.test.ts), just promoted to
 * a shared, production (non-test) module since RC-A's normalization
 * script is a genuine one-time production caller, not a test.
 *
 * Pure and side-effect free throughout: no database access, no clock
 * reads, no module-level mutable state (every call to
 * `createDeterministicRandom` returns an independent closure over its
 * own local `state` variable).
 */

export type RandomSource = () => number;

/**
 * FNV-1a (32-bit) string hash. Deterministic and well-distributed for
 * this use (turning a short, structured seed string like
 * "learning-engine-v1.0:deck-123:card-456" into a numeric LCG seed) --
 * not used for anything security-sensitive, so FNV-1a's known
 * non-cryptographic weaknesses are irrelevant here.
 */
function hashSeedString(seed: string): number {
  let hash = 0x811c9dc5;
  for (let i = 0; i < seed.length; i++) {
    hash ^= seed.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193);
  }
  return hash >>> 0;
}

/**
 * Builds a deterministic `RandomSource` from a stable seed string. Same
 * LCG recurrence already used by this codebase's own test helpers
 * (`lcg(seed)` in tests/unit/learning-engine-*.test.ts) -- not a new
 * algorithm, just the production-module home for it. The hashed seed is
 * coerced away from exactly 0 (an LCG with state 0 and this particular
 * multiplier/increment pair would still advance correctly since the
 * increment is nonzero, but avoiding state 0 entirely sidesteps ever
 * needing to reason about it).
 */
export function createDeterministicRandom(seed: string): RandomSource {
  let state = hashSeedString(seed) || 1;
  return () => {
    state = (state * 1103515245 + 12345) & 0x7fffffff;
    return state / 0x7fffffff;
  };
}

/**
 * The stable seed-string shape for one card's one-time normalization
 * draw: normalization version first (so bumping the version -- e.g. a
 * future corrective re-run -- changes every seed deliberately), then
 * deck, then card. "Same card + same normalization version -> same
 * sampled repair target" (approved plan) follows directly from this
 * being a pure function of exactly those three inputs.
 */
export function buildNormalizationSeed(input: {
  readonly normalizationVersion: string;
  readonly deckId: string;
  readonly cardId: string;
}): string {
  return `${input.normalizationVersion}:${input.deckId}:${input.cardId}`;
}
