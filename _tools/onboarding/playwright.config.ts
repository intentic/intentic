import { defineConfig, devices } from "@playwright/test";
import { STORAGE_STATE } from "./src/world-file.js";

// No `baseURL`: a spec reads its world (world-file.ts) and navigates absolutely. `workers: 1`: one seeded account and
// platform shared by all four provisioning paths. `retries: 1`: this tier blocks releases, so a docker bridge flap must
// not fail it; a real regression still fails twice.
export default defineConfig({
    testDir: `./specs`,
    globalSetup: `./src/global-setup.ts`,
    // Minutes, not seconds: provisioning, sign-in and waiting on a model; catches a hang, not a measurement.
    timeout: 300_000,
    expect: { timeout: 30_000 },
    retries: 1,
    workers: 1,
    reporter: [[`list`]],
    outputDir: `./.cache/test-results`,
    use: {
        // Written by global setup even when the tier stands down, so a skipped run never fails on a missing file.
        storageState: STORAGE_STATE,
        // `local-network-access` lets headless reach the sandbox's loopback; without it the app hangs on "Connecting…".
        permissions: [`local-network-access`, `clipboard-read`, `clipboard-write`],
        trace: `retain-on-failure`,
        // World is plain http on a private network for one run; nothing here has a certificate.
        ignoreHTTPSErrors: true,
    },
    // Project NAME is the provisioner lookup key (`compose`, `ic`); uses full chromium, not the headless shell.
    projects: [
        { name: `compose`, use: { ...devices[`Desktop Chrome`], channel: `chromium` } },
        { name: `ic`, use: { ...devices[`Desktop Chrome`], channel: `chromium` } },
    ],
});
