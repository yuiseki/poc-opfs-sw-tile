import { defineConfig, devices } from "@playwright/test";

// e2e: 事前に `npm run build` でバンドルを作り、静的サーバを立ててからテストする。
export default defineConfig({
  testDir: "./e2e",
  timeout: 60_000,
  fullyParallel: false,
  reporter: [["list"]],
  use: {
    baseURL: "http://localhost:8080",
    // Service Worker / OPFS が有効になるよう、テストごとにストレージを分離
    serviceWorkers: "allow",
  },
  projects: [
    { name: "chromium", use: { ...devices["Desktop Chrome"] } },
  ],
  // docs/ を静的配信(ポート 8080)。テスト前に自動でビルド & 起動する。
  webServer: {
    command: "npm run build && python3 -m http.server 8080 --directory docs",
    url: "http://localhost:8080/main.js",
    reuseExistingServer: !process.env.CI,
    timeout: 60_000,
  },
});
