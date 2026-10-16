import { defineConfig } from "@playwright/test";
import { repoRoot } from "@intentic/constants/node";

const root = repoRoot(import.meta.url);
const existing = process.env[`A11Y_DEMO_URL`];
const demo = existing ?? `http://127.0.0.1:47237/demo/`;

const config = defineConfig({
    testDir: `.`,
    testMatch: `demo.spec.ts`,
    workers: 1,
    retries: 0,
    timeout: 90_000,
    expect: { timeout: 20_000 },
    reporter: [[`list`], [`json`, { outputFile: `../.cache/accessibility/report.json` }]],
    outputDir: `../.cache/accessibility`,
    use: {
        baseURL: demo.endsWith(`/`) ? demo : `${demo}/`,
        channel: `chromium`,
        locale: `en-US`,
        viewport: { width: 1440, height: 1000 },
        trace: `retain-on-failure`,
        screenshot: `only-on-failure`,
    },
});

if (existing === undefined) {
    config.webServer = {
        command: `corepack pnpm -C _site/demo dev --port 47237 --force`,
        cwd: root,
        url: demo,
        reuseExistingServer: false,
        timeout: 120_000,
    };
}

export default config;
