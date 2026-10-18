import path from "node:path";
import { defineConfig } from "@playwright/test";

export default defineConfig({
  testDir: ".",
  testMatch: "sign-in.e2e.ts",
  outputDir: "../.local/login-theme/test-results",
  reporter: [
    ["list"],
    ["html", { outputFolder: "../.local/login-theme/report", open: "never" }],
  ],
  use: {
    baseURL: "http://localhost:4321",
    trace: "retain-on-failure",
  },
  webServer: {
    cwd: path.resolve(import.meta.dirname, ".."),
    command: "bun run dev --port 4321",
    url: "http://localhost:4321/admin",
    env: {
      // Public site key loads the real Clerk UI and public sign-in configuration.
      // The spec intercepts the identity API; no login is sent to this instance.
      CLERK_PUBLISHABLE_KEY: "pk_live_Y2xlcmsucGFkZG9jay50aGVzY3VkZGVycy5vcmck",
      CLERK_SECRET_KEY: "fixture",
    },
    reuseExistingServer: false,
    timeout: 60000,
  },
});
