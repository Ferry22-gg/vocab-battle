import { describe, expect, it } from "vitest";

import { deriveComboEvent } from "@/lib/session-ui/combo-events";

describe("deriveComboEvent", () => {
  it("does not fire on the very first Correct (0 -> 1 stays in the zero-bonus tier)", () => {
    expect(deriveComboEvent(0, 1)).toBeNull();
  });

  it("does not fire moving within the same bonus tier (e.g. 1 -> 2)", () => {
    expect(deriveComboEvent(1, 2)).toBeNull();
  });

  it("fires when crossing into a higher bonus tier (2 -> 3, 4 -> 5, 6 -> 7, 8 -> 9)", () => {
    expect(deriveComboEvent(2, 3)).toEqual({ kind: "combo_up" });
    expect(deriveComboEvent(4, 5)).toEqual({ kind: "combo_up" });
    expect(deriveComboEvent(6, 7)).toEqual({ kind: "combo_up" });
    expect(deriveComboEvent(8, 9)).toEqual({ kind: "combo_up" });
  });

  it("does not fire again for 9 -> 10 (already the max bonus tier)", () => {
    expect(deriveComboEvent(9, 10)).toBeNull();
  });

  it("never fires a loss event when combo resets to 0 on Wrong", () => {
    expect(deriveComboEvent(7, 0)).toBeNull();
    expect(deriveComboEvent(10, 0)).toBeNull();
    expect(deriveComboEvent(1, 0)).toBeNull();
  });

  it("does not fire when combo is unchanged", () => {
    expect(deriveComboEvent(5, 5)).toBeNull();
  });
});
