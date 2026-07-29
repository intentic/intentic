// Cross-product constants with exactly one source of truth. Shared by the proprietary platform and the
// public intentic.dev site so hand-synced values can't drift.

// The clickwrap legal version: the platform (@intentic-app/api) stamps the accepted version on each account
// at sign-up; intentic.dev renders the /terms and /privacy documents under it. Bump on any material change
// to the terms or privacy policy — one edit, both sides move together.
export const LEGAL_VERSION = "2026-07-03";
export const LEGAL_CONTACT_EMAIL = "contact@intentic.dev";

// The two fixed in-container ports the sandbox exposes: the daemon (oRPC + preview proxy front) and the app
// dev-server preview origin. The daemon binds them, the CLI/platform route Cloudflare ingress to them, and the
// state-resolver emits them into the workspace node — one source so container bind, ingress, and graph agree.
export const DAEMON_PORT = 8787;
export const PREVIEW_PORT = 5173;
