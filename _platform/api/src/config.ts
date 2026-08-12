import { repoRoot } from "@intentic/constants/node";
import { type ConfigDefinition, cliArgs, env, envFile, loadConfig as loadPuristicConfig } from "@puristic/env/index.js";
import { join } from "node:path";
import { z } from "zod";

// Root .env, found by walking up to the workspace marker so loading is cwd-independent (dev runs from
// _platform/api) AND depth-independent — this file's distance from the root is no longer part of the answer.
const rootEnv = join(repoRoot(import.meta.url), ".env");

// Nested schema. @puristic/env derives env var names by SCREAMING_SNAKE-casing each path segment and joining
// with "_": database.url → DATABASE_URL, betterAuth.secret → BETTER_AUTH_SECRET, google.clientId →
// GOOGLE_CLIENT_ID, etc. Secrets are marked with .meta({ secret: true }); plaintext for now, encryptable later.
//
// Strict, sandbox-centric model (CLAUDE.md): the platform holds no backend/infra secrets. The only credentials
// here are for the central account (Google sign-in) and the platform's own session signing — everything else
// (Claude/git tokens, SSH keys, Cloudflare) lives in the user's sandbox.
const configSchema = z.object({
    database: z.object({
        url: z.string().min(1).meta({ secret: true }),
        // Per-process pg pool cap (DATABASE_POOL_MAX). Size deliberately: replicas × poolMax must stay
        // under Postgres max_connections (default 100) with headroom for migrations and psql.
        poolMax: z.coerce.number().int().positive().default(10),
    }),
    betterAuth: z.object({
        secret: z.string().min(1).meta({ secret: true }),
    }),
    // Key material for encrypting the platform's few persisted secrets at rest (crypto.ts): Google OAuth
    // tokens, sandbox connect tokens, setup payloads. Any random string; the effective AES key is its
    // SHA-256. Unset → those columns are stored plaintext (dev only; main.ts warns).
    secrets: z
        .object({
            key: z.string().default(``).meta({ secret: true }), // SECRETS_KEY
        })
        .prefault({}),
    // Browser-facing origin of the API — where the SPA calls /rpc + /api/auth directly (no dev-server proxy).
    // In dev this is http://localhost:6480; the SPA's own origin is webOrigin. Also the base Better Auth uses
    // + the CORS allow-origin.
    webOrigin: z.url(),
    google: z
        .object({
            clientId: z.string().default(``),
            clientSecret: z.string().default(``).meta({ secret: true }),
        })
        .prefault({}),
    // Transactional email (Resend) — sandbox invites, and the setup link a phone sends itself to finish on a
    // real machine (mail.ts). `apiKey` is the Resend API key (re_…); `from` is the verified sender (e.g.
    // "intentic <invites@your-domain>"). Unset → both are still accepted but the link is logged server-side
    // instead of emailed (dev only; main.ts warns).
    email: z
        .object({
            apiKey: z.string().default(``).meta({ secret: true }), // EMAIL_API_KEY (re_…)
            from: z.string().default(``), // EMAIL_FROM
        })
        .prefault({}),
    // Intentic-OWNED Cloudflare token + zone, used ONLY to provision sandbox tunnels for users who bring no
    // Cloudflare of their own: the platform creates the tunnel + DNS server-side and hands the sandbox a narrow
    // per-tunnel connector token (never this API token). This is intentic's own credential — a documented, scoped
    // exception to the secret-free model above, like Google's here. Unset (either field) → the
    // intentic-provided path is disabled and setup offers only the bring-your-own-Cloudflare flow.
    intenticCloudflare: z
        .object({
            apiToken: z.string().default(``).meta({ secret: true }), // INTENTIC_CLOUDFLARE_API_TOKEN
            zone: z.string().default(`intentic.dev`), // INTENTIC_CLOUDFLARE_ZONE
            // Daily reaper (retention.ts): delete intentic-owned sandbox-*/host-ssh-* tunnels idle this many days.
            // cloudflared runs --restart unless-stopped, so a live tunnel reconnects within minutes of a reboot and
            // never stays idle for days; 7 reclaims real orphans without touching a briefly-offline sandbox.
            reapAfterDays: z.coerce.number().default(7), // INTENTIC_CLOUDFLARE_REAP_AFTER_DAYS
            // Log reap candidates without deleting — run the first production sweep with this on, confirm the list,
            // then turn it off.
            reapDryRun: z.stringbool().default(false), // INTENTIC_CLOUDFLARE_REAP_DRY_RUN
            // Keep this many sandbox tunnels pre-provisioned (sandbox-pool.ts): sandbox.create claims one so /setup
            // pays no Cloudflare round-trips inline. 0 disables the pool (create provisions lazily, as before).
            poolSize: z.coerce.number().int().nonnegative().default(1), // INTENTIC_CLOUDFLARE_POOL_SIZE
        })
        .prefault({}),
    /* THE FREE-TRIAL POOL — intentic's OWN model keys, and the SECOND documented exception to the secret-free
     * model above (intenticCloudflare is the first). It is a larger exception than that one and says so here
     * rather than in a commit message: a tunnel token is spent provisioning DNS, while these keys serve model
     * turns, so for as long as a user is on the trial their prompts pass through the platform. That is the whole
     * cost of letting someone chat before they own any AI subscription, it is bounded to the trial, and every
     * surface that offers the trial says it in those words.
     *
     * `keys` is the switch. Empty (the default, and the only sane one for a self-hosted platform) disables the
     * trial outright: the routes 404, the daemon provisions nothing, and the chat's front door is the free
     * Google sign-in alone. Several keys are a POOL — Google's free tier is sized for one developer, so a launch
     * day exhausts one project's quota and the next key takes the turn rather than the user meeting a 429. */
    trial: z
        .object({
            // Comma-separated Google AI Studio API keys, tried in order. TRIAL_KEYS.
            keys: z.string().default(``).meta({ secret: true }),
            // Google's OpenAI-compatible surface. Any OpenAI-shaped upstream works; this is the one whose free
            // tier is meant for serving end users. TRIAL_BASE_URL.
            baseUrl: z.url().default(`https://generativelanguage.googleapis.com/v1beta/openai`),
            // Comma-separated model ids the trial may serve. Empty = whatever the upstream publishes, which is
            // the honest default (a curated list here goes stale the day Google ships a model). Set it to keep
            // the trial off the expensive end of a free tier. TRIAL_MODELS.
            models: z.string().default(``),
            // Messages per signed-in account per UTC day. Enough to judge the product, far too few to work on.
            // TRIAL_DAILY_MESSAGES.
            dailyMessages: z.coerce.number().int().nonnegative().default(12),
        })
        .prefault({}),
    /* THE CREATOR POOL — the optional paid membership whose revenue premium-extension creators share.
     *
     * `stripeSecretKey` + `stripePriceId` are the switch, exactly like trial.keys: both empty (the default,
     * and the right one for a self-hosted platform) and the pool does not exist — /pool routes 404, the web
     * app offers no membership, premium extensions cannot be enabled anywhere that points at this platform.
     * Stripe stays the money's source of truth; the platform mirrors just enough (pool/pool-membership.ts)
     * to answer "is this user premium" without a Stripe round-trip on hot paths. */
    pool: z
        .object({
            // The Stripe secret key (sk_… / rk_…). POOL_STRIPE_SECRET_KEY.
            stripeSecretKey: z.string().default(``).meta({ secret: true }),
            // The signing secret of the /pool/webhook endpoint (whsec_…) — without it subscription events
            // are refused, so a pool that takes money must set it. POOL_STRIPE_WEBHOOK_SECRET.
            stripeWebhookSecret: z.string().default(``).meta({ secret: true }),
            // The recurring Price the checkout sells (price_…). POOL_STRIPE_PRICE_ID.
            stripePriceId: z.string().default(``),
            // The membership's monthly price in USD as the transparency page states it — display + pool math
            // only; what Stripe actually charges is the Price above. POOL_PRICE_USD.
            priceUsd: z.coerce.number().nonnegative().default(20),
            // The fraction of a spent credit's VALUE its recipient earns — a donated credit pays the
            // extension's creator this share, a consumed credit pays the service's provider this share
            // (credit value is derived and published: priceUsd / (30 × dailyCredits)). The published number
            // the whole model stands on — change it loudly or not at all. POOL_CREATOR_SHARE.
            creatorShare: z.coerce.number().min(0).max(1).default(0.9),
            // A member's daily credit allowance, reset at UTC midnight like the trial. The membership's cost
            // ceiling: 1000/day bounds what a member can spend — on service runs and on install donations —
            // which is what lets a flat price fund a per-credit economy at all. POOL_DAILY_CREDITS.
            dailyCredits: z.coerce.number().int().nonnegative().default(1000),
            // What a service's provider earns per consumed credit, as a share of its value — kept a separate
            // knob from creatorShare because a service carries real upstream costs a prompt-pack does not.
            // POOL_SERVICE_SHARE.
            serviceShare: z.coerce.number().min(0).max(1).default(0.9),
            // What installing (or, at most monthly, updating) a premium non-service extension donates to its
            // creator, in credits. Flat across the catalog on purpose: a price the listing could set would be
            // the first number anyone games. POOL_DONATION_CREDITS.
            donationCredits: z.coerce.number().int().nonnegative().default(200),
            // Seed the self-contained demo service (a canned research answerer the platform itself hosts) so
            // the catalog is demonstrable without a provider. POOL_DEMO_SERVICE.
            demoService: z.stringbool().default(false),
            // The registry whose listings decide which repositories back a publisher name — the authority a
            // publisher claim is checked against (creator/creator-claim.ts). The official registry by default;
            // a platform running its own points this at that repository's marketplace file, and claims are then
            // proved against the listings it actually serves. POOL_REGISTRY_URL.
            registryUrl: z.url().default(`https://raw.githubusercontent.com/intentic/registry/HEAD/.claude-plugin/marketplace.json`),
        })
        .prefault({}),
    // Where the connect bootstrap scripts are served from — the cloud lane bakes `${scriptOrigin}/connect`
    // into a new VM's first-boot script (sandbox/cloud/user-data.ts), the same URL the setup wizard's
    // copy-paste command uses. A self-hosted platform points this at its own site. SCRIPT_ORIGIN.
    scriptOrigin: z.url().default(`https://intentic.dev`),
    api: z
        .object({
            url: z.url().default(`http://localhost:6480`),
            port: z.coerce.number().int().positive().default(6480),
            // Bind address. Loopback in dev — localhost is the origin the dev cert, CORS, and Better Auth all
            // trust — so a container must set API_HOST=0.0.0.0 for the reverse proxy / tunnel (a separate
            // container or host) to reach it. TLS is still terminated by that proxy in prod.
            host: z.string().default(`127.0.0.1`),
            // Dev TLS: paths to a cert/key (the @intentic-app/localhost-https package) so the API serves https,
            // matching the https SPA — Google's FedCM One Tap needs https and won't run on http://localhost.
            // Empty in prod, where TLS is terminated by the proxy in front of the API.
            httpsKey: z.string().default(``),
            httpsCert: z.string().default(``),
        })
        .prefault({}),
    // Pino logging. LOG_LEVEL sets verbosity; LOG_PRETTY toggles human-readable dev output (colorized,
    // in-process) vs. single-line JSON for prod. Defaults to pretty everywhere but production.
    log: z
        .object({
            level: z.enum([`fatal`, `error`, `warn`, `info`, `debug`, `trace`, `silent`]).default(`info`),
            // z.stringbool parses "true"/"false"/"1"/"0" from the env string (z.coerce.boolean treats any
            // non-empty string — including "false" — as true).
            pretty: z.stringbool().default(process.env[`NODE_ENV`] !== `production`),
        })
        .prefault({}),
});

// Merge order (later wins): .env file < process env < CLI args. So `bun start --api.port=7000` overrides.
const definition = {
    schema: configSchema,
    sources: [envFile(rootEnv), env(), cliArgs()],
} satisfies ConfigDefinition<typeof configSchema>;

export type Config = z.infer<typeof configSchema>;

// Dotted paths of secret fields — pass to mask() before logging the config.
export const CONFIG_SECRETS = [
    `database.url`,
    `betterAuth.secret`,
    `secrets.key`,
    `google.clientSecret`,
    `email.apiKey`,
    `intenticCloudflare.apiToken`,
    `trial.keys`,
];

export const loadConfig = (): Config => loadPuristicConfig(definition);
