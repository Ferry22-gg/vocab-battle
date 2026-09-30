import Image from "next/image";

/**
 * Full-viewport Forest World background (P3 spec section 4). Reuses the
 * real production asset (public/worlds/forest/background.png) directly --
 * not the reference screenshot. Sits behind the max-w-md content column as
 * a full-bleed sibling layer so on wide viewports the artwork extends
 * beyond the mobile-like content column instead of stretching with it.
 * Only a light readability gradient is layered on top -- no full blur, no
 * heavy darkening, so the ruins/forest composition stays visible.
 */
export function WorldBackground() {
  return (
    <div className="absolute inset-0" aria-hidden="true">
      <Image src="/worlds/forest/background.png" alt="" fill priority sizes="100vw" className="object-cover" />
      <div className="absolute inset-0 bg-gradient-to-b from-black/15 via-transparent to-black/35" />
    </div>
  );
}
