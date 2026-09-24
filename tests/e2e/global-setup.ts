import { setupE2eFixtures } from "./fixtures/setup";

export default async function globalSetup(): Promise<void> {
  await setupE2eFixtures();
}
