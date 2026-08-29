// Cross-product constants with exactly one source of truth. Shared by the proprietary platform and the
// public intentic.dev site so hand-synced values can't drift.

// The providers' brand marks: drawn by the app beside every session and by the site's cost band.
export * from "./provider-logos.js";

/* THE FOUR FIXED DIRECTORY LAYOUTS, for the same reason the ports below are here: a location spelled in two
 * files is a location that will eventually be two different locations. These are the ones that cross a package
 * boundary, the container's own dirs, the state folder inside a workspace, and the state root on a
 * provisioned host, each of which was previously typed out by hand in dozens of places with nothing linking
 * the copies, so a rename fixed some and silently orphaned the rest.
 *
 * These are VALUES, not lookups: this module stays importable from the browser (Setup.vue reads
 * PLATFORM_WEB_ORIGIN), so nothing here may touch node:fs. Code that has to DISCOVER a directory, the repo
 * root, a package root, imports the node-only helpers from `@intentic/constants/node` instead.
 *
 * WORKSPACE_ROOT and HISTORY_ROOT are DEFAULTS, not laws. The daemon's env.config takes both as overridable
 * settings and a running daemon must read them from its config, because an isolated turn re-points them; these
 * constants are what that config defaults to, and what code with no config in reach (contracts, docs strings,
 * the sync bridge's remote end) names. Anything holding a Config should prefer the config value. */

// The project workspace dir inside the sandbox container, the three repos are cloned under <root>/<role>.
export const WORKSPACE_ROOT = "/work";

// The daemon-owned snapshot history + protected repo git dirs, deliberately OUTSIDE WORKSPACE_ROOT so agent
// accidents (rm -rf, git clean) in the workspace can't reach it. A separate named volume.
export const HISTORY_ROOT = "/history";

/* The daemon's own state folder, relative to whichever workspace root is in force. Never join this by hand
 * where a typed helper exists: the daemon's `statePath()` takes the literal union of the files the state table
 * declares, so a store can only name a file that table knows about. This constant is for the callers OUTSIDE
 * that table, extensions writing under `.intentic/local/runtime`, ignore lists, path classifiers. */
export const STATE_DIR = ".intentic";

// Where the deploy CLI and providers keep per-service state on a PROVISIONED HOST (a server reached over ssh),
// as opposed to inside a sandbox container. Every service composes its own dir under this one.
export const HOST_STATE_ROOT = "/opt/intentic";

// The clickwrap legal version: the platform (@intentic-app/api) stamps the accepted version on each account
// at sign-up; intentic.dev renders the /terms and /privacy documents under it. Bump on any material change
// to the terms or privacy policy, one edit, both sides move together.
export const LEGAL_VERSION = "2026-08-13";
export const LEGAL_CONTACT_EMAIL = "contact@intentic.dev";

/* WHO THE COUNTERPARTY IS, in the words a contract needs. EU e-commerce law (Directive 2000/31 Art. 5, and in
 * Poland ustawa o świadczeniu usług drogą elektroniczną) requires a service provider to publish its name,
 * its registered address and its registration number where a recipient can find them without asking, so
 * these are not decoration on the legal pages, they are the pages' compliance.
 *
 * LEGAL_ENTITY_ADDRESS and LEGAL_ENTITY_TAX_ID are BLANK ON PURPOSE and the documents omit the lines they
 * would fill: publishing a wrong address is worse than publishing none, and an empty string here is a
 * question waiting for its owner rather than a placeholder that could ship looking like an answer. Fill both
 * before the hosted lane opens to anyone outside the author's own accounts. */
export const LEGAL_ENTITY_NAME = "Artur Kurowski, trading as radarsu";
export const LEGAL_ENTITY_COUNTRY = "Poland";
export const LEGAL_ENTITY_ADDRESS = "";
export const LEGAL_ENTITY_TAX_ID = "";

/* Where the platform's OWN servers stand, the account database and the API, as opposed to the hosted
 * sandboxes, whose region the provisioner decides per user and the privacy policy states outright.
 *
 * Blank for the same reason as the two above, and with more at stake: "our database is in the EU" is a
 * transfer statement a supervisory authority can hold you to, and it is not something the code can find out
 * about the machine an operator chose to deploy on. Set it to a place you can point at ("the European Union",
 * "Germany"); leave it empty and the privacy policy simply says nothing about platform server location
 * rather than guessing. */
export const PLATFORM_HOSTING_LOCATION = "";

/* The hosted web app's origin, the ONE browser origin a sandbox daemon expects to be called from, and
 * therefore the default its CORS is scoped to (sandbox env.config `webOrigin`).
 *
 * It is a security default, not a convenience one. The daemon's authenticated routes don't need CORS, a
 * caller without a bearer gets nothing, but /health is deliberately unauthenticated and answers with the
 * sandbox id, and the loopback listener sits on a 127.0.0.1 port derived from that same id. With a wildcard
 * ACAO, any page in the user's browser can walk that port range, read the id off /health, and derive the
 * sandbox's preview hostnames from it. Naming the origin is what closes that, and it costs nothing: the
 * hosted SPA is the only browser origin that ever legitimately calls a daemon.
 *
 * Self-hosters serving the SPA elsewhere set WEB_ORIGIN (comma-separated for several), the same way they
 * already set GOOGLE_CLIENT_ID. connect.{sh,ps1} keep their own literal copy, a shell script can't import
 * this, so the two are commented as a matched pair, like the Google client id above them. */
