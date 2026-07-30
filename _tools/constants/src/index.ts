// Cross-product constants with exactly one source of truth. Shared by the proprietary platform and the
// public intentic.dev site so hand-synced values can't drift.

// The clickwrap legal version: the platform (@intentic-app/api) stamps the accepted version on each account
// at sign-up; intentic.dev renders the /terms and /privacy documents under it. Bump on any material change
// to the terms or privacy policy — one edit, both sides move together.
export const LEGAL_VERSION = "2026-07-03";
export const LEGAL_CONTACT_EMAIL = "contact@intentic.dev";

// The three fixed in-container ports the sandbox exposes: the daemon (oRPC + preview proxy front), the app
// dev-server preview origin, and the loopback listener. The daemon binds them, the CLI/platform route
// Cloudflare ingress to them, and the state-resolver emits them into the workspace node — one source so
// container bind, ingress, and graph agree.
export const DAEMON_PORT = 8787;
export const PREVIEW_PORT = 5173;

/* The LOOPBACK listener: the same daemon app on a second port, the only one ever published to the host, so a
 * browser on this machine can skip the Cloudflare round trip (@intentic/sandbox-run localDaemonPort).
 *
 * Separate from DAEMON_PORT because the two speak different protocols. The tunnel connector's ingress dials
 * `http://intentic-sandbox-workspace:8787` in plain HTTP over the container network, so 8787 can never carry
 * TLS — while the loopback listener MUST, or Safari refuses it as mixed content (WebKit 171934). One port per
 * job, and neither constrains the other. */
export const LOCAL_PORT = 8788;

/* The Linux capabilities EVERY sandbox workspace container is granted at creation — the container's security
 * posture, defined once because it has to hold across six creation paths in four dialects: the platform
 * provider's docker run over SSH (providers/host/workspace.ts), the compose generator (web setupCompose.ts),
 * and four hand-served scripts (connect.sh / rebuild.sh / update.sh on the site, dev-sandbox.sh in the
 * sandbox app; connect.ps1 mirrors connect.sh). The flag drifted once: SYS_ADMIN was added to the provider
 * alone, so every sandbox created or rebuilt through the scripts silently lost turn isolation — and
 * "recreate the sandbox to restore isolation" recreated it through a door that could not grant it.
 *
 * TS consumers import this and splice it into what they emit. The scripts cannot import anything — they are
 * curl-served standalone files — so a discovery test (sandbox app, sandbox-run-contract.test.ts) scans the
 * repo for every docker-run/compose that mounts /work and asserts each grants exactly these. Add a
 * capability here and that test names every file still to update; add a creation path anywhere and the test
 * finds it by its /work mount, not by being told.
 *
 * SYS_ADMIN: lets the daemon give each isolated agent turn its own mount namespace, with the conversation's
 * worktree standing in for /work (sandbox app agents/isolation.ts). Scoped to the container's own mounts —
 * not host access, and the docker socket is never mounted. */
export const SANDBOX_CAPABILITIES = ["SYS_ADMIN"] as const;
