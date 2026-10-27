import { defineConfig } from "@playwright/test";
import { repoRoot } from "@intentic/constants/node";

// The access crawl (demo-access.spec.ts) against the real editor on fixture backends: `ACCESS_DEMO_URL` reuses a demo
// already running, else the suite starts its own on a port no other suite uses and never reuses another's server.
const root = repoRoot(import.meta.url);
const existing = process.env[`ACCESS_DEMO_URL`];
const demo = existing ?? `http://127.0.0.1:47238/demo/`;

const config = defineConfig({
    testDir: `.`,
    testMatch: `demo-access.spec.ts`,
    workers: 1,
    retries: 0,
    // A hang bound, not a measure: one tier walks every screen, each given time for its background reads to run.
    timeout: 300_000,
    expect: { timeout: 20_000 },
    reporter: [[`list`]],
    outputDir: `../.cache/access`,
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
        command: `corepack pnpm -C _site/demo dev --port 47238 --force`,
        cwd: root,
        url: demo,
        reuseExistingServer: false,
        timeout: 120_000,
    };
}

export default config;
