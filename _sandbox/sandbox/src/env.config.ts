import { join } from "node:path";
import { DAEMON_PORT, HISTORY_ROOT, LOCAL_PORT, PLATFORM_WEB_ORIGIN, PREVIEW_PORT, WORKSPACE_ROOT } from "@intentic/constants";
import { repoRoot } from "@intentic/constants/node";
import { type ConfigDefinition, cliArgs, env, envFile, loadConfig as loadPuristicConfig } from "@puristic/env/index.js";
import { z } from "zod";

// Env var name = schema path in SCREAMING_SNAKE per segment; the shape is a fixed external contract.
const configSchema = z.object({
    // Workspace dir; the three repos (intent, desired-state, app) clone under <root>/<role>.
    workspaceRoot: z.string().default(WORKSPACE_ROOT),
    // Daemon-owned history and protected git dirs; kept outside workspaceRoot so an agent rm -rf can't reach it.
    historyRoot: z.string().default(HISTORY_ROOT),
    // Stable root for provider credential stores so OAuth survives recreation; empty ⇒ <workspaceRoot>/.intentic.
    agentAuthDir: z.string().default(""),
    // pino level, plus whether to pretty-print instead of JSON (dev only).
    logLevel: z.string().default("info"),
    logPretty: z
        .string()
        .default("")
        .transform((value) => value === "true" || value === "1"),
    // Cloudflare zone for the app's domain; else derived from the public URL's host minus its label.
    zone: z.string().default(""),
    // First-bind connection token: the TOFU owner gate.
    connectToken: z.string().default("").meta({ secret: true }),
    // Account email this sandbox was created under; when set, only that Google identity may TOFU-bind as owner.
    owner: z
        .object({
            email: z.string().default(""),
        })
        .prefault({}),
    // Setup-time desktop-sync pairing from connect.{sh,ps1}, same trust class as connectToken; empty ⇒ no seed.
    syncPairToken: z.string().default("").meta({ secret: true }),
    // Setup-time connected-computer pairing and its name, same rule as syncPairToken; empty ⇒ none connected.
    hostPairToken: z.string().default("").meta({ secret: true }),
    hostPlatform: z.string().default(""),
    hostLabel: z.string().default(""),
    // CORS allowlist, comma-separated; empty falls back to default via transform, since old sandboxes bake it empty.
    webOrigin: z
        .string()
        .default("")
        .transform((value) => (value.trim() === "" ? PLATFORM_WEB_ORIGIN : value)),
    // Minutes idle before the daemon exits so a hosted machine stops billing; 0 (default) disables, hosted-only.
    idleStopMinutes: z.coerce.number().int().nonnegative().default(0),
    // Platform URL for the daemon's announce/liveness phone-home; empty disables announcing (tests, loopback).
    platform: z
        .object({
            url: z.string().default(""),
            // Platform's Ed25519 public key (SPKI PEM) that verifies its owner ticket; hosted-only, empty elsewhere.
            publicKey: z.string().default(""),
        })
        .prefault({}),
    // ACME directory for the loopback cert; empty ⇒ Let's Encrypt production, else staging for testing.
    acmeDirectoryUrl: z.string().default(""),
    // Intent-declared internal MCP tools (base64 JSON), set by the workspace provider; constant for the sandbox.
    intenticAgentTools: z.string().default(""),
    // Daemon-wide default Claude model for turns with none pinned (headless wakes); empty ⇒ account default.
    intenticAgentModel: z.string().default(""),
    // Image-baked iq embedding/reranker models dir; empty (bare dev run) ⇒ semantic search just degrades.
    iqModelDir: z.string().default(""),
    // Explicit ripgrep path for the resident engine; empty ⇒ `rg` from PATH (always present in the image).
    iqRgPath: z.string().default(""),
    // Image-baked iq Claude Code plugin dir, gated by the iqSearch setting (opt-in); empty ⇒ not loaded.
    iqPluginDir: z.string().default(""),
    // Image-baked webq Claude Code plugin dir, loaded ungated (CLI is always on PATH); empty ⇒ not loaded.
    webqPluginDir: z.string().default(""),
    // Image-baked extensions dir; each subdir is an extension checkout, enumerated with git-installed ones.
    extensionsDir: z.string().default(""),
    // Bundled translator (CLIProxyAPI): `url` sets ANTHROPIC_BASE_URL, `token` its bearer; both Dockerfile-set.
    translator: z
        .object({
            url: z.string().default(""),
            token: z.string().default("").meta({ secret: true }),
        })
        .prefault({}),
    // Container-env Claude fallback creds, used only to decide if a turn can run with no stored account.
    claudeCodeOauthToken: z.string().default("").meta({ secret: true }),
    anthropicApiKey: z.string().default("").meta({ secret: true }),
    // Container-env OpenAI fallback cred; gates a native Codex turn when no ChatGPT account is connected.
    openaiApiKey: z.string().default("").meta({ secret: true }),
    // User's Cloudflare API token, own-Cloudflare path only; presence tells the infra panel who mints tunnels.
    cloudflareApiToken: z.string().default("").meta({ secret: true }),
    sandbox: z
        .object({
            // "container" is the shipped two-volume image with a tunnel; "local" is a plain loopback-only process.
            profile: z.enum(["container", "local"]).default("container"),
            port: z.coerce.number().default(DAEMON_PORT),
            // Binds 0.0.0.0 by default; inside the container only the loopback listener's port is ever published.
            host: z.string().default("0.0.0.0"),
            // This sandbox's public URL, set by connect.{sh,ps1} once the tunnel exists.
            publicUrl: z.string().default(""),
            // True on a Fly microVM (the whole machine); reached via edge replay, so no tunnel and no loopback cert.
            vm: z
                .string()
                .default("")
                .transform((value) => value === "true" || value === "1"),
            // Platform-signed proof of this sandbox's identity for the tunnel upgrade; empty ⇒ no tunnel, loopback
            // only.
            grant: z.string().default("").meta({ secret: true }),
            // Bypasses the auth floor for gated e2e tests only; nothing that ships ever sets this.
            allowUnauthenticated: z
                .string()
                .default("")
                .transform((value) => value === "true" || value === "1"),
            // Identity for the platform's Connections card; both must be set to surface anything.
            name: z.string().default(""),
            image: z.string().default(""),
            // Upstream image the overlay extends, distinct from `image` (its own tag); empty derives from `image`.
            baseImage: z.string().default(""),
            // sha256 of the approved overlay Dockerfile this container was built from; empty ⇒ stock image.
            environmentHash: z.string().default(""),
            // Release channel and rollback tag, runner-set; empty channel ⇒ `stable`, empty tag ⇒ no rollback offered.
            channel: z.string().default(""),
            previousImage: z.string().default(""),
            // sandbox.toml (base64) seeding an empty workspace on first boot; lands as a proposal, never approved.
            definitionSeed: z.string().default(""),
            // An unowned pool machine that warms caches then exits; no owner or token, so identity subsystems stay off.
            prewarm: z
                .string()
                .default("")
                .transform((value) => value === "true" || value === "1"),
        })
        .prefault({}),
    // Outbound edge address this sandbox dials with `sandbox.grant`; empty ⇒ no tunnel, loopback only.
    ingress: z
        .object({
            url: z.string().default(""),
        })
        .prefault({}),
    preview: z
        .object({
            // Port the preview proxy listens on; each panel's own port is auto-assigned, the proxy routes by Host.
            port: z.coerce.number().default(PREVIEW_PORT),
        })
        .prefault({}),
    local: z
        .object({
            // Port the loopback listener binds; kept separate from sandbox.port since only this one carries TLS.
            port: z.coerce.number().default(LOCAL_PORT),
        })
        .prefault({}),
    google: z
        .object({
            // Google web client id (public), the audience for verifying ID tokens; empty ⇒ loopback mode, no auth.
            clientId: z.string().default(""),
        })
        .prefault({}),
});

// Local dev convenience: loads the monorepo-root .env when the daemon runs bare, so creds don't need manual export.
// Inside the container there is no checkout, so the walk throws; caught here since that's just another no-op path.
const rootEnvPath = (): string => {
    try {
        return join(repoRoot(import.meta.url), ".env");
    } catch {
        return "";
    }
};
const rootEnv = rootEnvPath();

// Sources, later wins: local .env, then real env (connect.{sh,ps1}/provider), then CLI.
const definition = {
    schema: configSchema,
    sources: [envFile(rootEnv), env(), cliArgs()],
} satisfies ConfigDefinition<typeof configSchema>;

export type Config = z.infer<typeof configSchema>;

export const loadConfig = (): Config => loadPuristicConfig(definition);
