// Cross-product constants with exactly one source of truth. Shared by the proprietary platform and the
// public intentic.dev site so hand-synced values can't drift.

// The clickwrap legal version: the platform (@intentic-app/api) stamps the accepted version on each account
// at sign-up; intentic.dev renders the /terms and /privacy documents under it. Bump on any material change
// to the terms or privacy policy — one edit, both sides move together.
export const LEGAL_VERSION = "2026-07-03";
export const LEGAL_CONTACT_EMAIL = "contact@intentic.dev";

/* The hosted web app's origin — the ONE browser origin a sandbox daemon expects to be called from, and
 * therefore the default its CORS is scoped to (sandbox env.config `webOrigin`).
 *
 * It is a security default, not a convenience one. The daemon's authenticated routes don't need CORS — a
 * caller without a bearer gets nothing — but /health is deliberately unauthenticated and answers with the
 * sandbox id, and the loopback listener sits on a 127.0.0.1 port derived from that same id. With a wildcard
 * ACAO, any page in the user's browser can walk that port range, read the id off /health, and derive the
 * sandbox's preview hostnames from it. Naming the origin is what closes that, and it costs nothing: the
 * hosted SPA is the only browser origin that ever legitimately calls a daemon.
 *
 * Self-hosters serving the SPA elsewhere set WEB_ORIGIN (comma-separated for several), the same way they
 * already set GOOGLE_CLIENT_ID. connect.{sh,ps1} keep their own literal copy — a shell script can't import
 * this — so the two are commented as a matched pair, like the Google client id above them. */
export const PLATFORM_WEB_ORIGIN = "https://app.intentic.dev";

/* THE FOUR FIXED IN-CONTAINER PORTS: the daemon (oRPC + preview proxy front), the app dev-server preview
 * origin, the loopback listener, and the bundled translator. The daemon binds them, the CLI/platform route
 * Cloudflare ingress to them, and the state-resolver emits them into the workspace node — one source so
 * container bind, ingress, and graph agree.
 *
 * ALL FOUR BELONG HERE, including the one nothing outside the container ever dials. The translator's port was
 * picked in the Dockerfile instead, as a literal inside TRANSLATOR_URL; when the loopback listener later
 * claimed the next number up, the two collided on 8788 and nothing could see it — the daemon won the bind and
 * cli-proxy-api died on arrival on every sandbox, taking every routed (Codex/Grok/Gemini) turn with it. A port
 * that is not in this file is a port the next pick cannot avoid, so a fixed bind anywhere in the container is
 * declared here and asserted distinct (sandbox app, container-ports.test.ts). */
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

/* The bundled translator (CLIProxyAPI), which re-serves the user's Codex/Grok/Gemini subscriptions behind an
 * Anthropic-compatible endpoint for the Claude Code harness (sandbox app agent/translator.ts). Loopback-only
 * and never routed: the daemon dials it, and the agent CLIs it spawns point ANTHROPIC_BASE_URL at it — all
 * three inside this container. The Dockerfile bakes it into TRANSLATOR_URL, which is why the value has to be
 * legible from here rather than only from there. */
export const TRANSLATOR_PORT = 8789;

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
