import { StatTile } from "./stat-tile";

/**
 * Today card (Alpha Stats redesign, section 2): the screen's most
 * immediately rewarding section -- what the tester just accomplished
 * today, Asia/Tokyo calendar day (lib/stats/dal.ts). A brand-new tester
 * with zero activity today still sees five real zero values here, never a
 * blank/missing section (section 4 of the task brief).
 *
 * Study Time is an Alpha-safe ESTIMATE (lib/stats/aggregate.ts's capped
 * `response_time_ms` sum, card-front-shown -> Reveal-tapped only -- never
 * the full reveal->grade cycle), flagged via StatTile's `hint` rather than
 * extra visible text.
 */
export function TodayCard({
  answers,
  wordsStudied,
  wordsLearned,
  xp,
  studyTimeLabel,
}: {
  readonly answers: number;
  readonly wordsStudied: number;
  readonly wordsLearned: number;
  readonly xp: number;
  readonly studyTimeLabel: string;
}) {
  return (
    <section className="rounded-3xl border border-orange-300/20 bg-gradient-to-b from-orange-500/15 to-emerald-950/60 px-4 py-4 shadow-lg backdrop-blur-sm">
      <h2 className="mb-3 text-xs font-bold uppercase tracking-wide text-orange-200/80">Today</h2>
      <div className="grid grid-cols-2 gap-2.5">
        <StatTile icon="✅" label="Answers" value={answers} />
        <StatTile icon="📚" label="Words Studied" value={wordsStudied} />
        <StatTile icon="🌱" label="Words Learned" value={wordsLearned} />
        <StatTile icon="✨" label="XP" value={xp} />
        {/* Stats Alpha polish A2: Study Time spans both columns -- it is the one Today tile without a natural pair, and a full-width treatment reads better than a half-empty row. */}
        <div className="col-span-2">
          <StatTile icon="⏱️" label="Study Time" value={studyTimeLabel} hint="Estimated from recall time; may undercount" />
        </div>
      </div>
    </section>
  );
}
