"use server";

import { redirect } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import {
  isValidPublicUserIdFormat,
  toSyntheticEmail,
} from "@/lib/auth/constants";

export type LoginState = { error: string } | undefined;

// Same message for every failure mode (bad format, unknown ID, wrong
// password) -- never reveal which part was wrong, across only 31 possible
// accounts that's an enumeration risk worth closing even in a closed beta.
const GENERIC_LOGIN_ERROR = "Incorrect ID or password.";

export async function login(
  _prevState: LoginState,
  formData: FormData
): Promise<LoginState> {
  const publicUserId = formData.get("publicUserId");
  const password = formData.get("password");

  if (typeof publicUserId !== "string" || typeof password !== "string") {
    return { error: GENERIC_LOGIN_ERROR };
  }

  const trimmedId = publicUserId.trim();

  if (!isValidPublicUserIdFormat(trimmedId) || password.length === 0) {
    return { error: GENERIC_LOGIN_ERROR };
  }

  const supabase = await createClient();

  const { error } = await supabase.auth.signInWithPassword({
    email: toSyntheticEmail(trimmedId),
    password,
  });

  if (error) {
    return { error: GENERIC_LOGIN_ERROR };
  }

  // Deliberately always "/", not a role/onboarding-aware destination:
  // that routing decision belongs to the DAL guards on the destination
  // pages (lib/auth/dal.ts), not duplicated here.
  redirect("/");
}

export async function logout(): Promise<void> {
  const supabase = await createClient();
  await supabase.auth.signOut();
  redirect("/login");
}
