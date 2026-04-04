import { defineConfig } from "@playwright/test";

export default defineConfig({
  testDir: "./e2e",
  use: {
    baseURL: "http://localhost:3001",
  },
  webServer: {
    command: "PORT=3001 pnpm dev",
    url: "http://localhost:3001",
    reuseExistingServer: true,
    timeout: 30000,
  },
});
