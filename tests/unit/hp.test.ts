import { describe, expect, it } from "vitest";

import { clampHpPercent } from "@/lib/session-ui/hp";

describe("clampHpPercent", () => {
  it("computes a plain percentage for normal in-range values", () => {
    expect(clampHpPercent(50, 100)).toBe(50);
    expect(clampHpPercent(90, 90)).toBe(100);
    expect(clampHpPercent(0, 90)).toBe(0);
  });

  it("clamps to [0, 100] even if hp is out of range", () => {
    expect(clampHpPercent(-5, 100)).toBe(0);
    expect(clampHpPercent(150, 100)).toBe(100);
  });

  it("returns 0 rather than dividing by zero/negative maxHp", () => {
    expect(clampHpPercent(10, 0)).toBe(0);
    expect(clampHpPercent(10, -10)).toBe(0);
  });
});
