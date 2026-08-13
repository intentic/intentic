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
    // Intentic-OWNED Cloudflare token + zone — DNS ONLY since the tunnel fabric moved in-house (zrok above).
    // What is left of it: the loopback certificate's `local-<id>` records (the daemon relays for them, having
    // no token for this zone) and the daily sweep that clears their residue. No tunnels, no per-sandbox
    // records, nothing against the per-zone quota. Unset ⇒ the loopback-certificate path is simply off.
    intenticCloudflare: z
        .object({
            apiToken: z.string().default(``).meta({ secret: true }), // INTENTIC_CLOUDFLARE_API_TOKEN
            zone: z.string().default(`intentic.dev`), // INTENTIC_CLOUDFLARE_ZONE
            // Log the record sweep's candidates without deleting — run a new deployment's first sweep with
            // this on, confirm the list, then turn it off. INTENTIC_CLOUDFLARE_REAP_DRY_RUN.
            reapDryRun: z.stringbool().default(false),
        })
        .prefault({}),
    /* THE TUNNEL FABRIC — the self-hosted zrok hub every sandbox reaches its owner through (sandbox/zrok.ts;
     * the `zrok` Komodo stack runs it). The platform holds the hub's ADMIN token and mints one account per
     * sandbox; the box's own `zrok2 enable` births the identity, so this credential creates and revokes
     * reachability but can never impersonate a sandbox. Replaces the Cloudflare tunnel machinery outright —
     * intenticCloudflare below is DNS-only residue now (loopback-cert records). `adminToken` is the switch:
     * empty (the default for a platform that has not stood the hub up) leaves every provisioning route 404
     * and the wizard offering only the attach lane. */
    zrok: z
        .object({
            // The controller API as the PLATFORM reaches it (LAN address is fine). ZROK_API_ENDPOINT.
            apiEndpoint: z.url().default(`https://zrok2.sbx.intentic.dev`),
            // The same controller as SANDBOXES reach it — differs from the above when the platform sits on
            // the hub's LAN but the boxes come in from outside. Empty ⇒ same as apiEndpoint. ZROK_AGENT_ENDPOINT.
            agentEndpoint: z.string().default(``),
            // The hub's admin token (ZROK2_ADMIN_TOKEN of the zrok stack). ZROK_ADMIN_TOKEN.
            adminToken: z.string().default(``).meta({ secret: true }),
            // The DNS zone the wildcard record serves — the suffix of every sandbox hostname. ZROK_ZONE.
            zone: z.string().default(`sbx.intentic.dev`),
        })
        .prefault({}),
    /* THE HOSTED LANE — intentic's OWN Fly.io credential, the THIRD documented exception to the secret-free
     * model (intenticCloudflare and trial.keys are the others), and the one that changes the trust story the
     * most: for a HOSTED sandbox the platform creates the machine, keeps the way back in (start/stop/destroy),
     * and the provider could reach inside it — so a platform breach reaches hosted machines, where every other
     * lane stays out of reach by construction. ARCHITECTURE.md states this trade in full; every other lane is
     * unchanged, and a platform with no token here (the default, and the right one for self-hosters) has no
     * hosted lane at all: the routes 404 and the editor never offers it.
     *
     * `flyApiToken` is the switch (org rides along — a token without an org cannot place a machine). The rest
     * sizes the starter box: deliberately small and cheap, because the lane's job is "signed in → working
     * sandbox in seconds", and the wizard's ladder (Oracle free tier, your cloud, your machine) is the answer
     * for power — not a bigger bill here. */
    hosted: z
        .object({
            // Org-scoped Fly API token (fly tokens create -o <org>). HOSTED_FLY_API_TOKEN.
            flyApiToken: z.string().default(``).meta({ secret: true }),
            // The Fly organization slug hosted apps are created in. HOSTED_FLY_ORG.
            flyOrg: z.string().default(``),
            // Fly region code a machine lands in when the caller is outside the EEA. HOSTED_REGION.
            region: z.string().default(`iad`),
            /* Where an EEA caller's machine lands instead. The privacy policy PROMISES this — a European
             * user's workspace, and every file and secret they put in it, stays inside the EEA rather than
             * crossing to Ashburn — so the pick is a data-protection commitment, not a latency tweak, and
             * emptying this knob breaks a published statement rather than merely a default.
             * HOSTED_REGION_EU. */
            regionEu: z.string().default(`waw`),
            // Fly app names are GLOBALLY unique: <appPrefix>-<sandbox id> keeps ours claimable and lets the
            // reaper recognize our apps by prefix. HOSTED_APP_PREFIX.
            appPrefix: z.string().default(`intentic-sbx`),
            // The image a hosted machine boots — the same public sandbox image every other lane runs.
            // HOSTED_IMAGE.
            image: z.string().default(`ghcr.io/intentic/sandbox:stable`),
            /* The starter machine: shared CPUs + memory in MB (Fly guest shape), disk in GB. HOSTED_CPUS,
             * HOSTED_MEMORY_MB, HOSTED_VOLUME_GB.
             *
             * Sized against `monthlyHours` below, not against what a workstation wants. Once awake time is
             * capped the guest shape stops being the bill's driver — a capped month on this shape costs less
             * than the DISK did on the 4×/8 GB/20 GB box this replaces — so the money saved by halving memory
             * again buys nothing and costs the thing people actually notice: 4 GB survives an install and a
             * build on a real repository, 2 GB meets the OOM killer and reads as "intentic is broken". */
            cpus: z.coerce.number().int().positive().default(2),
            memoryMb: z.coerce.number().int().positive().default(4096),
            volumeGb: z.coerce.number().int().positive().default(10),
            // Hosted sandboxes per user. The free promise is ONE instant box each; more is a product decision,
            // not a config bump someone makes casually. HOSTED_PER_USER.
            perUser: z.coerce.number().int().positive().default(1),
            // Minutes of nobody-watching-nothing-running before the daemon exits and the machine stops —
            // rides into the box as IDLE_STOP_MINUTES. 0 disables (always-on). HOSTED_IDLE_STOP_MINUTES.
            idleStopMinutes: z.coerce.number().int().nonnegative().default(20),
            /* THE FREE LANE'S CEILING: awake hours per calendar month for an owner WITHOUT a membership.
             * Members are unmetered, so this is the one number that decides what the free machine costs and
             * the one place the hosted lane asks anybody to upgrade.
             *
             * Charged only while the machine is actually awake — it sleeps after `idleStopMinutes`, so
             * thinking time and a closed laptop cost nothing — and enforced at WAKE, never mid-session:
             * running out means the next visit offers the upgrade, not that the box dies under someone's
             * hands. 0 disables the ceiling (self-hosters metering nothing). HOSTED_MONTHLY_HOURS. */
            monthlyHours: z.coerce.number().int().nonnegative().default(40),
            /* THE FREE LANE'S EXPIRY, in days since the machine was last woken. A hosted disk bills every day
             * it exists, so a machine nobody has opened since spring is the free tier's largest cost and its
             * least useful one. Non-members only; a member's machine is never collected.
             *
             * `idleWarnDays` sends one email first — the machine is about to go, opening it is the whole
             * remedy — because this deletes a disk somebody may still want. Either at 0 disables the sweep.
             * HOSTED_IDLE_DAYS, HOSTED_IDLE_WARN_DAYS. */
            idleDays: z.coerce.number().int().nonnegative().default(21),
            idleWarnDays: z.coerce.number().int().nonnegative().default(14),
            /* THE WARM POOL: machines built (image pulled, then stopped) before anyone asks, PER REGION, so
             * claiming the free sandbox costs the seconds of a machine start instead of the minutes of an
             * image pull. A pool machine holds no identity and no running compute — its standing cost is its
             * volume — and the reconcile job keeps the pool at this size, rebuilding it when the image moves.
             * 0 (the default) disables the pool and drains anything left in it. HOSTED_POOL_SIZE. */
            poolSize: z.coerce.number().int().nonnegative().default(0),
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
            /* WHAT THE MEMBERSHIP BUYS BEFORE IT BUYS ANYTHING FOR A CREATOR: the per-member monthly cost of
             * running the platform — a member's hosted machine and disk above all — taken off the top, so the
             * pool is what is left rather than the whole ticket.
             *
             * Without this the shares are levied on gross, and a member who spends their whole allowance
             * leaves the platform ~$2 of $20 while costing it more than that to host: the more someone uses
             * the product, the worse it does, which is not a pricing bug that can be grown out of. Taking it
             * off the top instead means the published share stays LITERALLY true of the pool it names — the
             * alternative, quietly paying creators 90% of something called $20 that isn't, is the kind of
             * asterisk this whole model exists not to have. The transparency report states it as its own
             * line for the same reason. 0 restores the old gross-share behaviour. POOL_INFRA_USD. */
            infraUsd: z.coerce.number().nonnegative().default(5),
            // The fraction of a spent credit's VALUE its recipient earns — a donated credit pays the
            // extension's creator this share, a consumed credit pays the service's provider this share
            // (credit value is derived and published: (priceUsd − infraUsd) / (30 × dailyCredits)). The
            // published number the whole model stands on — change it loudly or not at all. POOL_CREATOR_SHARE.
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
            // The day of the month a closed month's statements become payable. A month closes as soon as it is
            // over and pays mid-month, so the gap is a stated hold window for refunds and card disputes rather
            // than an unexplained delay — and a creator reads a date instead of "soon". POOL_PAYOUT_DAY.
            payoutDayOfMonth: z.coerce.number().int().min(1).max(28).default(15),
            // How long earnings owed to an unclaimed publisher name stay claimable before returning to the pool
            // and being split among creators who are still shipping. The published promise is twelve months;
            // it lives here so the close and the page it is stated on cannot disagree. Deliberately shorter
            // than the 396-day ledger retention, so a window never outlives the rows behind it.
            // POOL_CLAIM_WINDOW_MONTHS.
            claimWindowMonths: z.coerce.number().int().positive().default(12),
            // The smallest payment worth making. Below it a creator's balance carries to the next run rather
            // than generating a transfer whose fee is a meaningful fraction of itself; nothing is lost, and the
            // creator screen says what is carrying. POOL_MIN_PAYOUT_CENTS.
            minPayoutCents: z.coerce.number().int().nonnegative().default(2500),
            // The currency transfers are made in — the platform's own Stripe currency. POOL_PAYOUT_CURRENCY.
            payoutCurrency: z.string().default(`usd`),
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
    `zrok.adminToken`,
    `hosted.flyApiToken`,
    `trial.keys`,
];

export const loadConfig = (): Config => loadPuristicConfig(definition);
