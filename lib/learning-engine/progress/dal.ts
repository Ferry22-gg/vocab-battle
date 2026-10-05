import "server-only";

/**
 * Runtime Cutover RC-E: the one authenticated-client read Deck Progress
 * eligibility needs -- does the CURRENT caller have a
 * `learning_engine_v1_rollout` row? Uses the ordinary RLS-scoped client
 * (lib/supabase/server.ts), never service_role -- the same
 * `learning_engine_v1_rollout_select_own_or_admin` policy
 * (supabase/migrations/20261007000000_learning_engine_v1_runtime_cutover_schema.sql)
 * that already lets a tester read their own rollout row, scoped with no
 * explicit userId filter the same way every other DAL read in this
 * codebase relies on RLS alone (e.g. lib/decks/dal.ts).
 *
 * This is the ONLY gate Deck Progress rendering may use (spec/TODO "Deck
 * Progress live rendering"): a legacy (not-yet-enrolled) user must never
 * see an approximated percentage -- see lib/decks/dal.ts's Deck Progress
 * wiring and lib/learning-engine/progress/deck-progress.ts's own
 * `incomplete` result for why a v1-shaped read is never guessed from
 * legacy-only state.
 */

import { createClient } from "@/lib/supabase/server";

export async function isCurrentUserEnrolledInLearningEngineV1(): Promise<boolean> {
  const supabase = await createClient();

  const { data, error } = await supabase
    .from("learning_engine_v1_rollout")
    .select("user_id")
    .maybeSingle();

  if (error) {
    throw new Error("Failed to read learning_engine_v1_rollout", { cause: error });
  }

  return data !== null;
}
