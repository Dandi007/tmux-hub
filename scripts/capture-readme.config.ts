import { defineConfig } from "@playwright/test";

const PORT = process.env.SHOT_PORT ?? "3101";

export default defineConfig({
  testDir: ".",
  testMatch: "capture-readme.ts",
  fullyParallel: false,
  workers: 1,
  reporter: "list",
  timeout: 45_000,
  use: {
    baseURL: `http://127.0.0.1:${PORT}`,
    headless: true,
  },
});
