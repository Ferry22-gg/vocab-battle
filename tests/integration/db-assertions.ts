/**
 * Admin-client (service-role) postcondition read helpers for the
 * integration suite's assertions -- never used for the read-side calls
 * `runSubmitAnswer()` itself makes (see tester-client.ts/
 * rls-client-context.ts for that). Reading via service-role here is the
 * explicitly-sanctioned use of privileged access: inspecting persisted
 * state after a real commit, not substituting for RLS-scoped production
 * reads.
 */

import { createAdminClient } from "./admin-client";

export async function getAnswerEventByClientEventIdAdmin(clientEventId: string) {
  const admin = createAdminClient();
  const { data, error } = await admin
    .from("answer_events")
    .select("*")
    .eq("client_event_id", clientEventId)
    .maybeSingle();
  if (error) throw error;
  return data;
}

export async function countAnswerEventsByClientEventId(clientEventId: string): Promise<number> {
  const admin = createAdminClient();
  const { count, error } = await admin
    .from("answer_events")
    .select("id", { count: "exact", head: true })
    .eq("client_event_id", clientEventId);
  if (error) throw error;
  return count ?? 0;
}

export async function getXpEventsForAnswerEventAdmin(answerEventId: string) {
  const admin = createAdminClient();
  const { data, error } = await admin
    .from("xp_events")
    .select("*")
    .eq("source_answer_event_id", answerEventId);
  if (error) throw error;
  return data ?? [];
}

export async function getSessionByIdAdmin(sessionId: string) {
  const admin = createAdminClient();
  const { data, error } = await admin.from("sessions").select("*").eq("id", sessionId).maybeSingle();
  if (error) throw error;
  return data;
}

export async function getUserCardProgressAdmin(userId: string, cardId: string) {
  const admin = createAdminClient();
  const { data, error } = await admin
    .from("user_card_progress")
    .select("*")
    .eq("user_id", userId)
    .eq("card_id", cardId)
    .maybeSingle();
  if (error) throw error;
  return data;
}

export async function getProfileAdmin(userId: string) {
  const admin = createAdminClient();
  const { data, error } = await admin.from("profiles").select("*").eq("id", userId).maybeSingle();
  if (error) throw error;
  return data;
}

export async function getDailyUserStatsAdmin(userId: string, statDate: string) {
  const admin = createAdminClient();
  const { data, error } = await admin
    .from("daily_user_stats")
    .select("*")
    .eq("user_id", userId)
    .eq("stat_date", statDate)
    .maybeSingle();
  if (error) throw error;
  return data;
}

/** Asia/Tokyo "today" as YYYY-MM-DD, matching the DB's day-boundary convention (DATABASE_SCHEMA.md 2.2). */
export function todayInTokyo(): string {
  return new Date().toLocaleDateString("en-CA", { timeZone: "Asia/Tokyo" });
}

export async function updateUserCardProgressAdmin(
  userId: string,
  cardId: string,
  patch: Record<string, unknown>,
): Promise<void> {
  const admin = createAdminClient();
  const { error } = await admin.from("user_card_progress").update(patch).eq("user_id", userId).eq("card_id", cardId);
  if (error) throw error;
}

export async function updateSessionAdmin(sessionId: string, patch: Record<string, unknown>): Promise<void> {
  const admin = createAdminClient();
  const { error } = await admin.from("sessions").update(patch).eq("id", sessionId);
  if (error) throw error;
}

export async function getSessionLearningQueueRowAdmin(sessionId: string, cardId: string) {
  const admin = createAdminClient();
  const { data, error } = await admin
    .from("session_learning_queue")
    .select("*")
    .eq("session_id", sessionId)
    .eq("card_id", cardId)
    .maybeSingle();
  if (error) throw error;
  return data;
}

export async function upsertDailyUserStatsAdmin(
  userId: string,
  statDate: string,
  patch: Record<string, unknown>,
): Promise<void> {
  const admin = createAdminClient();
  const { error } = await admin
    .from("daily_user_stats")
    .upsert({ user_id: userId, stat_date: statDate, ...patch }, { onConflict: "user_id,stat_date" });
  if (error) throw error;
}
