/**
 * One compact number tile, shared by the Lifetime Stats and Performance
 * cards (P3 Stats). `value` accepts a pre-formatted string so callers own
 * their own empty-state rendering (e.g. "--" for "no answers yet") rather
 * than this component guessing at formatting rules.
 *
 * `hint`: optional accessible/tooltip text for a value that needs a small
 * caveat without adding visible clutter (e.g. Study Time's "Estimated"
 * disclosure) -- rendered as a native `title` (hover/long-press tooltip)
 * plus an `aria-label` on the value itself, never as extra visible text.
 * Omitted entirely by every other existing caller, so their rendering is
 * byte-for-byte unchanged.
 */
export function StatTile({
  icon,
  label,
  value,
  hint,
}: {
  readonly icon: string;
  readonly label: string;
  readonly value: string | number;
  readonly hint?: string;
}) {
  return (
    <div className="flex flex-col items-center gap-1 rounded-2xl bg-emerald-900/40 px-2 py-3 text-center">
      <span aria-hidden="true" className="text-xl">
        {icon}
      </span>
      <span className="text-base font-extrabold text-white" title={hint} aria-label={hint ? `${value}, ${hint}` : undefined}>
        {value}
      </span>
      <span className="text-[10px] font-semibold uppercase tracking-wide text-emerald-100/55">{label}</span>
    </div>
  );
}
