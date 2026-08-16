import { defineConfig, devices } from "@playwright/test";
import { STORAGE_STATE } from "./src/world-file.js";

/* The onboarding tier: one journey, run once per way of getting a connected sandbox.
 *
 * Every address is decided at run time, so there is no `baseURL` here — a spec reads the world it was given
 * (world-file.ts) and navigates absolutely. `workers: 1` because the world is one seeded account and one
 * platform; the four paths differ only in provisioning, and running them against each other's rows would test
 * nothing they do not already share.
 *
 * `retries: 1` for the same reason the browser tier has it, and it matters more here: this tier blocks releases,
 * and a docker bridge flap must not. A real regression still fails twice.
 */
export default defineConfig({
    testDir: `./specs`,
    globalSetup: `./src/global-setup.ts`,
    // A journey provisions a sandbox, signs in, and waits on a model. Minutes, not seconds — and the ceiling is
    // here to catch a hang rather than to measure anything.
    timeout: 300_000,
    expect: { timeout: 30_000 },
    retries: 1,
    workers: 1,
    reporter: [[`list`]],
    outputDir: `./.cache/test-results`,
    use: {
        // Written by global setup — the seeded session, and the cached Google credential the sandbox client
        // refuses to call a daemon without. Written even when the tier stands down, so a skipped run does not
        // fail on a missing file (world-file.ts says why the path is shared rather than repeated).
        storageState: STORAGE_STATE,
        /* Two permissions the journey genuinely needs, granted rather than clicked through.
         *
         * `local-network-access` is the one that matters: a sandbox on the user's own machine is a loopback hop
         * away and the app reaches for it instead of going out to a tunnel and back — but that reach is INTO
         * the machine the browser runs on, which Chrome gates behind a permission. Headless denies it silently,
         * so the app falls back to a tunnel address that no hermetic run has, and the workspace sits on
         * "Connecting…" forever with nothing anywhere naming a permission.
         *
         * The clipboard pair is how the compose provisioner takes the bytes a user would paste, through the
         * page's own copy buttons. */
        permissions: [`local-network-access`, `clipboard-read`, `clipboard-write`],
        trace: `retain-on-failure`,
        // The world is served over plain http on a private network for the length of one run; nothing here has
        // a certificate, and a browser that insisted on one would be testing the harness.
        ignoreHTTPSErrors: true,
    },
    projects: [{ name: `compose`, use: { ...devices[`Desktop Chrome`] } }],
});
