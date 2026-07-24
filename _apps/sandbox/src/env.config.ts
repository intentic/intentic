import { resolve } from "node:path";
import { DAEMON_PORT, PREVIEW_PORT } from "@intentic/constants";
import { type ConfigDefinition, cliArgs, env, envFile, loadConfig as loadPuristicConfig } from "@puristic/env/index.js";
import { z } from "zod";

// All sandbox configuration, from env set at `docker run` — by connect.sh (your PC) or the workspace provider
// (a server). @puristic/env derives each env var name from the schema path (camelToScreamingSnake per segment,
// joined with "_"): workspaceRoot → WORKSPACE_ROOT, sandbox.publicUrl → SANDBOX_PUBLIC_URL, intenticAgentTools →
// INTENTIC_AGENT_TOOLS, claudeCodeOauthToken → CLAUDE_CODE_OAUTH_TOKEN.
// These names are the fixed contract the connect scripts / providers set, so the schema shape preserves them.
const configSchema = z.object({
    // The project workspace dir; the three repos (intent / desired-state / app) are cloned under <root>/<role>.
    workspaceRoot: z.string().default("/work"),
    // Where the daemon-owned snapshot history + protected repo git dirs live — OUTSIDE workspaceRoot so agent
    // accidents (rm -rf, git clean) in the workspace can't reach it. A second named volume in connect.sh.
    historyRoot: z.string().default("/history"),
    // Optional stable root for the AI-provider credential stores (Claude accounts, per-account CODEX_HOMEs,
    // OpenCode's XDG data dir holding xAI's auth.json) so subscription OAuth survives sandbox recreation.
    // Empty ⇒ <workspaceRoot>/.intentic (the production layout). Set by connect.sh's INTENTIC_AGENT_AUTH_VOLUME
    // dev mount.
    agentAuthDir: z.string().default(""),
    // pino level + whether to pretty-print (human-readable) instead of JSON — pretty only in dev.
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
    // Google identity may TOFU-bind as owner — so daemon ownership always matches the intentic account. Empty
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
    webOrigin: z.string().default(""),
    // Where the platform lives, for the daemon's announce (URL + liveness phone-home). Set by connect.{sh,ps1};
    // a localhost dev platform arrives as host.docker.internal. Empty ⇒ announcing disabled (tests, loopback).
    platform: z
        .object({
            url: z.string().default(""),
        })
        .prefault({}),
    // Intent-declared internal MCP tools (base64 JSON) the workspace provider set; constant for the sandbox.
    intenticAgentTools: z.string().default(""),
    // Daemon-wide default Claude model for turns that don't pin one (headless wakes like Discord). Empty ⇒
    // the account/subscription default. A per-automation `model` still overrides this.
    intenticAgentModel: z.string().default(""),
    // The image-baked iq embedding/reranker models dir (Dockerfile: IQ_MODEL_DIR=/opt/iq-models) — the resident
    // search engine's semantic tier. Empty (bare `tsx watch` dev run) ⇒ semantic degrades, everything else works.
    iqModelDir: z.string().default(""),
    // Explicit ripgrep path for the resident engine (same contract as the iq CLI's IQ_RG_PATH); empty ⇒ "rg"
    // from PATH (the image always has it).
    iqRgPath: z.string().default(""),
    // The image-baked iq Claude Code plugin dir (skill + SessionStart nudge) — prepended to the agent's
    // `plugins` so the agent prefers iq for code search, exactly as external users get it from the marketplace,
    // gated per sandbox by the iqSearch setting (opt-in, default off). Set by the Dockerfile
    // (IQ_PLUGIN_DIR=/opt/iq-plugin); empty on a bare `tsx watch` dev run (the plugin isn't baked outside the
    // image) ⇒ not loaded.
    iqPluginDir: z.string().default(""),
    // The image-baked first-party extensions dir (Dockerfile: EXTENSIONS_DIR=/opt/extensions). Each subdir is
    // an intentic-extension.json checkout (ext-discord, ext-connectors) enumerated alongside git-installed
    // extension capabilities by installedExtensions(). Empty on a bare `tsx watch` dev run ⇒ none baked (point
    // it at the repo's _extensions/ for local dev, see .env.example).
    extensionsDir: z.string().default(""),
    // The bundled translator (CLIProxyAPI) the Claude Code harness points at to serve NON-Claude providers
    // (codex/grok) under it on the user's subscription. `url` is what ANTHROPIC_BASE_URL is set to for a routed
    // turn (and the base for CLIProxyAPI's localhost Management API) — empty ⇒ no translator baked (e.g. a bare
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
    // Container-env Kimi (Moonshot) fallback cred: gates a Kimi turn when no key-based account is stored (a bare
    // dev run) and feeds the /kimi/models catalog discovery. Kimi runs on the Claude Code harness pointed at
    // Moonshot's Anthropic-compatible endpoint, so this is the key that endpoint authenticates with.
    moonshotApiKey: z.string().default("").meta({ secret: true }),
    // The user's Cloudflare API token, set by connect.{sh,ps1} on the own-Cloudflare path (empty on the
    // intentic-provided path — the user has no token). The infra panel's context reads its presence to know
    // whether host tunnels are minted by the user's CF (own) or relayed to the platform (intentic-provided).
    cloudflareApiToken: z.string().default("").meta({ secret: true }),
    sandbox: z
        .object({
            port: z.coerce.number().default(DAEMON_PORT),
            // Binds 0.0.0.0 by default (reached over the tunnel / host-internal ip); override for local runs.
            host: z.string().default("0.0.0.0"),
            // This sandbox's public URL (set by connect.{sh,ps1} after the tunnel is created).
            publicUrl: z.string().default(""),
            // Identity for the platform's Connections card; both must be set to surface anything.
            name: z.string().default(""),
            image: z.string().default(""),
            // sha256 of the approved overlay Dockerfile this container was built from, stamped by the rebuild
            // executor (rebuild.sh / workspace provider). Empty ⇒ stock image.
            environmentHash: z.string().default(""),
        })
        .prefault({}),
    preview: z
        .object({
            // The port the preview proxy listens on — the fixed origin the tunnel's preview routes front
            // (per-panel preview-<panel>-<id>.<zone> rules on the intentic-provided path, the *.<zone>
            // wildcard elsewhere). Each panel's port is auto-assigned when it starts; the proxy routes by Host.
            port: z.coerce.number().default(PREVIEW_PORT),
        })
        .prefault({}),
    google: z
        .object({
            // The Google *web* client id (public) — the audience the daemon verifies bearer ID tokens against.
            // Empty ⇒ loopback mode (no auth): tests, or the host-internal server preview.
            clientId: z.string().default(""),
        })
        .prefault({}),
});

// Local dev convenience: when the daemon runs bare (`tsx watch`) instead of inside its container, load the
// monorepo-root .env — the same file the api reads — so daemon creds (AI keys, CLOUDFLARE_API_TOKEN, …) don't
// have to be exported by hand. Absent in the container (nothing to read) ⇒ a no-op there.
const rootEnv = resolve(import.meta.dirname, "../../../.env");

// Sources (later wins): the local .env, then real env (what connect.{sh,ps1}/the provider set at `docker run`), then CLI.
const definition = {
    schema: configSchema,
    sources: [envFile(rootEnv), env(), cliArgs()],
} satisfies ConfigDefinition<typeof configSchema>;

export type Config = z.infer<typeof configSchema>;

export const loadConfig = (): Config => loadPuristicConfig(definition);
