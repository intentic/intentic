/* The strings the three tiers agree on. Kept together because two of them are also written down in
 * `_tools/desktop-smoke/smoke.sh`, the Linux tier asserts the same journey, and the day the two disagree about
 * what the setup screen is called is the day one of them is silently testing nothing.
 */

/** What Windows lists the app as, and what `installedApp` matches on. `productName` in the bundle config. */
export const PRODUCT_NAME = `Intentic`;

/** Tauri's bundle identifier, which names this app's directory under Windows' roaming app-data directory. */
export const APP_IDENTIFIER = `dev.intentic.desktop`;

/** The scheme the whole channel from the SPA into the app rides on. */
export const SCHEME = `intentic`;

/* The scheduled task `_tools/scripts/ci/setup-windows-runner.ps1` registers, by the name it registers it under.
 * Written down in both places and nowhere else: the doctor reads this task to tell a runner that will survive a
 * reboot from one somebody started by hand, and if the two names drift the doctor reports every properly
 * provisioned machine as hand-started. */
export const RUNNER_TASK_NAME = `GitHub Actions Runner`;

/* The link every tier fires. A setup link, because it is the one a first-time user meets and the only one
 * whose arrival is VISIBLE without a test hook: the app asks whether to run it, then parks a pending setup and
 * raises the setup screen. The code is nonsense on purpose; tier 1 points the platform at loopback and hands
 * the setup to a failing local CLI stand-in, while the nightly supplies real direct-token credentials. */
export const SETUP_LINK = `${SCHEME}://setup?code=windows-smoke-code&name=WindowsSmoke`;

/* What the app calls itself, matched on the distinctive half rather than the whole title so these assertions
 * survive the copy being reworded around them.
 *
 * The confirmation is the better proof of the two and is asserted first: it is a window that exists for no
 * other reason, where the setup screen has to be told apart from "the link was dropped and the app opened on
 * the workspace", a window appears either way, and only the title says which. */
export const CONFIRM_TITLE = `Set up a sandbox on this computer`;
export const SETUP_TITLE = `Setting up`;
export const WORKSPACE_TITLE = `Intentic`;

/* An RFC 2606 reserved TLD: resolvable by no one, so anything on this path that accidentally reaches for the
 * public network fails loudly instead of leaking traffic. The same choice, for the same reason, as
 * `verify-desktop-setup.sh` and `hermetic.e2e.test.ts`. */
export const SANDBOX_HOSTNAME = `winsmoke.e2e.test`;
export const PLATFORM_URL_UNREACHABLE = `https://platform.e2e.test`;

/** The direct-token path's stand-in credentials, see `connect.sh`'s own documentation of the codeless flow. */
export const CONNECT_TOKEN = `windows-setup-smoke-token`;
export const SANDBOX_GRANT = `dummy-reachability-grant`;
/* The edge the daemon would dial its tunnel to, on the same unroutable TLD: the dummy grant carries no valid
 * signature anyway, and naming an address that resolves nowhere keeps a failed dial off the real ingress. */
export const INGRESS_URL = `https://ingress.e2e.test`;
