import path from "node:path";
import { defineConfig } from "@playwright/test";
export default defineConfig({
  testDir: ".",
  testMatch: "*.spec.ts",
  fullyParallel: false,
  workers: 1,
  outputDir: "../.local/emby-selection/test-results",
  reporter: [
    ["list"],
    [
      "html",
      {
        outputFolder: path.resolve(
          import.meta.dirname,
          "../.local/emby-selection/report",
        ),
        open: "never",
      },
    ],
  ],
  use: { baseURL: "http://localhost:4318", trace: "retain-on-failure" },
  webServer: {
    cwd: path.resolve(import.meta.dirname, ".."),
    command:
      "CLERK_PUBLISHABLE_KEY=pk_test_Zml4dHVyZS5jbGVyay5hY2NvdW50cy5kZXYk CLERK_SECRET_KEY=fixture bunx --bun vite --config e2e/vite.config.ts --configLoader native",
    url: "http://localhost:4318/api/health",
    reuseExistingServer: false,
    timeout: 60000,
  },
});
