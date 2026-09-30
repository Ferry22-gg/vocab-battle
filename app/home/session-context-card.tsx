import Image from "next/image";

/**
 * Session Context card (P3 spec section 8): World + selected Deck as ONE
 * card, never separate large cards. The MVP has exactly one World
 * ("Forest World", hardcoded -- no World selector/unlock system exists
 * yet, per spec), so `worldName` is not a prop; the Deck half is real
 * product state passed in by the caller.
 *
 * The left World visual reuses the same production
 * public/worlds/forest/background.png asset used for the full-screen
 * background (no new art), cropped to a different region via
 * `objectPosition` and blended into the card -- not framed as a separate
 * thumbnail -- via a gradient overlay that fades the art into the card's
 * own dark-green background color at the seam, with no border/shadow of
 * its own around the image.
 *
 * The circular chevron on the right edge is decorative only, matching the
 * reference's affordance -- it is not a button/link and does nothing on
 * tap. No World selector exists yet (MVP has exactly one World), so this
 * deliberately does not wire up fake navigation/selection behavior; it
 * only visually echoes the reference's card treatment.
 */
export function SessionContextCard({ deckName }: { readonly deckName: string | null }) {
  return (
    <div className="relative flex h-28 overflow-hidden rounded-2xl border border-white/10 bg-emerald-950/80 shadow-md">
      <div className="relative w-[34%] shrink-0" aria-hidden="true">
        <Image
          src="/worlds/forest/background.png"
          alt=""
          fill
          sizes="160px"
          className="object-cover"
          style={{ objectPosition: "30% 55%" }}
        />
        <div className="absolute inset-0 bg-gradient-to-r from-transparent via-emerald-950/55 to-emerald-950/95" />
      </div>

      <div className="flex min-w-0 flex-1 flex-col justify-center gap-2 py-2 pl-4 pr-2">
        <p className="truncate text-lg font-bold text-white">Forest World</p>
        <div className="h-px w-full bg-white/10" />
        <div className="flex min-w-0 items-center gap-1.5">
          <span aria-hidden="true" className="text-base">
            📖
          </span>
          <span className="truncate text-base font-medium text-emerald-50">{deckName ?? "No deck selected"}</span>
        </div>
      </div>

      <div
        aria-hidden="true"
        className="mr-3 flex shrink-0 select-none items-center justify-center self-center rounded-full bg-white/10 text-emerald-50"
        style={{ width: 28, height: 28 }}
      >
        <span className="text-base leading-none">›</span>
      </div>
    </div>
  );
}
