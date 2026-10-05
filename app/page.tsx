import { requireOnboardedTester } from "@/lib/auth/dal";
import { getDeckById, getMasteredCountsByDeck, listCardsForDeck } from "@/lib/decks/dal";
import { getProfileStats } from "@/lib/profile/dal";
import { getTodayDailyGoalProgress } from "@/lib/learning/daily-goal-dal";
import { getActiveSessionForCurrentUser } from "@/lib/sessions/dal";
import { computeDeckProgress, type DeckProgressResult } from "@/lib/learning-engine/progress/deck-progress";
import { isCurrentUserEnrolledInLearningEngineV1 } from "@/lib/learning-engine/progress/dal";
import { WorldBackground } from "@/app/home/world-background";
import { HomeHeader } from "@/app/home/home-header";
import { SessionHero } from "@/app/home/session-hero";
import { DailyGoalCard } from "@/app/home/daily-goal-card";
import { SessionContextCard } from "@/app/home/session-context-card";
import { BottomNav } from "@/app/home/bottom-nav";

// requireOnboardedTester() is the single gate for this route: it already
// enforces unauthenticated -> /login, profile-missing -> /profile-missing,
// disabled -> /account-disabled, admin -> /admin, no nickname ->
// /onboarding/nickname, and onboarding incomplete -> /onboarding/deck.
// Only a fully onboarded active tester ever reaches the render below.
//
// Every other read below is independent of the others (all scoped by RLS
// to the same authenticated caller, none depending on another's result
// except the deck lookup, which depends on tester.selectedDeckId) and is
// fetched in parallel rather than sequentially awaited.
export default async function HomePage() {
  const tester = await requireOnboardedTester();

  const [deck, masteredCounts, profileStats, dailyGoal, activeSession, enrolledInV1, selectedDeckCards] =
    await Promise.all([
      // selectedDeckId is guaranteed set by the guard above, but the deck row
      // itself is supplementary display info -- if loading it fails, show the
      // rest of Home rather than taking down the whole page over it.
      tester.selectedDeckId ? getDeckById(tester.selectedDeckId).catch(() => null) : Promise.resolve(null),
      getMasteredCountsByDeck(),
      getProfileStats(),
      getTodayDailyGoalProgress(),
      // Read-only: never starts or resumes a session just by rendering Home.
      getActiveSessionForCurrentUser(),
      isCurrentUserEnrolledInLearningEngineV1(),
      // Runtime Cutover RC-E: Home only ever needs the one selected deck's
      // cards (never every owned deck), so this stays a single cheap query
      // -- no N+1 risk the way a full Deck list would have.
      tester.selectedDeckId ? listCardsForDeck(tester.selectedDeckId) : Promise.resolve([]),
    ]);
  const masteredCount = tester.selectedDeckId ? (masteredCounts.get(tester.selectedDeckId) ?? 0) : 0;
  const deckProgress: DeckProgressResult | null =
    tester.selectedDeckId && enrolledInV1
      ? computeDeckProgress(
          selectedDeckCards.map((card) => ({ cardStatus: card.cardStatus, learningStage: card.learningStage })),
        )
      : null;

  return (
    <div className="relative flex flex-1 flex-col overflow-hidden bg-emerald-950">
      <WorldBackground />

      <div className="relative mx-auto flex w-full max-w-md flex-1 flex-col">
        <HomeHeader
          nickname={tester.nickname ?? "Tester"}
          streak={profileStats.currentStreak}
          level={profileStats.level}
          totalXp={profileStats.totalXp}
        />

        <SessionHero hasActiveSession={activeSession !== null} />

        <div className="flex flex-col gap-3 px-4 pb-[calc(env(safe-area-inset-bottom,0px)+114px)]">
          <DailyGoalCard enemiesDefeated={dailyGoal.enemiesDefeated} completed={dailyGoal.completed} />
          <SessionContextCard deckName={deck?.name ?? null} masteredCount={masteredCount} deckProgress={deckProgress} />
        </div>
      </div>

      <BottomNav active="home" />
    </div>
  );
}
