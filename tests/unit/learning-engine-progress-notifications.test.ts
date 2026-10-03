import { describe, expect, it } from "vitest";

import { shouldShowCardMasteredToast, shouldShowFullMasteryToast } from "@/lib/learning-engine/progress/notifications";

/**
 * Unit tests for docs/LEARNING_ENGINE_V1_SPEC_FOR_CLAUDE.md sections
 * 15/25.1 ("Card Mastery Notification" / "Full Mastery Achievement"),
 * Phase 9. These are pure eligibility predicates only -- neither is wired
 * to a live trigger yet (see
 * lib/learning-engine/progress/notifications.ts's module header).
 */

describe("shouldShowCardMasteredToast (section 15.2)", () => {
  it("fires exactly on ACQUIRED -> LEARNED", () => {
    expect(shouldShowCardMasteredToast("ACQUIRED", "LEARNED")).toBe(true);
  });

  it("does not fire on LEARNED -> LEARNED (already mastered)", () => {
    expect(shouldShowCardMasteredToast("LEARNED", "LEARNED")).toBe(false);
  });

  it("does not fire on a transition into ACQUIRED", () => {
    expect(shouldShowCardMasteredToast("LEARNING", "ACQUIRED")).toBe(false);
  });

  it("does not fire on ACQUIRED -> FORGOTTEN or any other pair", () => {
    expect(shouldShowCardMasteredToast("ACQUIRED", "FORGOTTEN")).toBe(false);
    expect(shouldShowCardMasteredToast("NEW", "LEARNING")).toBe(false);
    expect(shouldShowCardMasteredToast("FORGOTTEN", "LEARNED")).toBe(false);
  });
});

describe("shouldShowFullMasteryToast (section 25.1)", () => {
  it("fires exactly on the first false -> true transition", () => {
    expect(shouldShowFullMasteryToast(false, true)).toBe(true);
  });

  it("does not fire when already true and remains true", () => {
    expect(shouldShowFullMasteryToast(true, true)).toBe(false);
  });

  it("does not retrigger on a later 499/500 -> 500/500 recovery (flag already true before)", () => {
    // Modeled as: hasAchievedFullMasteryBefore is already true by the time
    // of the recovery (it was set on first unlock and never cleared), so
    // the before/after pair here is true -> true, not false -> true.
    expect(shouldShowFullMasteryToast(true, true)).toBe(false);
  });

  it("does not fire on false -> false (never achieved)", () => {
    expect(shouldShowFullMasteryToast(false, false)).toBe(false);
  });

  it("does not fire on a true -> false pair (the flag never clears in practice, but the predicate itself must not fire either way)", () => {
    expect(shouldShowFullMasteryToast(true, false)).toBe(false);
  });
});
