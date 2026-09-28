import { describe, expect, it } from "vitest";

import { getEnemyVisual } from "@/lib/session-ui/enemies";

describe("getEnemyVisual", () => {
  it("maps every canonical enemy id to its own forest asset and label", () => {
    expect(getEnemyVisual("enemy_a")).toMatchObject({
      id: "enemy_a",
      label: "Moss Slime",
      src: "/enemies/forest/moss-slime.png",
    });
    expect(getEnemyVisual("enemy_b")).toMatchObject({
      id: "enemy_b",
      label: "Mushroom Goblin",
      src: "/enemies/forest/mushroom-goblin.png",
    });
    expect(getEnemyVisual("enemy_c")).toMatchObject({
      id: "enemy_c",
      label: "Root Golem",
      src: "/enemies/forest/root-golem.png",
    });
  });

  it("gives the Root Golem a larger footprint than the Moss Slime, with the Mushroom Goblin in between", () => {
    const a = getEnemyVisual("enemy_a")!;
    const b = getEnemyVisual("enemy_b")!;
    const c = getEnemyVisual("enemy_c")!;
    expect(a.sizePx).toBeLessThan(b.sizePx);
    expect(b.sizePx).toBeLessThan(c.sizePx);
  });

  it("returns null for an unknown enemy id rather than throwing or guessing", () => {
    expect(getEnemyVisual("boss_dragon")).toBeNull();
    expect(getEnemyVisual("")).toBeNull();
  });
});
