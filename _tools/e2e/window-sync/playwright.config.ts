import { fileURLToPath } from "node:url";
import { defineConfig } from "@playwright/test";

export default defineConfig({
    testDir: `.`,
    testMatch: `*.spec.ts`,
    workers: 1,
    timeout: 30_000,
    expect: { timeout: 10_000 },
    outputDir: `../.cache/window-sync-results`,
    use: { baseURL: `http://127.0.0.1:5199`, channel: `chromium`, trace: `retain-on-failure` },
    webServer: {
        command: `pnpm exec vite --config ../../_tools/e2e/window-sync/vite.config.ts --host 127.0.0.1 --port 5199 --strictPort`,
        cwd: fileURLToPath(new URL(`../../../_editor/web`, import.meta.url)),
        url: `http://127.0.0.1:5199`,
        timeout: 30_000,
    },
});
