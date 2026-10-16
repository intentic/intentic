import { defineConfig } from "@playwright/test";
import { RESULTS_DIR } from "./compat-tier.js";

// THE N-1 CHECK: this commit's editor against the sandbox image owners run. The hosted editor ships from every green push
// to main, while a sandbox takes a release a few times a day, so the editor that deploys always meets daemons older than
// itself. This boots the released daemon beside the sign-in tier's stack and walks the main pages, failing on a call the
// daemon refused, a read that failed, an uncaught error or the "too old" page. CI runs it nightly (`compat-stable`) and
// before the platform deploys (`e2e-compat`).
export default defineConfig({
    testDir: `.`,
    testMatch: `*.spec.ts`,
    globalSetup: `./compat-boot`,
    workers: 1,
    // A page that loads on the second try failed on the first, which is the one a person gets.
    retries: 0,
    // Hang bounds, not latency: the first paint parses the SPA's chunks on a busy runner.
    timeout: 180_000,
    expect: { timeout: 30_000 },
    reporter: [[`list`]],
    outputDir: RESULTS_DIR,
    use: {
        // The full baked chromium rather than the headless shell; ../playwright.config.ts carries the reasoning.
        channel: `chromium`,
        locale: `en-US`,
        viewport: { width: 1280, height: 800 },
        // The daemon runs with loopback auth off, which also leaves its CORS headers off; the browser tier says the same.
        launchOptions: { args: [`--disable-web-security`] },
        trace: `retain-on-failure`,
    },
});
