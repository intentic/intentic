import { defineConfig } from "@playwright/test";
import { RESULTS_DIR } from "./stack.js";

// THE SIGN-IN GATE: a person with no session signs in, on the web and through the desktop app, against the real web
// build, the real api and real Postgres, with only Google stood in for (google.ts says where and why). CI runs it as
// `e2e-signin`, and the platform deploy (`images-platform`) waits on it: a build nobody can sign in to never ships.
export default defineConfig({
    testDir: `.`,
    testMatch: `*.spec.ts`,
    globalSetup: `./global-setup`,
    // The specs share one api and one database; each makes its own person, but one worker keeps the api's log readable.
    workers: 1,
    // A sign-in that works on the second try is broken on the first, which is the try a person gets.
    retries: 0,
    // Hang bounds, not latency: the first paint parses the SPA's chunks on a busy runner.
    timeout: 90_000,
    expect: { timeout: 20_000 },
    reporter: [[`list`]],
    outputDir: RESULTS_DIR,
    use: {
        // The full baked chromium rather than the headless shell; ../playwright.config.ts carries the reasoning.
        channel: `chromium`,
        // The page picks its language from the browser's; the labels the specs find controls by are the English ones.
        locale: `en-US`,
        viewport: { width: 1280, height: 800 },
        trace: `retain-on-failure`,
    },
});
