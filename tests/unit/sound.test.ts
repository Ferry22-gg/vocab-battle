import { describe, expect, it } from "vitest";

import { sessionSounds } from "@/lib/session-ui/sound";

/**
 * The unit suite runs under Vitest's "node" environment (vitest.config.mts)
 * -- there is no `window`/AudioContext here, which is exactly the
 * "unsupported environment" case sessionSounds must degrade gracefully in
 * (SSR, older browsers, locked-down embeds). Every sound must be a no-op,
 * never a thrown error, since sound is presentation polish that must never
 * break the answer loop (MVP_UI_SPEC.md 2.3).
 */
describe("sessionSounds (no window/AudioContext available)", () => {
  it("never throws for any sound, even with no AudioContext", () => {
    expect(() => sessionSounds.reveal()).not.toThrow();
    expect(() => sessionSounds.correct()).not.toThrow();
    expect(() => sessionSounds.critical()).not.toThrow();
    expect(() => sessionSounds.defeat()).not.toThrow();
    expect(() => sessionSounds.wrong()).not.toThrow();
  });
});
