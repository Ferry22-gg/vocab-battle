import { describe, expect, it } from "vitest";

import { weightedRandomChoice } from "@/lib/learning-engine/scheduler/weighted-random";

/**
 * Unit tests for docs/LEARNING_ENGINE_V1_SPEC_FOR_CLAUDE.md section 17's
 * `P(i) = w(i) / sum(w)` formula (Phase 6A: generic weighted-random
 * primitive).
 */

function scriptedRandom(values: readonly number[]): () => number {
  let i = 0;
  return () => values[i++ % values.length];
}

describe("weightedRandomChoice", () => {
  it("picks the single candidate when there is only one", () => {
    expect(weightedRandomChoice([{ item: "only", weight: 1 }], () => 0.5)).toBe("only");
  });

  it("a roll near 0 picks the first candidate", () => {
    const candidates = [
      { item: "a", weight: 1 },
      { item: "b", weight: 1 },
      { item: "c", weight: 1 },
    ];
    expect(weightedRandomChoice(candidates, () => 0)).toBe("a");
  });

  it("a roll near 1 picks the last candidate", () => {
    const candidates = [
      { item: "a", weight: 1 },
      { item: "b", weight: 1 },
      { item: "c", weight: 1 },
    ];
    expect(weightedRandomChoice(candidates, () => 0.999999)).toBe("c");
  });

  it("respects weight proportions at exact boundaries (weights 0.3/0.7)", () => {
    const candidates = [
      { item: "low", weight: 0.3 },
      { item: "high", weight: 0.7 },
    ];
    // roll = random() * 1.0 (total weight). Just under 0.3 -> "low"; at/over 0.3 -> "high".
    expect(weightedRandomChoice(candidates, scriptedRandom([0.29]))).toBe("low");
    expect(weightedRandomChoice(candidates, scriptedRandom([0.3]))).toBe("high");
    expect(weightedRandomChoice(candidates, scriptedRandom([0.9]))).toBe("high");
  });

  it("a zero-weight candidate is never picked", () => {
    const candidates = [
      { item: "never", weight: 0 },
      { item: "always", weight: 1 },
    ];
    for (const roll of [0, 0.25, 0.5, 0.75, 0.999]) {
      expect(weightedRandomChoice(candidates, () => roll)).toBe("always");
    }
  });

  it("throws on an empty candidate list rather than guessing", () => {
    expect(() => weightedRandomChoice([], () => 0.5)).toThrow(/requires at least one candidate/);
  });

  it("throws when every candidate has zero weight (an un-renormalized empty source, caller error)", () => {
    const candidates = [
      { item: "a", weight: 0 },
      { item: "b", weight: 0 },
    ];
    expect(() => weightedRandomChoice(candidates, () => 0.5)).toThrow(/requires a positive total weight/);
  });

  it("is deterministic/reproducible: identical candidates + identical RNG sequence give identical results (section 24)", () => {
    const candidates = [
      { item: "a", weight: 2 },
      { item: "b", weight: 3 },
      { item: "c", weight: 5 },
    ];
    const run = () => weightedRandomChoice(candidates, scriptedRandom([0.42]));
    expect(run()).toBe(run());
  });

  it("consumes exactly one random() call per invocation", () => {
    let calls = 0;
    const random = () => {
      calls += 1;
      return 0.5;
    };
    weightedRandomChoice(
      [
        { item: "a", weight: 1 },
        { item: "b", weight: 1 },
      ],
      random,
    );
    expect(calls).toBe(1);
  });

  it("works with non-string/number item types (e.g. objects), comparing by reference", () => {
    const itemA = { cardId: "a" };
    const itemB = { cardId: "b" };
    const result = weightedRandomChoice(
      [
        { item: itemA, weight: 1 },
        { item: itemB, weight: 0 },
      ],
      () => 0.5,
    );
    expect(result).toBe(itemA);
  });
});
