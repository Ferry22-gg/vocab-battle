import { setupIntegrationFixtures, teardownIntegrationFixtures } from "./fixtures/setup";

export default async function globalSetup(): Promise<() => Promise<void>> {
  await setupIntegrationFixtures();

  return async () => {
    await teardownIntegrationFixtures();
  };
}
