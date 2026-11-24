import { defineConfig } from "@playwright/test";
export default defineConfig({
  testDir: "tests/e2e",
  workers: 1,
  timeout: 60_000,
  use: { headless: true },
  webServer: {
    command: "npm run demo",
    url: "http://127.0.0.1:4173",
    reuseExistingServer: true,
  },
  reporter: [
    ["list"],
    ["json", { outputFile: "output/playwright/results.json" }],
  ],
});
