// Cross-product constants with one source of truth, shared by the platform and the public intentic.dev site so
// hand-synced values can't drift.

export * from "./provider-logos.js";

// Fixed directory layouts shared across the package boundary; kept as plain values (no node:fs) since this module is
// importable from the browser. WORKSPACE_ROOT and HISTORY_ROOT are just defaults: a running daemon reads its actual
// roots from config, since an isolated turn re-points them.

// Project workspace dir inside the sandbox container; the three repos are cloned under <root>/<role>.
export const WORKSPACE_ROOT = "/work";

// Daemon-owned snapshot history, kept outside WORKSPACE_ROOT so a workspace-scoped `rm -rf` can't reach it.
export const HISTORY_ROOT = "/history";

// Daemon's own state folder; join through the state table's typed helpers instead, not by hand.
export const STATE_DIR = ".intentic";

// The owner's standing instructions, one filename for every runtime: the daemon reads it and composes it into each
// turn's instructions itself, so no loop's own discovery decides which rules a turn ran under. One per folder, read
// from the workspace root down to where the turn starts.
export const MEMORY_FILE = "AGENTS.md";

// Per-service state root on a provisioned host reached over ssh, as opposed to inside a sandbox container.
export const HOST_STATE_ROOT = "/opt/intentic";

// Clickwrap version stamped at sign-up; bump on any material change to the terms or privacy policy.
export const LEGAL_VERSION = "2026-09-03";
export const LEGAL_CONTACT_EMAIL = "contact@intentic.dev";

// Legal-entity identification EU e-commerce law requires published on the site. ADDRESS and TAX_ID are deliberately
// blank until set: an empty field omits the line, a wrong one would not.
export const LEGAL_ENTITY_NAME = "Artur Kurowski, trading as radarsu";
export const LEGAL_ENTITY_COUNTRY = "Poland";
export const LEGAL_ENTITY_ADDRESS = "";
export const LEGAL_ENTITY_TAX_ID = "";

// Platform's own server location; blank leaves the privacy policy silent instead of guessing.
export const PLATFORM_HOSTING_LOCATION = "";

// Not a convenience default: a wildcard would let any page enumerate the loopback port off /health.
export const PLATFORM_WEB_ORIGIN = "https://app.intentic.dev";

// Public site origin; also where install one-liners (`curl ... | sh`) fetch their script from.
export const PLATFORM_SITE_ORIGIN = "https://intentic.dev";

// One table for what three places once hand-typed separately: `path` is what a one-liner fetches, `file` is the asset
// under INSTALL_SCRIPTS_DIR. /rebuild and /update deliberately share one file.
export const INSTALL_SCRIPTS_DIR = "_site/site/public/scripts";

export const INSTALL_SCRIPTS = {
    sh: { path: "/connect", file: "connect.sh" },
    ps1: { path: "/connect.ps1", file: "connect.ps1" },
    // "device", not "host": /connect-host enrolls a deploy target, /device connects the machine the user is on.
    hostSh: { path: "/connect-host", file: "connect-host.sh" },
    hostPs1: { path: "/connect-host.ps1", file: "connect-host.ps1" },
    cleanupHost: { path: "/cleanup-host", file: "cleanup-host.sh" },
    desktopSh: { path: "/sync", file: "sync.sh" },
    desktopPs1: { path: "/sync.ps1", file: "sync.ps1" },
    deviceSh: { path: "/device", file: "device.sh" },
    devicePs1: { path: "/device.ps1", file: "device.ps1" },
    rebuild: { path: "/rebuild", file: "recreate.sh" },
    rebuildPs1: { path: "/rebuild.ps1", file: "recreate.ps1" },
    update: { path: "/update", file: "recreate.sh" },
    updatePs1: { path: "/update.ps1", file: "recreate.ps1" },
    cleanup: { path: "/cleanup", file: "cleanup.sh" },
    cleanupPs1: { path: "/cleanup.ps1", file: "cleanup.ps1" },
} as const satisfies Record<string, { path: string; file: string }>;

export type InstallScript = keyof typeof INSTALL_SCRIPTS;

/** Public URL a one-liner fetches, and what a reader can open to read the script first. */
export const installScriptUrl = (key: InstallScript): string => `${PLATFORM_SITE_ORIGIN}${INSTALL_SCRIPTS[key].path}`;

/** Script's path in the checkout, for local dev that runs the working tree instead of the published copy. */
export const installScriptPath = (key: InstallScript): string => `${INSTALL_SCRIPTS_DIR}/${INSTALL_SCRIPTS[key].file}`;

// Every port bound inside the container is declared here and asserted distinct, so two services can never silently
// collide.
export const DAEMON_PORT = 8787;
export const PREVIEW_PORT = 5173;

// Loopback listener, published to the host; must be TLS since Safari blocks mixed content.
export const LOCAL_PORT = 8788;

// Bundled translator port, loopback-only; the Dockerfile bakes this value into TRANSLATOR_URL.
export const TRANSLATOR_PORT = 8789;

// Public web client id, not secret; four places must agree on it or sign-in silently breaks.
export const GOOGLE_CLIENT_ID = "481795963975-cq9msl6higcd91joidrfp8mjlkuq5fk3.apps.googleusercontent.com";

// localStorage slot for the cached ID token, keyed by client id so a rotation can't reuse it.
export const GOOGLE_TOKEN_STORAGE_KEY = `intentic.gid.${GOOGLE_CLIENT_ID}`;
