import { defineConfig } from "@playwright/test";

export default defineConfig({
  testDir: ".",
  testMatch: "screenshot-compare.ts",
  fullyParallel: false,
  workers: 1,
  reporter: "list",
  timeout: 30_000,
  use: {
    baseURL: `http://127.0.0.1:${process.env.SHOT_PORT ?? "3101"}`,
    headless: true,
  },
});
