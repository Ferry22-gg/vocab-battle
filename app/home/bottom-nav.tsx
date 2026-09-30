import Link from "next/link";

/**
 * Bottom navigation (P3 spec section 9): Home / Decks / Stats only.
 * Neither /decks nor /stats exists yet in this codebase (confirmed by
 * repo audit -- no app/decks or app/stats route). Per spec ("do not build
 * a fake full feature ... use the smallest safe project-consistent
 * placeholder"), those two render as visibly present but inert, disabled
 * buttons rather than as `<Link>`s to a 404, or a Decks-selection flow
 * duplicated from onboarding.
 */
const ITEMS = [
  { key: "home", label: "Home", icon: "🏠", href: "/" as const, active: true },
  { key: "decks", label: "Decks", icon: "🗂️", href: null, active: false },
  { key: "stats", label: "Stats", icon: "📊", href: null, active: false },
];

export function BottomNav() {
  return (
    <nav
      aria-label="Primary"
      className="fixed inset-x-0 bottom-0 z-20 mx-auto w-full max-w-md px-3 pb-[calc(env(safe-area-inset-bottom,0px)+10px)] pt-2"
    >
      <div className="flex items-center justify-around rounded-3xl border border-white/10 bg-emerald-950/85 px-2 py-2.5 shadow-xl backdrop-blur-sm">
        {ITEMS.map((item) =>
          item.href ? (
            <Link
              key={item.key}
              href={item.href}
              aria-current={item.active ? "page" : undefined}
              className={`flex flex-1 flex-col items-center gap-1 rounded-2xl px-3 py-2 text-sm font-semibold ${
                item.active ? "text-amber-300" : "text-emerald-100/70"
              }`}
            >
              <span aria-hidden="true" className="text-2xl">
                {item.icon}
              </span>
              {item.label}
              {item.active && <span aria-hidden="true" className="mt-0.5 h-0.5 w-5 rounded-full bg-amber-300" />}
            </Link>
          ) : (
            <button
              key={item.key}
              type="button"
              disabled
              title={`${item.label} is coming soon`}
              className="flex flex-1 flex-col items-center gap-1 rounded-2xl px-3 py-2 text-sm font-semibold text-emerald-100/30"
            >
              <span aria-hidden="true" className="text-2xl">
                {item.icon}
              </span>
              {item.label}
            </button>
          ),
        )}
      </div>
    </nav>
  );
}
