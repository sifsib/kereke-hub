import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["**/*.test.ts"],
    // Every test file shares one emulator, so run files one at a time to stop
    // one file's clearFirestore() wiping another file's seed data mid-run.
    fileParallelism: false,
    testTimeout: 15000,
  },
});
