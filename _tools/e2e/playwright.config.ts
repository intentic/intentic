import { defineConfig, devices } from "@playwright/test";
import { WEB_URL } from "./stack.js";

// Browser smoke tier: real Vue SPA, https API, Postgres and published sandbox daemon in loopback, with a seeded Better
// Auth session. Tests the browser-daemon contract, not a UI matrix.
export default defineConfig({
    testDir: `./specs`,
    globalSetup: `./global-setup`,
    globalTeardown: `./global-teardown`,
    timeout: 90_000,
    expect: { timeout: 15_000 },
    // One retry recovers a transient chunk-load flap; Vue's async loader doesn't retry on its own.
    retries: 1,
    // One seeded sandbox world: specs must run serially against it.
    workers: 1,
    reporter: [[`list`]],
    outputDir: `./.cache/test-results`,
    use: {
        baseURL: WEB_URL,
        storageState: `./.cache/storage-state.json`,
        // Both dev servers use this machine's localhost cert, which CI does not trust.
        ignoreHTTPSErrors: true,
        // Loopback daemon sends no CORS headers without auth; disabled here since it's the contract under test.
        launchOptions: { args: [`--disable-web-security`] },
        trace: `retain-on-failure`,
    },
    // channel: chromium avoids chromium-headless-shell: deleted from the image and an anti-bot WAF tell.
    projects: [{ name: `chromium`, use: { ...devices[`Desktop Chrome`], channel: `chromium` } }],
});
