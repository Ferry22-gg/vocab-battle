-- Learning Engine v1 -- pre-RC-E corrective migration: make enrollment
-- genuinely atomic with respect to Session creation.
--
-- Forward-only, strictly additive. Does NOT edit
-- 20261019000000_learning_engine_v1_enrollment_active_legacy_session_guard.sql
-- (already applied) in place -- admit_user_to_learning_engine_v1() is left
-- completely untouched; this migration only ADDS a new function that
-- calls it as its final step, from within the SAME transaction.
--
-- ---------------------------------------------------------------------
-- The remaining race (review finding, confirmed)
-- ---------------------------------------------------------------------
-- The previous correction (20261019000000) added a transactional guard
-- to admit_user_to_learning_engine_v1() itself, but the caller
-- (lib/learning-engine/cutover/enroll.ts) still called normalization
-- (a SEPARATE sequence of individual RPC calls, each its own
-- transaction) BEFORE calling that admission RPC. That still permits:
--
--   T1 (enrollment): checks for an active legacy Session -- finds none.
--   T2: start_or_resume_session() creates a new legacy Session for the
--       same user, commits.
--   T1: proceeds to normalize this user's user_card_progress rows
--       against shared state (each normalize_card_progress_for_learning_engine_v1()
--       call is its own committed transaction) -- these commit.
--   T1: calls admit_user_to_learning_engine_v1() last -- it now sees
--       T2's active legacy Session and correctly rejects (42501).
--
--   Result: no rollout row exists, the user remains operationally
--   legacy, but user_card_progress has already been mutated into
--   v1-shaped state for a user who is not enrolled and whose legacy
--   Session can keep committing further legacy answers that never
--   maintain those v1-only fields -- exactly the mixed-state condition
--   this correction exists to prevent. The final admission guard alone
--   is too late: normalization had already committed by the time it ran.
--
-- ---------------------------------------------------------------------
-- The fix
-- ---------------------------------------------------------------------
-- One new trusted function, commit_learning_engine_v1_enrollment(),
-- composes the ENTIRE enrollment sequence inside a single transaction:
-- lock, re-check rollout, re-check active legacy Session, apply every
-- prepared card normalization, recompute deck state, and admit -- by
-- calling RC-A's own already-reviewed per-row primitives
-- (normalize_card_progress_for_learning_engine_v1(),
-- recompute_user_deck_learning_state_for_v1()) and RC-D/pre-RC-E's own
-- admit_user_to_learning_engine_v1() AS PLAIN NESTED FUNCTION CALLS from
-- within this function's own transaction -- never duplicating their
-- validation/persistence logic, and never recomputing Learning Engine
-- normalization POLICY in SQL. That policy (which target state a given
-- legacy card_status normalizes to, FORGOTTEN's synthetic repair-window
-- sampling via the real createRepairObligation()) is computed entirely
-- in TypeScript, unchanged, by
-- lib/learning-engine/cutover/prepare-normalization.ts's
-- computeNormalizationTargets() (itself unchanged RC-A logic, merely
-- relocated out of the one-time script so both callers share it) --
-- this function receives only the FULLY COMPUTED result as `p_cards`
-- and `p_deck_ids` and performs no scheduling computation of its own.
--
-- Locking: this function locks public.profiles for p_user_id FOR UPDATE
-- as its very first step -- the SAME row, in the SAME order (profile
-- first, nothing else), that start_or_resume_session() locks before it
-- may create a new Session, and that admit_user_to_learning_engine_v1()
-- (called from here, at the end) locks again (a harmless re-lock of a
-- row this same transaction already holds). Whichever transaction --
-- this one, or a concurrent start_or_resume_session() for the same user
-- -- acquires that lock first forces the other to wait until it commits
-- or rolls back, so a legacy Session's creation and this user's
-- enrollment can never interleave. There is therefore no outcome in
-- which a legacy Session exists AND normalization commits AND the
-- rollout row is absent: either the Session is created first (seen by
-- the active-legacy-session check below, enrollment entirely rejected,
-- no normalization applied) or enrollment commits first (Session
-- creation, which only reads learning_engine_v1_rollout AFTER it
-- acquires the same lock, sees the now-existing row and the
-- subsequently-created Session is 'v1').
--
-- Every mutation below (per-card normalization, deck-state recompute,
-- rollout insertion) happens inside this one function's transaction: any
-- exception raised anywhere in it (a drifted card via
-- normalize_card_progress_for_learning_engine_v1()'s own 40001 check, or
-- any other failure) aborts the WHOLE transaction -- plpgsql functions do
-- not need an explicit ROLLBACK; an unhandled exception inside one always
-- rolls back every change that function's invocation made. No partial
-- normalization can ever be left committed without a matching rollout row,
-- and no rollout row can ever be inserted without every prepared card
-- having been normalized first.
--
-- Repeated/concurrent enrollment: the rollout-row re-check happens AFTER
-- the profile-row lock is acquired, so two concurrent calls for the same
-- user serialize on that lock -- the first to commit creates the rollout
-- row; the second, once unblocked, re-reads and finds it, returning the
-- idempotent 'already_enrolled' result without normalizing anything a
-- second time.
create function public.commit_learning_engine_v1_enrollment(
  p_user_id uuid,
  p_normalization_version text,
  -- Array of {cardId, expectedLegacyCardStatus, cardStatus, learningStage,
  -- poolStatus, relearningPhase, hasEverBeenMastered, repairPending,
  -- repairWrongPosition, repairTargetPosition, repairHardCapPosition} --
  -- one entry per non-NEW legacy row, already fully computed by
  -- lib/learning-engine/cutover/prepare-normalization.ts. userId is
  -- never read from this payload -- every row is normalized under the
  -- single p_user_id above, so a malformed/malicious payload can never
  -- touch another user's data.
  p_cards jsonb,
  -- Array of deck id strings needing user_deck_learning_state
  -- initialized/recomputed -- includes a deck whose rows were all NEW
  -- (no card in p_cards for it, but its deck-state row still needs to
  -- exist with correct defaults).
  p_deck_ids jsonb
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_profile public.profiles;
  v_active_legacy_session_id uuid;
  v_existing_rollout public.learning_engine_v1_rollout;
  v_rollout public.learning_engine_v1_rollout;
  v_card jsonb;
  v_deck_id_text text;
  v_cards_normalized integer := 0;
  v_decks_recomputed integer := 0;
begin
  if p_user_id is null then
    raise exception 'commit_learning_engine_v1_enrollment: p_user_id is required'
      using errcode = '22023';
  end if;

  -- Step 1: lock the profile row FOR UPDATE -- see this migration's own
  -- header for why this is the serialization boundary against
  -- start_or_resume_session().
  select * into v_profile
  from public.profiles
  where id = p_user_id
  for update;

  if not found or v_profile.account_status <> 'active' or v_profile.role <> 'tester' then
    raise exception 'commit_learning_engine_v1_enrollment: % is not an active tester account', p_user_id
      using errcode = '28000';
  end if;

  -- Step 2: repeated-enrollment no-op, re-checked under the lock above --
  -- never re-normalizes an already-enrolled user's live v1 state, and
  -- converges correctly for two concurrent enrollment calls (whichever
  -- commits first wins; the other sees this branch).
  select * into v_existing_rollout from public.learning_engine_v1_rollout where user_id = p_user_id;
  if found then
    return jsonb_build_object(
      'status', 'already_enrolled',
      'rollout', to_jsonb(v_existing_rollout),
      'cards_normalized', 0,
      'decks_recomputed', 0
    );
  end if;

  -- Step 3: active-legacy-session guard, checked under the same lock
  -- that serializes against start_or_resume_session() -- the actual fix
  -- for the TOCTOU race this migration closes. Returned as a normal
  -- status (not raised) -- an expected operational outcome, same
  -- convention as get_next_session_card()'s status envelope, not a
  -- corrupted-invariant exception.
  select id into v_active_legacy_session_id
  from public.sessions
  where user_id = p_user_id
    and status = 'active'
    and engine_version = 'legacy'
  limit 1;

  if v_active_legacy_session_id is not null then
    return jsonb_build_object(
      'status', 'active_legacy_session',
      'session_id', v_active_legacy_session_id
    );
  end if;

  -- Step 4/5: apply every prepared card normalization -- reusing RC-A's
  -- own trusted per-row primitive UNCHANGED, never reimplementing its
  -- structural validation or its expected-before-state drift check
  -- here. A drifted row raises SQLSTATE 40001 from inside this call,
  -- which aborts and rolls back this entire transaction -- no partial
  -- normalization is ever left committed.
  for v_card in select * from jsonb_array_elements(p_cards)
  loop
    perform public.normalize_card_progress_for_learning_engine_v1(
      p_user_id,
      (v_card->>'cardId')::uuid,
      v_card->>'expectedLegacyCardStatus',
      v_card->>'cardStatus',
      v_card->>'learningStage',
      v_card->>'poolStatus',
      v_card->>'relearningPhase',
      (v_card->>'hasEverBeenMastered')::boolean,
      (v_card->>'repairPending')::boolean,
      (v_card->>'repairWrongPosition')::integer,
      (v_card->>'repairTargetPosition')::integer,
      (v_card->>'repairHardCapPosition')::integer,
      p_normalization_version
    );
    v_cards_normalized := v_cards_normalized + 1;
  end loop;

  -- Step 6: recompute/init user_deck_learning_state for every deck this
  -- user touches -- reusing RC-A's own trusted primitive UNCHANGED, same
  -- as the one-time script does after normalizing a deck's cards.
  for v_deck_id_text in select * from jsonb_array_elements_text(p_deck_ids)
  loop
    perform public.recompute_user_deck_learning_state_for_v1(p_user_id, v_deck_id_text::uuid);
    v_decks_recomputed := v_decks_recomputed + 1;
  end loop;

  -- Step 7: admit -- reusing the existing trusted primitive UNCHANGED.
  -- Its own profile-row lock re-acquires the row this transaction
  -- already holds (a harmless no-op re-lock, not a deadlock -- the same
  -- backend already owns it), and its own active-legacy-session check
  -- re-confirms what step 3 already established under the identical
  -- lock -- impossible to have changed in between.
  v_rollout := public.admit_user_to_learning_engine_v1(p_user_id);

  return jsonb_build_object(
    'status', 'ok',
    'rollout', to_jsonb(v_rollout),
    'cards_normalized', v_cards_normalized,
    'decks_recomputed', v_decks_recomputed
  );
end;
$$;

comment on function public.commit_learning_engine_v1_enrollment(uuid, text, jsonb, jsonb) is
  'Pre-RC-E corrective: the single atomic enrollment transaction. SECURITY DEFINER, service_role-only. Locks profiles FOR UPDATE (serializing against start_or_resume_session()), then: returns status=''already_enrolled'' if a rollout row already exists (true no-op); returns status=''active_legacy_session'' if the user has an ACTIVE engine_version=''legacy'' session (nothing mutated); otherwise applies every prepared card normalization via normalize_card_progress_for_learning_engine_v1(), recomputes user_deck_learning_state via recompute_user_deck_learning_state_for_v1(), and admits via admit_user_to_learning_engine_v1() -- all inside this one transaction, so normalization can never commit without rollout admission committing too. Performs no Learning Engine normalization computation of its own -- p_cards is a fully pre-computed payload from lib/learning-engine/cutover/prepare-normalization.ts. Never grants authenticated/anon execute.';

revoke all on function public.commit_learning_engine_v1_enrollment(uuid, text, jsonb, jsonb) from public, anon, authenticated;
grant execute on function public.commit_learning_engine_v1_enrollment(uuid, text, jsonb, jsonb) to service_role;
