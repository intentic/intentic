import { join } from "node:path";
import { DAEMON_PORT, HISTORY_ROOT, LOCAL_PORT, PLATFORM_WEB_ORIGIN, PREVIEW_PORT, WORKSPACE_ROOT } from "@intentic/constants";
import { repoRoot } from "@intentic/constants/node";
import { type ConfigDefinition, cliArgs, env, envFile, loadConfig as loadPuristicConfig } from "@puristic/env/index.js";
import { z } from "zod";

// All sandbox configuration, from env set at `docker run`, by connect.sh (your PC) or the workspace provider
// (a server). @puristic/env derives each env var name from the schema path (camelToScreamingSnake per segment,
// joined with "_"): workspaceRoot → WORKSPACE_ROOT, sandbox.publicUrl → SANDBOX_PUBLIC_URL, intenticAgentTools →
// INTENTIC_AGENT_TOOLS, claudeCodeOauthToken → CLAUDE_CODE_OAUTH_TOKEN.
// These names are the fixed contract the connect scripts / providers set, so the schema shape preserves them.
const configSchema = z.object({
    // The project workspace dir; the three repos (intent / desired-state / app) are cloned under <root>/<role>.
    workspaceRoot: z.string().default(WORKSPACE_ROOT),
    // Where the daemon-owned snapshot history + protected repo git dirs live. OUTSIDE workspaceRoot so agent
    // accidents (rm -rf, git clean) in the workspace can't reach it. A second named volume in connect.sh.
    historyRoot: z.string().default(HISTORY_ROOT),
    // Optional stable root for the AI-provider credential stores (Claude accounts, per-account CODEX_HOMEs,
    // OpenCode's XDG data dir holding xAI's auth.json) so subscription OAuth survives sandbox recreation.
    // Empty ⇒ <workspaceRoot>/.intentic (the production layout). Set by connect.sh's INTENTIC_AGENT_AUTH_VOLUME
    // dev mount.
    agentAuthDir: z.string().default(""),
    // pino level + whether to pretty-print (human-readable) instead of JSON, pretty only in dev.
    logLevel: z.string().default("info"),
    logPretty: z
        .string()
        .default("")
        .transform((value) => value === "true" || value === "1"),
    // Cloudflare zone for the scaffolded app's domain (else derived from the public URL's host minus its label).
    zone: z.string().default(""),
    // The first-bind connection token (TOFU owner gate) and the platform web origin scoped for CORS.
    connectToken: z.string().default("").meta({ secret: true }),
    // The account email this sandbox was created under (setup seeds it via the setup code). When set, ONLY this
    // Google identity may TOFU-bind as owner, so daemon ownership always matches the intentic account. Empty
    // (headless / direct connect.sh with no setup code) ⇒ fall back to plain trust-on-first-use.
    owner: z
        .object({
            email: z.string().default(""),
        })
        .prefault({}),
    // Setup-time desktop-sync pairing: connect.{sh,ps1} passes the claim's SYNC_PAIR_TOKEN here; seeded at boot
    // as a normal single-use pairing so the connect script's sync agent can enroll without the browser minting
    // one. Same trust class as connectToken (both live in the container env); empty ⇒ no seed.
    syncPairToken: z.string().default("").meta({ secret: true }),
    /* Setup-time CONNECTED-COMPUTER pairing, and what to call the machine it enrolls. Same trust class and same
     * one-shot rule as syncPairToken above: the connect flow passes the claim's HOST_PAIR_TOKEN here, the daemon
     * arms it once, and the machine agent the same flow installed redeems it. Empty ⇒ no computer is connected,
     * which is every sandbox set up before this existed and every headless one.
     *
     * The platform and hostname come from the flow because the daemon cannot see either: it is in a container
     * whose hostname is its own, on an OS that is always Linux however the machine outside is spelled. */
    hostPairToken: z.string().default("").meta({ secret: true }),
    hostPlatform: z.string().default(""),
    hostLabel: z.string().default(""),
    /* The browser origin(s) the daemon emits CORS for, comma-separated, defaulting to the hosted app.
     *
     * Defaulted rather than left open because CORS is the only thing guarding the routes that have no bearer to
     * check: /health is unauthenticated by design (it is the liveness + identity probe) and answers with the
     * sandbox id, and the loopback listener's port derives from that id, so a wildcard let any page in the
     * user's browser scan loopback, learn the id, and walk the sandbox's preview hostnames. Authenticated routes
     * were never at risk; this is about the ones that answer without a credential.
     *
     * A self-hosted SPA sets this to its own origin (add several with commas, e.g. a localhost dev origin
     * alongside the hosted one).
     *
     * EMPTY FALLS BACK TO THE DEFAULT, which is why this is a transform and not a plain `.default()`. Sandboxes
     * built before this existed have a literal `WEB_ORIGIN=` in their container env, connect.sh emitted the var
     * unconditionally, and REPLAY_ENV carries it through every rebuild. Zod treats "present but empty" as a
     * value, so a plain default would leave exactly those sandboxes with an empty allowlist: CORS denies the
     * SPA, and the workspace goes dark on upgrade. There is also no reader for "allow nobody", a daemon no
     * browser may call is not a configuration anyone wants, so collapsing empty onto the default loses nothing. */
    webOrigin: z
        .string()
        .default("")
        .transform((value) => (value.trim() === "" ? PLATFORM_WEB_ORIGIN : value)),
    /* The HOSTED lane's economics, daemon-side: minutes of nobody-connected-and-nothing-running before the
     * daemon exits cleanly so its machine can stop, compute on a platform-run machine bills while this
     * process lives, and the platform wakes it again on the next visit (system/idle-stop.ts owns the verdict).
     * 0 (the default) disables: every non-hosted flavor runs always-on, exactly as before. Set by the hosted
     * provisioner from the platform's config, never by connect flows. */
    idleStopMinutes: z.coerce.number().int().nonnegative().default(0),
    /* THE SANDBOX'S REACHABILITY GRANT on the platform's self-hosted tunnel hub, set by every creation flow
     * from the setup claim (ZROK_TOKEN / ZROK_API / ZROK_NAMESPACE). The entrypoint enables the agent and
     * shares the daemon with it; the daemon uses `namespace` to attach its own preview/port/outbox names
     * (panels/preview-route.ts), which is naming the platform used to do on Cloudflare's behalf. Empty ⇒ this
     * sandbox is reached some other way (an attached domain, or loopback in dev) and nothing is shared. */
    zrok: z
        .object({
            token: z.string().default("").meta({ secret: true }),
            api: z.string().default(""),
            namespace: z.string().default(""),
        })
        .prefault({}),
    // Where the platform lives, for the daemon's announce (URL + liveness phone-home). Set by connect.{sh,ps1};
    // a localhost dev platform arrives as host.docker.internal. Empty ⇒ announcing disabled (tests, loopback).
    platform: z
        .object({
            url: z.string().default(""),
        })
        .prefault({}),
    // The ACME directory the LOOPBACK CERTIFICATE is ordered from (see platform/local-cert.ts). Empty ⇒ Let's
    // Encrypt production. Point it at the staging directory
    // (https://acme-staging-v02.api.letsencrypt.org/directory) to exercise issuance end to end without
    // spending the production rate limit, staging certificates are untrusted, so the browser's probe will
    // reject them and fall back, which is exactly the behaviour you want while testing the ORDER.
    acmeDirectoryUrl: z.string().default(""),
    // Intent-declared internal MCP tools (base64 JSON) the workspace provider set; constant for the sandbox.
    intenticAgentTools: z.string().default(""),
    // Daemon-wide default Claude model for turns that don't pin one (headless wakes like Discord). Empty ⇒
    // the account/subscription default. A per-automation `model` still overrides this.
    intenticAgentModel: z.string().default(""),
    // The image-baked iq embedding/reranker models dir (Dockerfile: IQ_MODEL_DIR=/opt/iq-models), the resident
    // search engine's semantic tier. Empty (bare `tsx watch` dev run) ⇒ semantic degrades, everything else works.
    iqModelDir: z.string().default(""),
    // Explicit ripgrep path for the resident engine (same contract as the iq CLI's IQ_RG_PATH); empty ⇒ "rg"
    // from PATH (the image always has it).
    iqRgPath: z.string().default(""),
    // The image-baked iq Claude Code plugin dir (skill + SessionStart nudge), prepended to the agent's
    // `plugins` so the agent prefers iq for code search, exactly as external users get it from the marketplace,
    // gated per sandbox by the iqSearch setting (opt-in, default off). Set by the Dockerfile
    // (IQ_PLUGIN_DIR=/opt/iq-plugin); empty on a bare `tsx watch` dev run (the plugin isn't baked outside the
    // image) ⇒ not loaded.
    iqPluginDir: z.string().default(""),
    // The image-baked webq Claude Code plugin dir (the skill teaching agents to fetch web pages as budgeted
    // markdown with the webq CLI). Loaded ungated whenever baked — the CLI is always on PATH, so unlike iq
    // there is no setting to mirror. Set by the Dockerfile (WEBQ_PLUGIN_DIR=/opt/webq-plugin); empty on a
    // bare `tsx watch` dev run ⇒ not loaded.
    webqPluginDir: z.string().default(""),
    // The image-baked first-party extensions dir (Dockerfile: EXTENSIONS_DIR=/opt/extensions). Each subdir is
    // an intentic-extension.json checkout (ext-discord, ext-connectors) enumerated alongside git-installed
    // extension capabilities by installedExtensions(). Empty on a bare `tsx watch` dev run ⇒ none baked (point
    // it at the repo's _extensions/ for local dev, see .env.example).
    extensionsDir: z.string().default(""),
    // The bundled translator (CLIProxyAPI) the Claude Code harness points at to serve NON-Claude providers
    // under it on the user's subscription. `url` is what ANTHROPIC_BASE_URL is set to for a routed
    // turn (and the base for CLIProxyAPI's localhost Management API), empty ⇒ no translator baked (e.g. a bare
    // `tsx watch` dev run) ⇒ routed turns surface a clean error; `token` is a fixed local bearer, accepted both as
    // ANTHROPIC_AUTH_TOKEN (downstream) and as the Management API key. Both set by the Dockerfile.
    translator: z
        .object({
            url: z.string().default(""),
            token: z.string().default("").meta({ secret: true }),
        })
        .prefault({}),
    // Container-env Claude fallback creds: used only to decide whether a turn can run when no account is stored.
    claudeCodeOauthToken: z.string().default("").meta({ secret: true }),
    anthropicApiKey: z.string().default("").meta({ secret: true }),
    // Container-env OpenAI fallback cred: gates native Codex turns (the OPENAI_API_KEY fallback CODEX_HOME when a
    // turn resolved no connected ChatGPT account).
    openaiApiKey: z.string().default("").meta({ secret: true }),
    // The user's Cloudflare API token, set by connect.{sh,ps1} on the own-Cloudflare path (empty on the
    // intentic-provided path, the user has no token). The infra panel's context reads its presence to know
    // whether host tunnels are minted by the user's CF (own) or relayed to the platform (intentic-provided).
    cloudflareApiToken: z.string().default("").meta({ secret: true }),
    sandbox: z
        .object({
            /* WHICH POSTURE THIS DAEMON RUNS IN. "container" is the shipped sandbox image, the two-volume
             * layout, a tunnel, HOME converged onto the volumes, container furniture started at boot.
             * "local" is a plain process on the machine's own account, serving a folder the user already owns:
             * loopback only, HOME never claimed, repos never reshaped, no container furniture. The traits a
             * subsystem may branch on, and the floor that refuses a contradictory local config, live in
             * platform/profile.ts; nothing reads this value directly. */
            profile: z.enum(["container", "local"]).default("container"),
            port: z.coerce.number().default(DAEMON_PORT),
            // Binds 0.0.0.0 by default (reached over the tunnel / host-internal ip); override for local runs.
            // Inside the container this is not an exposure: only the loopback listener's port is published,
            // and only to the host's 127.0.0.1 (@intentic/sandbox-run localDaemonPort).
            host: z.string().default("0.0.0.0"),
            // This sandbox's public URL (set by connect.{sh,ps1} after the tunnel is created).
            publicUrl: z.string().default(""),
            /* THE ONLY WAY PAST THE AUTH FLOOR (main.ts requireAuthWhenReachable), and it exists for exactly one
             * caller: the gated e2e tiers. They must set a CONNECT_TOKEN, the desktop-sync surface derives its
             * ssh hostname from one and answers 409 without it, and they drive every route with no credential
             * at all, because a container on a testcontainers-mapped port is reachable by nobody but the test.
             * That is the contradiction the floor refuses, so the harness states it out loud rather than leaving
             * the floor to guess which reachable daemons are real.
             *
             * NOTHING THAT SHIPS SETS THIS: not connect.{sh,ps1}, not recreate.sh, not the workspace provider,
             * the two e2e harnesses are the whole caller list, and a daemon that honours it says so on stderr at
             * every boot. A real sandbox's answer to the floor is GOOGLE_CLIENT_ID, which is why the fatal
             * message names that and not this. */
            allowUnauthenticated: z
                .string()
                .default("")
                .transform((value) => value === "true" || value === "1"),
            // Identity for the platform's Connections card; both must be set to surface anything.
            name: z.string().default(""),
            image: z.string().default(""),
            // The UPSTREAM image the composed overlay must extend, set by whichever runner created this
            // container (recreate.sh) to the base it actually built FROM. Distinct
            // from `image` because after a rebuild `image` is the overlay's own tag
            // (intentic-sandbox-env-<slug>:<hash>), which would be a nonsense base to compose against.
            // Empty ⇒ derive it from `image` (a fresh connect.sh run IS running the base). Runner-set, so the
            // agent cannot influence which image a rebuild extends.
            baseImage: z.string().default(""),
            // sha256 of the approved overlay Dockerfile this container was built from, stamped by the rebuild
            // executor (recreate.sh / workspace provider). Empty ⇒ stock image.
            environmentHash: z.string().default(""),
            /* WHICH RELEASE CHANNEL this sandbox follows, and THE WAY BACK from the swap that created it,
             * the protected tag ic pinned the replaced image under, exactly what `ic sandbox rollback` will
             * run. Both runner-set (the recreate flow, which is the only thing that can know either, it
             * performed the swap, and the previous container is gone by the time the daemon boots), so the
             * agent cannot influence what an update pulls or what a rollback returns to.
             *
             * Empty channel ⇒ a sandbox created before channels existed, which is `stable` by construction:
             * that is the only tag update has ever pulled. Empty previousImage ⇒ nothing to roll back to,
             * and the Update card offers none. */
            channel: z.string().default(""),
            previousImage: z.string().default(""),
            /* A sandbox definition (sandbox.toml, base64) to seed an EMPTY workspace from on first boot: the
             * fleet door, sandbox-run's `definition` option stamps it. Applied only while the workspace is
             * still as it arrived (scaffold's workspaceArrivedEmpty), so a rebuild replaying this env cannot
             * re-run it over work; and applying it keeps the definition's consent shape, the overlay lands as
             * a proposal for the owner, never as an approved build. */
            definitionSeed: z.string().default(""),
        })
        .prefault({}),
    preview: z
        .object({
            // The port the preview proxy listens on, the fixed origin the tunnel's preview routes front
            // (per-panel preview-<panel>-<id>.<zone> rules on the intentic-provided path, the *.<zone>
            // wildcard elsewhere). Each panel's port is auto-assigned when it starts; the proxy routes by Host.
            port: z.coerce.number().default(PREVIEW_PORT),
        })
        .prefault({}),
    local: z
        .object({
            // The port the LOOPBACK LISTENER binds, the same app as `sandbox.port`, and the only port ever
            // published to the host, so a browser on this machine skips the tunnel. Separate from the daemon
            // port because that one must stay plain HTTP for the connector while this one carries TLS.
            port: z.coerce.number().default(LOCAL_PORT),
        })
        .prefault({}),
    google: z
        .object({
            // The Google *web* client id (public), the audience the daemon verifies bearer ID tokens against.
            // Empty ⇒ loopback mode (no auth): tests, or the host-internal server preview.
            clientId: z.string().default(""),
        })
        .prefault({}),
});

/* Local dev convenience: when the daemon runs bare (`tsx watch`) instead of inside its container, load the
 * monorepo-root .env, the same file the api reads, so daemon creds (AI keys, CLOUDFLARE_API_TOKEN, …) don't
 * have to be exported by hand.
 *
 * INSIDE THE CONTAINER THERE IS NO CHECKOUT, so the walk finds no marker and throws, which is why this is
 * caught rather than propagated. The absent-file case was always a no-op here (the daemon's real config comes
 * from the container env); an absent REPO is the same no-op, one level further out, and `envFile` treats the
 * empty path exactly as it treated the container's non-existent one. */
const rootEnvPath = (): string => {
    try {
        return join(repoRoot(import.meta.url), ".env");
    } catch {
        return "";
    }
};
const rootEnv = rootEnvPath();

// Sources (later wins): the local .env, then real env (what connect.{sh,ps1}/the provider set at `docker run`), then CLI.
const definition = {
    schema: configSchema,
    sources: [envFile(rootEnv), env(), cliArgs()],
} satisfies ConfigDefinition<typeof configSchema>;

export type Config = z.infer<typeof configSchema>;

export const loadConfig = (): Config => loadPuristicConfig(definition);
