/**
 * One compact number tile, shared by the Lifetime Stats and Performance
 * cards (P3 Stats). `value` accepts a pre-formatted string so callers own
 * their own empty-state rendering (e.g. "--" for "no answers yet") rather
 * than this component guessing at formatting rules.
 */
export function StatTile({ icon, label, value }: { readonly icon: string; readonly label: string; readonly value: string | number }) {
  return (
    <div className="flex flex-col items-center gap-1 rounded-2xl bg-emerald-900/40 px-2 py-3 text-center">
      <span aria-hidden="true" className="text-xl">
        {icon}
      </span>
      <span className="text-base font-extrabold text-white">{value}</span>
      <span className="text-[10px] font-semibold uppercase tracking-wide text-emerald-100/55">{label}</span>
    </div>
  );
}
