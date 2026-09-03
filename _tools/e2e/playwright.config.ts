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
    /* `channel: chromium` names the FULL browser, run headless — not Playwright's headless shell.
     *
     * Since 1.49 a plain headless chromium launch resolves to `chromium-headless-shell`, a second binary with a
     * download of its own. The sandbox image installs chromium and then deletes that shell deliberately
     * (_sandbox/sandbox/packs/browser.Dockerfile): nothing in the daemon ever launches it — every browser tool
     * passes `--executable-path` from `chromium.executablePath()`, which is the full browser — and the shell is
     * the single loudest tell an anti-bot WAF looks for. This suite was the one caller that still asked for it,
     * and the runtime-install ledger is the bill: `npx playwright install chromium-headless-shell` run from this
     * package in two separate sessions, each time into /root/.cache, which no container recreate keeps.
     *
     * Naming the channel points the headless run at the chromium already baked into the image, so the suite
     * needs no download the image has not already made. CI is unaffected: `playwright install chromium` there
     * fetches the same binary this then uses. */
    projects: [{ name: `chromium`, use: { ...devices[`Desktop Chrome`], channel: `chromium` } }],
});
