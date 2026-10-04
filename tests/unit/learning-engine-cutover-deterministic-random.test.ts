import { describe, expect, it } from "vitest";

import { buildNormalizationSeed, createDeterministicRandom } from "@/lib/learning-engine/cutover/deterministic-random";

/**
 * Unit tests for the Runtime Cutover RC-A deterministic RNG builder --
 * approved plan clarification 2 ("Deterministic RNG for normalization"):
 * "same card + same normalization version -> same sampled repair
 * target" and "retrying normalization cannot silently change the
 * obligation."
 */
describe("createDeterministicRandom", () => {
  it("the same seed produces the exact same sequence of values on every call", () => {
    const seed = "learning-engine-v1.0-cutover-rc-a.1:deck-a:card-b";
    const sequenceA = Array.from({ length: 10 }, () => createDeterministicRandom(seed)());
    const sequenceB = Array.from({ length: 10 }, () => createDeterministicRandom(seed)());
    expect(sequenceA).toEqual(sequenceB);
  });

  it("a single generator produces the same sequence across two independent instantiations (not just the first value)", () => {
    const seed = "learning-engine-v1.0-cutover-rc-a.1:deck-a:card-b";
    const genA = createDeterministicRandom(seed);
    const genB = createDeterministicRandom(seed);
    for (let i = 0; i < 20; i++) {
      expect(genA()).toBe(genB());
    }
  });

  it("different seeds produce different sequences", () => {
    const genA = createDeterministicRandom("seed-a");
    const genB = createDeterministicRandom("seed-b");
    const valuesA = Array.from({ length: 5 }, () => genA());
    const valuesB = Array.from({ length: 5 }, () => genB());
    expect(valuesA).not.toEqual(valuesB);
  });

  it("every produced value lies in [0, 1)", () => {
    const gen = createDeterministicRandom("boundary-check");
    for (let i = 0; i < 200; i++) {
      const value = gen();
      expect(value).toBeGreaterThanOrEqual(0);
      expect(value).toBeLessThan(1);
    }
  });

  it("an empty-string seed is still deterministic and does not throw", () => {
    const genA = createDeterministicRandom("");
    const genB = createDeterministicRandom("");
    expect(genA()).toBe(genB());
  });
});

describe("buildNormalizationSeed", () => {
  it("is a pure function of exactly normalizationVersion/deckId/cardId", () => {
    const a = buildNormalizationSeed({ normalizationVersion: "v1", deckId: "deck-1", cardId: "card-1" });
    const b = buildNormalizationSeed({ normalizationVersion: "v1", deckId: "deck-1", cardId: "card-1" });
    expect(a).toBe(b);
  });

  it("changing cardId changes the seed (and therefore the downstream sampled value)", () => {
    const seedA = buildNormalizationSeed({ normalizationVersion: "v1", deckId: "deck-1", cardId: "card-1" });
    const seedB = buildNormalizationSeed({ normalizationVersion: "v1", deckId: "deck-1", cardId: "card-2" });
    expect(seedA).not.toBe(seedB);
    expect(createDeterministicRandom(seedA)()).not.toBe(createDeterministicRandom(seedB)());
  });

  it("changing deckId changes the seed", () => {
    const seedA = buildNormalizationSeed({ normalizationVersion: "v1", deckId: "deck-1", cardId: "card-1" });
    const seedB = buildNormalizationSeed({ normalizationVersion: "v1", deckId: "deck-2", cardId: "card-1" });
    expect(seedA).not.toBe(seedB);
  });

  it("changing normalizationVersion changes the seed -- the documented escape hatch for a corrective re-run", () => {
    const seedA = buildNormalizationSeed({ normalizationVersion: "v1", deckId: "deck-1", cardId: "card-1" });
    const seedB = buildNormalizationSeed({ normalizationVersion: "v2", deckId: "deck-1", cardId: "card-1" });
    expect(seedA).not.toBe(seedB);
  });
});
