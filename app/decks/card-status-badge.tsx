import { toUserFacingCardStatus, type UserFacingCardStatus } from "@/lib/learning-engine/progress/status";
import type { CardStatus } from "@/lib/learning-engine/state";

/**
 * Centralized learner-facing status pill (spec section 4). Always goes
 * through toUserFacingCardStatus() -- never renders a raw CardStatus --
 * so 'ACQUIRED'/'FORGOTTEN' can never leak to a learner as literal backend
 * names (Deck Detail, spec section 10: "Only labels allowed: NEW /
 * LEARNING / LEARNED / MASTERED / RELEARNING").
 */
export function CardStatusBadge({ cardStatus }: { readonly cardStatus: CardStatus }) {
  const label = toUserFacingCardStatus(cardStatus);
  return <span className={`shrink-0 rounded-full px-2 py-0.5 text-[10px] font-bold ${STATUS_STYLES[label]}`}>{label}</span>;
}

/** Calm, non-punitive palette -- RELEARNING deliberately uses the same restrained sky tone as the existing Daily Goal toast, not an error/red color (spec section 12: "RELEARNING communicates an active recovery process"). */
const STATUS_STYLES = {
  NEW: "bg-white/10 text-emerald-100/70",
  LEARNING: "bg-sky-400/20 text-sky-200",
  LEARNED: "bg-emerald-400/20 text-emerald-200",
  MASTERED: "bg-amber-400/20 text-amber-300",
  RELEARNING: "bg-sky-400/20 text-sky-200",
} as const satisfies Record<UserFacingCardStatus, string>;