export const PLATFORM_WEB_ORIGIN = "https://app.intentic.dev";

/* The public site's origin: the marketing pages, and the host every install one-liner fetches its script from
 * (`curl -fsSL https://intentic.dev/connect | sh`). Here rather than only in the site's own content package
 * because the APP writes that URL into commands it hands out, and the site worker is what answers them. */
export const PLATFORM_SITE_ORIGIN = "https://intentic.dev";

/* THE INSTALL SCRIPTS, AND THE VANITY PATHS THAT SERVE THEM — one table for what was three.
 *
 * The scripts are tracked site assets (the monorepo has no public git mirror to raw-fetch from), so three
 * places had to agree on the same fifteen rows and none of them imported the others: the site worker mapped
 * path → filename to serve them, the app's scriptCommand.ts mapped key → URL to write one-liners and key →
 * repo path to run the working-tree copy in dev, and the site's own prose typed the URLs out by hand. A
 * script renamed in one is a `curl` of a 404 in another, and the 404 is the site's HTML error page piped
 * into `sh`.
 *
 * `path` is what the worker routes and what a one-liner fetches; `file` is the asset under
 * INSTALL_SCRIPTS_DIR. They are not derivable from each other in either direction: two vanity paths
 * (/rebuild and /update) deliberately serve the ONE recreate script, its mode riding the argument shape the
 * platform's cards already hand out, and the extensionless POSIX paths (/connect) serve a .sh file. */
export const INSTALL_SCRIPTS_DIR = "_site/site/public/scripts";

export const INSTALL_SCRIPTS = {
    sh: { path: "/connect", file: "connect.sh" },
    ps1: { path: "/connect.ps1", file: "connect.ps1" },
    // "computer", not "host": /connect-host enrolls a deploy TARGET, while /computer connects the machine the
    // user is sitting at, and the card they are copied from calls it a computer.
    hostSh: { path: "/connect-host", file: "connect-host.sh" },
    hostPs1: { path: "/connect-host.ps1", file: "connect-host.ps1" },
    cleanupHost: { path: "/cleanup-host", file: "cleanup-host.sh" },
    desktopSh: { path: "/sync", file: "sync.sh" },
    desktopPs1: { path: "/sync.ps1", file: "sync.ps1" },
    computerSh: { path: "/computer", file: "computer.sh" },
    computerPs1: { path: "/computer.ps1", file: "computer.ps1" },
    rebuild: { path: "/rebuild", file: "recreate.sh" },
    rebuildPs1: { path: "/rebuild.ps1", file: "recreate.ps1" },
    update: { path: "/update", file: "recreate.sh" },
    updatePs1: { path: "/update.ps1", file: "recreate.ps1" },
    cleanup: { path: "/cleanup", file: "cleanup.sh" },
    cleanupPs1: { path: "/cleanup.ps1", file: "cleanup.ps1" },
} as const satisfies Record<string, { path: string; file: string }>;

export type InstallScript = keyof typeof INSTALL_SCRIPTS;

/** The public URL a one-liner fetches — what a reader can also open to read the script before running it. */
export const installScriptUrl = (key: InstallScript): string => `${PLATFORM_SITE_ORIGIN}${INSTALL_SCRIPTS[key].path}`;

/** The script's path in the checkout, for the local-dev delivery that runs the working tree instead of the published copy. */
export const installScriptPath = (key: InstallScript): string => `${INSTALL_SCRIPTS_DIR}/${INSTALL_SCRIPTS[key].file}`;

/* THE FOUR FIXED IN-CONTAINER PORTS: the daemon (oRPC + preview proxy front), the app dev-server preview
 * origin, the loopback listener, and the bundled translator. The daemon binds them, the CLI/platform route
 * Cloudflare ingress to them, and the state-resolver emits them into the workspace node, one source so
 * container bind, ingress, and graph agree.
 *
 * ALL FOUR BELONG HERE, including the one nothing outside the container ever dials. The translator's port was
 * picked in the Dockerfile instead, as a literal inside TRANSLATOR_URL; when the loopback listener later
 * claimed the next number up, the two collided on 8788 and nothing could see it, the daemon won the bind and
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
 * TLS, while the loopback listener MUST, or Safari refuses it as mixed content (WebKit 171934). One port per
 * job, and neither constrains the other. */
export const LOCAL_PORT = 8788;

/* The bundled translator (CLIProxyAPI), which re-serves the user's Codex/Grok/Gemini subscriptions behind an
 * Anthropic-compatible endpoint for the Claude Code harness (sandbox app agent/translator.ts). Loopback-only
 * and never routed: the daemon dials it, and the agent CLIs it spawns point ANTHROPIC_BASE_URL at it, all
 * three inside this container. The Dockerfile bakes it into TRANSLATOR_URL, which is why the value has to be
 * legible from here rather than only from there. */
export const TRANSLATOR_PORT = 8789;
