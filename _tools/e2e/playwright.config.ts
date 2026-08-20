import { defineConfig, devices } from "@playwright/test";
import { WEB_URL } from "./stack.js";

// The browser smoke tier: the real Vue SPA + real https API + real Postgres + the PUBLISHED sandbox daemon in
// loopback, driven by a seeded Better Auth session (no real Google). Few journeys, one worker, the point is
// the browser→daemon contract (the hand-mirrored api-contract schemas), not a UI matrix.
export default defineConfig({
    testDir: `./specs`,
    globalSetup: `./global-setup`,
    globalTeardown: `./global-teardown`,
    timeout: 90_000,
    expect: { timeout: 15_000 },
    // A transient network flap (docker bridge/VPN churn, routine on WSL2 dev boxes) can fail a lazy route
    // chunk's import, and Vue's async loader doesn't retry, leaving a blank page. One retry gets a fresh
    // context; a real regression still fails twice.
    retries: 1,
    // One seeded sandbox world, specs run serially against it.
    workers: 1,
    reporter: [[`list`]],
    outputDir: `./.cache/test-results`,
    use: {
        baseURL: WEB_URL,
        storageState: `./.cache/storage-state.json`,
        // Both dev servers ride this machine's own localhost cert, whose root CI has no reason to trust.
        ignoreHTTPSErrors: true,
        // The loopback daemon emits no CORS headers (its cors middleware only mounts with auth on), so the
        // browser's cross-origin gate is lifted for the test context, the contract, not CORS, is under test.
        launchOptions: { args: [`--disable-web-security`] },
        trace: `retain-on-failure`,
    },
    projects: [{ name: `chromium`, use: { ...devices[`Desktop Chrome`] } }],
});
