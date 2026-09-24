import { requireAdmin } from "@/lib/auth/dal";

// Minimal stub: only enough to be a valid, non-recursive redirect target
// for requireActiveTester()'s admin branch. Admin functionality itself is
// out of scope for Phase 3.
export default async function AdminPage() {
  await requireAdmin();

  return (
    <div className="flex flex-1 items-center justify-center bg-zinc-50 px-4 dark:bg-black">
      <p className="text-sm text-zinc-600 dark:text-zinc-400">
        Admin area -- coming soon.
      </p>
    </div>
  );
}
