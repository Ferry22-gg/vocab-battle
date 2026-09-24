import { redirect } from "next/navigation";
import { requireActiveTester } from "@/lib/auth/dal";
import { NicknameForm } from "./nickname-form";

export default async function NicknamePage() {
  // requireActiveTester() already routes away everyone who doesn't belong
  // here: unauthenticated -> /login, profile-missing -> /profile-missing,
  // disabled -> /account-disabled, admin -> /admin.
  const tester = await requireActiveTester();

  if (tester.nickname) {
    redirect("/onboarding/deck");
  }

  return <NicknameForm />;
}
