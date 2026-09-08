import { repoRoot } from "@intentic/constants/node";
import { type ConfigDefinition, cliArgs, env, envFile, loadConfig as loadPuristicConfig } from "@puristic/env/index.js";
import { join } from "node:path";
import { z } from "zod";

// Root .env, found by walking up to the workspace marker; independent of cwd and this file's depth.
const rootEnv = join(repoRoot(import.meta.url), ".env");

// @puristic/env maps each dotted path to SCREAMING_SNAKE; .meta({secret:true}) marks a secret field.
export const configSchema = z.object({
    database: z.object({
        url: z.string().min(1).meta({ secret: true }),
        // Per-process pg pool cap: replicas x poolMax must stay under Postgres max_connections with headroom.
        poolMax: z.coerce.number().int().positive().default(10),
    }),
    betterAuth: z.object({
        secret: z.string().min(1).meta({ secret: true }),
    }),
    // Key for encrypting persisted secrets at rest (crypto.ts); unset stores those columns as plaintext.
    secrets: z
        .object({
            key: z.string().default(``).meta({ secret: true }),
        })
        .prefault({}),
    // Browser-facing API origin the SPA calls directly; also Better Auth's base and the CORS allow-origin.
    webOrigin: z.url(),
    google: z
        .object({
            clientId: z.string().default(``),
            clientSecret: z.string().default(``).meta({ secret: true }),
        })
        .prefault({}),
    // Comma-separated admin emails, deployment config rather than a row; empty disables /admin entirely.
    admin: z
        .object({
            emails: z.string().default(``),
            // The admin mutation gate, off until the panel's bytes are a pinned install; each mutation confirms its
            // target.
            mutations: z.stringbool().default(false),
        })
        .prefault({}),
    // Resend email for invites and the setup link; unset logs the link server-side instead of sending it.
    email: z
        .object({
            apiKey: z.string().default(``).meta({ secret: true }),
            from: z.string().default(``),
        })
        .prefault({}),
    // Intentic-owned Cloudflare token/zone, DNS only, for the loopback cert wildcard; unset disables that path.
    intenticCloudflare: z
        .object({
            apiToken: z.string().default(``).meta({ secret: true }),
            zone: z.string().default(`intentic.dev`),
            // Off by default: reaping is shared per zone, so sweeping with the wrong database can delete live records.
            reap: z.stringbool().default(false),
            // Reports candidates without deleting even when reaping is on, so a first sweep can be reviewed.
            reapDryRun: z.stringbool().default(false),
        })
        .prefault({}),
    // The platform's own edge; it signs a reachability grant offline. Empty signingKey disables provisioning.
    ingress: z
        .object({
            // The wildcard zone every sandbox hostname is a label under.
            zone: z.string().default(`sbx.intentic.dev`),
            // The public base boxes dial to open their tunnel; one address, under the same wildcard and certificate.
            url: z.url().default(`https://ingress.sbx.intentic.dev`),
            // The platform's Ed25519 private signing key; the ingress holds only the matching public key.
            signingKey: z.string().default(``).meta({ secret: true }),
        })
        .prefault({}),
    // Intentic's own Fly credential; a platform breach can reach hosted machines, unlike every other lane.
    hosted: z
        .object({
            flyApiToken: z.string().default(``).meta({ secret: true }),
            flyOrg: z.string().default(``),
            // Fly region for a caller outside the EEA.
            region: z.string().default(`iad`),
            // Where an EEA caller's machine lands instead, per the privacy policy's EEA-data commitment.
            regionEu: z.string().default(`arn`),
            // Fly app names are globally unique: <appPrefix>-<sandboxId> keeps ours claimable and reaper-recognizable.
            appPrefix: z.string().default(`intentic-sbx`),
            // The image every hosted machine boots, the same public sandbox image every lane runs.
            image: z.string().default(`ghcr.io/intentic/sandbox:stable`),
            // Starter machine shape; CPUs must stay high or git-heavy work beside cloudflared/dockerd starves the loop.
            cpus: z.coerce.number().int().positive().default(4),
            memoryMb: z.coerce.number().int().positive().default(4096),
            volumeGb: z.coerce.number().int().positive().default(10),
            // Hosted sandboxes per user; the free promise is one instant box each.
            perUser: z.coerce.number().int().positive().default(1),
            // The fleet's machine ceiling on the provider; 0 defers to the provider's own limit instead of one here.
            maxMachines: z.coerce.number().int().nonnegative().default(0),
            // Idle minutes before the daemon exits and the machine stops; 0 disables (always-on).
            idleStopMinutes: z.coerce.number().int().nonnegative().default(20),
            // Free-lane awake hours per month; members are unmetered. Charged only while awake, enforced at wake.
            monthlyHours: z.coerce.number().int().nonnegative().default(40),
            // Backstop past monthlyHours: stops a metered owner's machine once over budget by this many minutes.
            overBudgetGraceMinutes: z.coerce.number().int().nonnegative().default(60),
            // Days since last wake before a non-member's disk is collected; idleWarnDays emails once first. 0 disables.
            idleDays: z.coerce.number().int().nonnegative().default(21),
            idleWarnDays: z.coerce.number().int().nonnegative().default(14),
            // Warm pool: machines pre-built per region so claiming one costs a start, not an image pull; 0 drains it.
            poolSize: z.coerce.number().int().nonnegative().default(2),
            // How often the lane is checked against Fly; read-only, logs when rows and provider disagree. 0 turns it
            // off.
            healthMinutes: z.coerce.number().int().nonnegative().default(15),
            // Provisioning canary: end-to-end sandbox test on this interval; off by default, since a run spends a
            // machine.
            canaryMinutes: z.coerce.number().int().nonnegative().default(0),
            canaryEmail: z.string().default(``),
            // This deployment's identity to the provider; only its own machines are destroyed. Sharing it shares a
            // fleet.
            instanceId: z.string().default(``),
            // The overlay builder (ic sandbox rebuild): per-owner and platform-wide build caps, charged like awake
            // time.
            builderImage: z.string().default(`docker.io/moby/buildkit:v0.20.2`),
            builderCpuKind: z.enum([`shared`, `performance`]).default(`shared`),
            builderCpus: z.coerce.number().int().positive().default(4),
            builderMemoryMb: z.coerce.number().int().positive().default(4096),
            buildTimeoutMinutes: z.coerce.number().int().positive().default(30),
            buildsPerDay: z.coerce.number().int().nonnegative().default(5),
            buildConcurrency: z.coerce.number().int().positive().default(4),
            buildMinutesPerDay: z.coerce.number().int().nonnegative().default(600),
        })
        .prefault({}),
    // Intentic's own model keys serving free-trial chat, tried as a pool. Empty (default) disables the trial.
    trial: z
        .object({
            // Comma-separated Google AI Studio keys, tried in order.
            keys: z.string().default(``).meta({ secret: true }),
            // Google's OpenAI-compatible endpoint; any OpenAI-shaped upstream works.
            baseUrl: z.url().default(`https://generativelanguage.googleapis.com/v1beta/openai`),
            // Comma-separated model ids the trial may route to, in preference order; empty uses the curated ladder in
            // code.
            models: z.string().default(``),
            // Messages per signed-in account per UTC day; enough to judge the product, too few to work on.
            dailyMessages: z.coerce.number().int().nonnegative().default(12),
        })
        .prefault({}),
    // The hosted plan, sold via Stripe; no key/price means no plan and the hosted lane stays free-lane only.
    hostedPlan: z
        .object({
            stripeSecretKey: z.string().default(``).meta({ secret: true }),
            // Where the Stripe client sends calls; tests point it at a stand-in that speaks Stripe's own shapes.
            stripeApiUrl: z.url().default(`https://api.stripe.com/v1`),
            // Webhook signing secret; without it, subscription events are refused.
            stripeWebhookSecret: z.string().default(``).meta({ secret: true }),
            stripePriceId: z.string().default(``),
            // Display only; what Stripe actually charges is the Price above.
            priceUsd: z.coerce.number().nonnegative().default(20),
            // Comma-separated emails treated as on-plan without a subscription; checked live, never seeded as rows.
            compEmails: z.string().default(``),
        })
        .prefault({}),
    api: z
        .object({
            url: z.url().default(`http://localhost:6480`),
            port: z.coerce.number().int().positive().default(6480),
            // Loopback in dev; a container must set 0.0.0.0 for a reverse proxy to reach it, which still terminates
            // TLS.
            host: z.string().default(`127.0.0.1`),
            // Dev TLS cert/key so the API serves https, since Google's One Tap needs it; empty in prod behind a proxy.
            httpsKey: z.string().default(``),
            httpsCert: z.string().default(``),
        })
        .prefault({}),
    // The agent wallet's signer; empty custodyUrl/custodyKey disables /wallet. The platform holds no key material.
    wallet: z
        .object({
            custodyUrl: z.string().default(``),
            custodyKey: z.string().default(``).meta({ secret: true }),
        })
        .prefault({}),
    // Push relay's Apple credential: the only way a daemon can notify iOS, since Apple only accepts pushes from it.
    apns: z
        .object({
            // The .p8 file's contents; literal \n escapes are accepted.
            keyP8: z.string().default(``).meta({ secret: true }),
            // The key's id and the team it belongs to, from the Apple developer portal.
            keyId: z.string().default(``),
            teamId: z.string().default(``),
            // APNs routes pushes by this (`apns-topic`).
            bundleId: z.string().default(`dev.intentic.app`),
            // Apple's production gateway; point at the sandbox host for development builds instead.
            url: z.url().default(`https://api.push.apple.com`),
        })
        .prefault({}),
    // Pino logging: level sets verbosity, pretty toggles colorized dev output vs single-line JSON in prod.
    log: z
        .object({
            level: z.enum([`fatal`, `error`, `warn`, `info`, `debug`, `trace`, `silent`]).default(`info`),
            // z.stringbool parses true/false/1/0; z.coerce.boolean treats any non-empty string, even 'false', as true.
            pretty: z.stringbool().default(process.env[`NODE_ENV`] !== `production`),
        })
        .prefault({}),
});

// Merge order, later wins: .env file, then process env, then CLI args.
const definition = {
    schema: configSchema,
    sources: [envFile(rootEnv), env(), cliArgs()],
} satisfies ConfigDefinition<typeof configSchema>;

export type Config = z.infer<typeof configSchema>;

// Dotted paths of secret fields; pass to mask() before logging the config.
export const CONFIG_SECRETS = [
    `database.url`,
    `betterAuth.secret`,
    `secrets.key`,
    `google.clientSecret`,
    `email.apiKey`,
    `intenticCloudflare.apiToken`,
    `ingress.signingKey`,
    `hosted.flyApiToken`,
    `trial.keys`,
    `hostedPlan.stripeSecretKey`,
    `hostedPlan.stripeWebhookSecret`,
    `apns.keyP8`,
];

export const loadConfig = (): Config => loadPuristicConfig(definition);
