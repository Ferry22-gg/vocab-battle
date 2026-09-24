import { redirect } from "next/navigation";
import { requireActiveTester } from "@/lib/auth/dal";
import { getStarterDecks } from "@/lib/decks/dal";
import { DeckForm } from "./deck-form";

export default async function DeckPage() {
  const tester = await requireActiveTester();

  if (!tester.nickname) {
    redirect("/onboarding/nickname");
  }

  if (tester.onboardingCompleted && tester.selectedDeckId) {
    redirect("/");
  }

  const decks = await getStarterDecks();

  return <DeckForm decks={decks} />;
}
