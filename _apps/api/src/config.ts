import { type ConfigDefinition, cliArgs, env, envFile, loadConfig as loadPuristicConfig } from "@puristic/env/index.js";
import { resolve } from "node:path";
import { z } from "zod";

// Root .env, resolved relative to this file so loading is cwd-independent (dev runs from _apps/api).
const rootEnv = resolve(import.meta.dirname, "../../../.env");

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
    webOrigin: z.string().url(),
    google: z
        .object({
            clientId: z.string().default(``),
            clientSecret: z.string().default(``).meta({ secret: true }),
        })
        .prefault({}),
    // Billing for the platform's OWN SaaS. Subscription state belongs to the central account (like Session),
    // the one sanctioned platform-owned addition (CLAUDE.md). The Stripe checkout/customer-portal/webhook logic
    // is the Better Auth Stripe plugin (auth.ts). Distinct from the sandbox-side i.have.stripe capability, whose
    // STRIPE_API_KEY lives in the user's sandbox .env — these credentials are the platform's, like Google's.
    stripe: z
        .object({
            secretKey: z.string().default(``).meta({ secret: true }), // STRIPE_SECRET_KEY (sk_…)
            webhookSecret: z.string().default(``).meta({ secret: true }), // STRIPE_WEBHOOK_SECRET (whsec_…)
            proPriceId: z.string().default(``), // STRIPE_PRO_PRICE_ID (price_…)
        })
        .prefault({}),
    // Transactional email (Resend) for sandbox invites — the only mail the platform sends. `apiKey` is the Resend
    // API key (re_…); `from` is the verified sender (e.g. "intentic <invites@your-domain>"). Unset → invites are
    // still created but the link is logged server-side instead of emailed (dev only; main.ts warns).
    email: z
        .object({
            apiKey: z.string().default(``).meta({ secret: true }), // EMAIL_API_KEY (re_…)
            from: z.string().default(``), // EMAIL_FROM
        })
        .prefault({}),
    // Emails that always resolve to the `pro` plan without a Stripe subscription (entitlements.ts getPlan) —
    // comp'd/test accounts. PERMANENT_PREMIUM_EMAILS, comma-separated; matched case-insensitively.
    // ponytail: env .transform → string[]; if @puristic/env chokes on it, keep a plain string and split in getPlan.
    permanentPremiumEmails: z
        .string()
        .default(``)
        .transform((value) =>
            value
                .split(`,`)
                .map((email) => email.trim().toLowerCase())
                .filter(Boolean),
        ),
    // Intentic-OWNED Cloudflare token + zone, used ONLY to provision sandbox tunnels for users who bring no
    // Cloudflare of their own: the platform creates the tunnel + DNS server-side and hands the sandbox a narrow
    // per-tunnel connector token (never this API token). This is intentic's own credential — a documented, scoped
    // exception to the secret-free model above, like Google's and Stripe's here. Unset (either field) → the
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
            // Keep this many sandbox tunnels pre-provisioned (sandboxPool.ts): sandbox.create claims one so /setup
            // pays no Cloudflare round-trips inline. 0 disables the pool (create provisions lazily, as before).
            poolSize: z.coerce.number().int().nonnegative().default(1), // INTENTIC_CLOUDFLARE_POOL_SIZE
        })
        .prefault({}),
    api: z
        .object({
            url: z.string().url().default(`http://localhost:6480`),
            port: z.coerce.number().int().positive().default(6480),
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
    `stripe.secretKey`,
    `stripe.webhookSecret`,
    `email.apiKey`,
    `intenticCloudflare.apiToken`,
];

export const loadConfig = (): Config => loadPuristicConfig(definition);
