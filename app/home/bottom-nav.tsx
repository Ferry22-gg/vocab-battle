import Link from "next/link";

/**
 * Shared bottom navigation (P3 spec section 9): Home / Decks / Stats, used
 * by Home (app/page.tsx), Decks (app/decks/page.tsx), and Stats
 * (app/stats/page.tsx) so all three routes share one visual system rather
 * than duplicating it. Every item is now a real `<Link>`.
 *
 * `active` is passed explicitly by each Server Component page rather than
 * derived from `usePathname()`, so this stays server-renderable and never
 * needs to be a Client Component itself.
 */
const ITEMS = [
  { key: "home", label: "Home", icon: "🏠", href: "/" as const },
  { key: "decks", label: "Decks", icon: "🗂️", href: "/decks" as const },
  { key: "stats", label: "Stats", icon: "📊", href: "/stats" as const },
] as const;

export function BottomNav({ active }: { readonly active: "home" | "decks" | "stats" }) {
  return (
    <nav
      aria-label="Primary"
      className="fixed inset-x-0 bottom-0 z-20 mx-auto w-full max-w-md px-3 pb-[calc(env(safe-area-inset-bottom,0px)+10px)] pt-2"
    >
      <div className="flex items-center justify-around rounded-3xl border border-white/10 bg-emerald-950/85 px-2 py-2.5 shadow-xl backdrop-blur-sm">
        {ITEMS.map((item) => {
          const isActive = item.key === active;
          return (
            <Link
              key={item.key}
              href={item.href}
              aria-current={isActive ? "page" : undefined}
              className={`flex flex-1 flex-col items-center gap-1 rounded-2xl px-3 py-2 text-sm font-semibold ${
                isActive ? "text-amber-300" : "text-emerald-100/70"
              }`}
            >
              <span aria-hidden="true" className="text-2xl">
                {item.icon}
              </span>
              {item.label}
              {isActive && <span aria-hidden="true" className="mt-0.5 h-0.5 w-5 rounded-full bg-amber-300" />}
            </Link>
          );
        })}
      </div>
    </nav>
  );
}
