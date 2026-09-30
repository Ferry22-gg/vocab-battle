import Image from "next/image";
import Link from "next/link";

/**
 * Home's dominant interaction (P3 spec section 6 / MVP_UI_SPEC.md 8.3):
 * one real CTA `<Link>` to /session, which itself already calls
 * startOrResumeSession() with no deck argument and transparently resumes
 * any existing active session or starts a new one
 * (app/session/page.tsx) -- no session-start logic is duplicated here.
 * `hasActiveSession` only ever changes the button's label, never its
 * behavior.
 *
 * The Coral Navigator is a separate `<Image>` layer overlapping the CTA's
 * top edge via a negative margin + z-index, never baked into the button.
 * Static/no idle motion by explicit product decision -- do not reintroduce
 * a bob/float keyframe here.
 */
export function SessionHero({ hasActiveSession }: { readonly hasActiveSession: boolean }) {
  const label = hasActiveSession ? "Resume Session" : "Start Session";

  return (
    <div className="relative flex flex-1 flex-col items-center justify-end px-6 pb-3">
      <div className="relative z-10 -mb-10 h-44 w-44 sm:h-52 sm:w-52">
        <Image
          src="/navigators/coral-guide/peek.png"
          alt=""
          fill
          sizes="220px"
          className="object-contain drop-shadow-lg"
          priority
        />
      </div>

      <Link
        href="/session"
        className="relative flex w-full max-w-sm items-center justify-center gap-3 rounded-full bg-gradient-to-b from-orange-400 to-orange-600 px-6 py-6 text-2xl font-extrabold text-white shadow-[0_6px_0_rgba(154,52,18,0.85)] ring-2 ring-orange-200/50 transition-transform hover:brightness-105 active:translate-y-0.5 active:shadow-[0_2px_0_rgba(154,52,18,0.85)] focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-amber-200"
      >
        <span aria-hidden="true">⚔️</span>
        {label}
      </Link>
    </div>
  );
}
