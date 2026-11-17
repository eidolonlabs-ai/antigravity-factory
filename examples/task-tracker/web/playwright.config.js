import { defineConfig } from "@playwright/test";
export default defineConfig({
  testDir: "./tests",
  workers: 1,
  retries: 0,
  timeout: 30000,
  outputDir: process.env.FACTORY_ARTIFACT_DIR
    ? `${process.env.FACTORY_ARTIFACT_DIR}/browser`
    : "../.factory/browser-artifacts",
  reporter: "list",
  use: {
    baseURL: process.env.WEB_BASE_URL,
    headless: true,
    screenshot: "only-on-failure",
    trace: "retain-on-failure",
  },
});
