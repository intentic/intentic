// Strings the three Windows tiers agree on; two are duplicated in _tools/desktop-smoke/smoke.sh's Linux tier, and drift
// between the two makes one of them silently test nothing.

/** What Windows lists the app as, and what installedApp matches on; productName in the bundle config. */
export const PRODUCT_NAME = `Intentic`;

/** Tauri's bundle identifier; names this app's directory under Windows' roaming app-data directory. */
export const APP_IDENTIFIER = `dev.intentic.desktop`;

/** The scheme the whole channel from the SPA into the app rides on. */
export const SCHEME = `intentic`;

// Scheduled task name setup-windows-runner.ps1 registers; drift misreports every provisioned machine.
export const RUNNER_TASK_NAME = `GitHub Actions Runner`;

// Setup deep-link every tier fires; the code is nonsense since tier 1 points at a failing local stand-in.
export const SETUP_LINK = `${SCHEME}://setup?code=windows-smoke-code&name=WindowsSmoke`;

// Titles matched on their distinctive half so a copy reword doesn't break these; the confirmation window is checked
// first since it exists for no other reason, unlike the ambiguous workspace-or-setup case.
export const CONFIRM_TITLE = `Set up a sandbox on this device`;
export const SETUP_TITLE = `Setting up`;
export const WORKSPACE_TITLE = `Intentic`;

// RFC 2606 reserved TLD: resolves for no one, so an accidental reach for the public network fails loudly instead of
// leaking traffic.
export const SANDBOX_HOSTNAME = `winsmoke.e2e.test`;
export const PLATFORM_URL_UNREACHABLE = `https://platform.e2e.test`;

/** Direct-token path's stand-in credentials; see connect.sh's own documentation of the codeless flow. */
export const CONNECT_TOKEN = `windows-setup-smoke-token`;
export const SANDBOX_GRANT = `dummy-reachability-grant`;
// Edge the daemon dials its tunnel to, on the same unroutable TLD, so a failed dial can't reach real ingress.
export const INGRESS_URL = `https://ingress.e2e.test`;
