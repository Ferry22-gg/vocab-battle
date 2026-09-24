import { teardownE2eFixtures } from "./fixtures/setup";

export default async function globalTeardown(): Promise<void> {
  await teardownE2eFixtures();
}
