import { repoRoot } from "@intentic/constants/node";
import { type ConfigDefinition, cliArgs, env, envFile, loadConfig as loadPuristicConfig } from "@puristic/env/index.js";
import { join } from "node:path";
import { z } from "zod";

// Root .env, found by walking up to the workspace marker so loading is cwd-independent (dev runs from
// _platform/api) AND depth-independent, this file's distance from the root is no longer part of the answer.
const rootEnv = join(repoRoot(import.meta.url), ".env");

// Nested schema. @puristic/env derives env var names by SCREAMING_SNAKE-casing each path segment and joining
// with "_": database.url → DATABASE_URL, betterAuth.secret → BETTER_AUTH_SECRET, google.clientId →
// GOOGLE_CLIENT_ID, etc. Secrets are marked with .meta({ secret: true }); plaintext for now, encryptable later.
//
// Strict, sandbox-centric model (CLAUDE.md): the platform holds no backend/infra secrets. The only credentials
// here are for the central account (Google sign-in) and the platform's own session signing, everything else
// (Claude/git tokens, SSH keys, Cloudflare) lives in the user's sandbox.
export const configSchema = z.object({
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
    // Browser-facing origin of the API, where the SPA calls /rpc + /api/auth directly (no dev-server proxy).
    // In dev this is http://localhost:6480; the SPA's own origin is webOrigin. Also the base Better Auth uses
    // + the CORS allow-origin.
    webOrigin: z.url(),
    google: z
        .object({
            clientId: z.string().default(``),
            clientSecret: z.string().default(``).meta({ secret: true }),
        })
        .prefault({}),
    /* THE PLATFORM'S OPERATORS. Comma-separated emails whose signed-in session may call the admin surface
     * (guards.ts requireAdmin) — deployment config rather than a database row on purpose: sign-in is
     * Google-only, so a session's email is Google-verified, and an allowlist the API cannot write means no
     * endpoint exists that could mint an admin (adding one is a redeploy, which is the right friction).
     * Empty (the default, and the only sane one for a fresh self-hosted platform) disables the admin
     * surface outright: every /admin route answers FORBIDDEN for everybody. ADMIN_EMAILS. */
    admin: z
        .object({
            emails: z.string().default(``),
            /* The second gate, for the admin surface's MUTATIONS (suspend a service, retry a payout, stop a
             * machine, delete an account). Off by default and separate from `emails` on purpose: the panel's
             * bytes are workspace-authored until it graduates to a pinned install, and a read-only surface
             * is the stated safety of that arrangement. Flip this only on a deployment whose panel is
             * pinned. Every mutation also requires a typed confirmation input naming its target.
             * ADMIN_MUTATIONS. */
            mutations: z.stringbool().default(false),
        })
        .prefault({}),
    // Transactional email (Resend), sandbox invites, and the setup link a phone sends itself to finish on a
    // real machine (mail.ts). `apiKey` is the Resend API key (re_…); `from` is the verified sender (e.g.
    // "intentic <invites@your-domain>"). Unset → both are still accepted but the link is logged server-side
    // instead of emailed (dev only; main.ts warns).
    email: z
        .object({
            apiKey: z.string().default(``).meta({ secret: true }), // EMAIL_API_KEY (re_…)
            from: z.string().default(``), // EMAIL_FROM
        })
        .prefault({}),
    /* Intentic-OWNED Cloudflare token + zone. DNS ONLY since the tunnel fabric moved in-house (zrok above).
     * What is left of it: the loopback certificate's `*.local.<zone>` wildcard and the per-order ACME
     * challenge beside it (the daemon relays for both, having no token for this zone), plus the daily sweep
     * that clears the residue of everything this platform used to mint here.
     *
     * "Nothing against the per-zone quota" is now true and was not before: a sandbox used to leave a
     * `local-<id>` A record behind forever, that was the last per-sandbox record anywhere in this zone after
     * the zrok move, and enough of them filled the zone and stopped issuance for everyone. DNS-ONLY is also
     * literal, the sweep may not call anything but /dns_records, or a narrowed token kills it.
     *
     * Unset ⇒ the loopback-certificate path is simply off. */
    intenticCloudflare: z
        .object({
            apiToken: z.string().default(``).meta({ secret: true }), // INTENTIC_CLOUDFLARE_API_TOKEN
            zone: z.string().default(`intentic.dev`), // INTENTIC_CLOUDFLARE_ZONE
            /* MAY THIS DEPLOYMENT DELETE RECORDS IN THAT ZONE? Off by default, and the default is the whole
             * point. The sweep decides what is an orphan by asking THIS deployment's database, and a zone is
             * shared by every deployment holding the token: a developer running the API locally with the
             * production credentials in their env swept the production zone against an empty local database
             * and deleted the tunnel records of live sandboxes. Nothing in the code could have known the
             * difference, so the operator says. Unset ⇒ the sweep still runs and still reports (the record
             * count is the number that matters for quota) and simply never deletes.
             * INTENTIC_CLOUDFLARE_REAP. */
            reap: z.stringbool().default(false),
            // Report the candidates without deleting even where reaping is ON: a new deployment's first sweep
            // runs with this, the operator confirms the list, then it comes off. INTENTIC_CLOUDFLARE_REAP_DRY_RUN.
            reapDryRun: z.stringbool().default(false),
        })
        .prefault({}),
    /* THE TUNNEL FABRIC, the self-hosted zrok hub every sandbox reaches its owner through (sandbox/zrok.ts;
     * the `zrok` Komodo stack runs it). The platform holds the hub's ADMIN token and mints one account per
     * sandbox; the box's own `zrok2 enable` births the identity, so this credential creates and revokes
     * reachability but can never impersonate a sandbox. Replaces the Cloudflare tunnel machinery outright,
     * intenticCloudflare below is DNS-only residue now (loopback-cert records). `adminToken` is the switch:
     * empty (the default for a platform that has not stood the hub up) leaves every provisioning route 404
     * and the wizard offering only the attach lane. */
    zrok: z
        .object({
            // The controller API as the PLATFORM reaches it (LAN address is fine). ZROK_API_ENDPOINT.
            apiEndpoint: z.url().default(`https://zrok2.sbx.intentic.dev`),
            // The same controller as SANDBOXES reach it, differs from the above when the platform sits on
            // the hub's LAN but the boxes come in from outside. Empty ⇒ same as apiEndpoint. ZROK_AGENT_ENDPOINT.
            agentEndpoint: z.string().default(``),
            // The hub's admin token (ZROK2_ADMIN_TOKEN of the zrok stack). ZROK_ADMIN_TOKEN.
            adminToken: z.string().default(``).meta({ secret: true }),
            // The DNS zone the wildcard record serves, the suffix of every sandbox hostname. ZROK_ZONE.
            zone: z.string().default(`sbx.intentic.dev`),
        })
        .prefault({}),
    /* THE HOSTED LANE, intentic's OWN Fly.io credential, the THIRD documented exception to the secret-free
     * model (intenticCloudflare and trial.keys are the others), and the one that changes the trust story the
     * most: for a HOSTED sandbox the platform creates the machine, keeps the way back in (start/stop/destroy),
     * and the provider could reach inside it, so a platform breach reaches hosted machines, where every other
     * lane stays out of reach by construction. ARCHITECTURE.md states this trade in full; every other lane is
     * unchanged, and a platform with no token here (the default, and the right one for self-hosters) has no
     * hosted lane at all: the routes 404 and the editor never offers it.
     *
     * `flyApiToken` is the switch (org rides along, a token without an org cannot place a machine). The rest
     * sizes the starter box: deliberately small and cheap, because the lane's job is "signed in → working
     * sandbox in seconds", and the wizard's ladder (Oracle free tier, your cloud, your machine) is the answer
     * for power, not a bigger bill here. */
    hosted: z
        .object({
            // Org-scoped Fly API token (fly tokens create -o <org>). HOSTED_FLY_API_TOKEN.
            flyApiToken: z.string().default(``).meta({ secret: true }),
            // The Fly organization slug hosted apps are created in. HOSTED_FLY_ORG.
            flyOrg: z.string().default(``),
            // Fly region code a machine lands in when the caller is outside the EEA. HOSTED_REGION.
            region: z.string().default(`iad`),
            /* Where an EEA caller's machine lands instead. The privacy policy PROMISES this, a European
             * user's workspace, and every file and secret they put in it, stays inside the EEA rather than
             * crossing to Ashburn, so the pick is a data-protection commitment, not a latency tweak, and
             * emptying this knob breaks a published statement rather than merely a default.
             * HOSTED_REGION_EU. */
            regionEu: z.string().default(`arn`),
            // Fly app names are GLOBALLY unique: <appPrefix>-<sandbox id> keeps ours claimable and lets the
            // reaper recognize our apps by prefix. HOSTED_APP_PREFIX.
            appPrefix: z.string().default(`intentic-sbx`),
            // The image a hosted machine boots, the same public sandbox image every other lane runs.
            // HOSTED_IMAGE.
            image: z.string().default(`ghcr.io/intentic/sandbox:stable`),
            /* The starter machine: shared CPUs + memory in MB (Fly guest shape), disk in GB. HOSTED_CPUS,
             * HOSTED_MEMORY_MB, HOSTED_VOLUME_GB.
             *
             * Sized against `monthlyHours` below, not against what a workstation wants. Once awake time is
             * capped the guest shape stops being the bill's driver, a capped month on this shape costs less
             * than the DISK did on the 4×/8 GB/20 GB box this replaces, so the money saved by halving memory
             * again buys nothing and costs the thing people actually notice: 4 GB survives an install and a
             * build on a real repository, 2 GB meets the OOM killer and reads as "intentic is broken". */
            cpus: z.coerce.number().int().positive().default(2),
            memoryMb: z.coerce.number().int().positive().default(4096),
            volumeGb: z.coerce.number().int().positive().default(10),
            // Hosted sandboxes per user. The free promise is ONE instant box each; more is a product decision,
            // not a config bump someone makes casually. HOSTED_PER_USER.
            perUser: z.coerce.number().int().positive().default(1),
            // Minutes of nobody-watching-nothing-running before the daemon exits and the machine stops,
            // rides into the box as IDLE_STOP_MINUTES. 0 disables (always-on). HOSTED_IDLE_STOP_MINUTES.
            idleStopMinutes: z.coerce.number().int().nonnegative().default(20),
            /* THE FREE LANE'S CEILING: awake hours per calendar month for an owner WITHOUT a membership.
             * Members are unmetered, so this is the one number that decides what the free machine costs and
             * the one place the hosted lane asks anybody to upgrade.
             *
             * Charged only while the machine is actually awake, it sleeps after `idleStopMinutes`, so
             * thinking time and a closed laptop cost nothing, and enforced at WAKE, never mid-session:
             * running out means the next visit offers the upgrade, not that the box dies under someone's
             * hands. 0 disables the ceiling (self-hosters metering nothing). HOSTED_MONTHLY_HOURS. */
            monthlyHours: z.coerce.number().int().nonnegative().default(40),
            /* THE FREE LANE'S EXPIRY, in days since the machine was last woken. A hosted disk bills every day
             * it exists, so a machine nobody has opened since spring is the free tier's largest cost and its
             * least useful one. Non-members only; a member's machine is never collected.
             *
             * `idleWarnDays` sends one email first, the machine is about to go, opening it is the whole
             * remedy, because this deletes a disk somebody may still want. Either at 0 disables the sweep.
             * HOSTED_IDLE_DAYS, HOSTED_IDLE_WARN_DAYS. */
            idleDays: z.coerce.number().int().nonnegative().default(21),
            idleWarnDays: z.coerce.number().int().nonnegative().default(14),
            /* THE WARM POOL: machines built (image pulled, then stopped) before anyone asks, PER REGION, so
             * claiming the free sandbox costs the seconds of a machine start instead of the minutes of an
             * image pull. A pool machine holds no identity and no running compute, its standing cost is its
             * volume, and the reconcile job keeps the pool at this size, rebuilding it when the image moves.
             * ON by default (a couple of volumes per region is cheap; every cold first boot reported as
             * "stuck" is not), and only where the lane itself is on, a platform without hosted credentials
             * builds nothing regardless. 0 disables the pool and drains anything left in it.
             * HOSTED_POOL_SIZE. */
            poolSize: z.coerce.number().int().nonnegative().default(2),
            /* HOW OFTEN THE LANE IS CHECKED AGAINST THE PROVIDER, in minutes (hosted-health.ts). Read-only:
             * it compares the platform's rows with what Fly actually has and says so, loudly, when they
             * disagree. It exists because they did disagree, for days, and the only trace was one warn line
             * per machine per night while every affected person met a button that could not work. 0 turns the
             * watch off. HOSTED_HEALTH_MINUTES. */
            healthMinutes: z.coerce.number().int().nonnegative().default(15),
            /* THE PROVISIONING CANARY (hosted-canary.ts): how often, in minutes, the platform provisions a
             * sandbox of its own end to end and waits for its daemon to check in, then destroys it. The health
             * watch above compares rows against Fly, which cannot see a lane that is intact but no longer
             * WORKS, an image that stopped booting, a tunnel grant the hub refuses, a region out of capacity.
             * All of those look perfect from here and show up only as people who never arrive.
             *
             * OFF by default because every run spends a real machine's few minutes. Both knobs are required:
             * the email is the account the canary's sandbox belongs to, and it must be one nobody signs in as.
             * HOSTED_CANARY_MINUTES, HOSTED_CANARY_EMAIL. */
            canaryMinutes: z.coerce.number().int().nonnegative().default(0),
            canaryEmail: z.string().default(``),
            /* WHO THIS DEPLOYMENT IS to the provider, stamped into every machine it creates and the only
             * thing its orphan sweep will destroy (hosted.ts). Derived from the API URL and the database when
             * empty, which separates deployments without anybody having to remember a knob; set it only to
             * carry an identity across a database move, or to hand one fleet deliberately from one deployment
             * to another. Two deployments sharing this value share a fleet, including the right to destroy
             * each other's machines. HOSTED_INSTANCE_ID. */
            instanceId: z.string().default(``),
        })
        .prefault({}),
    /* THE FREE-TRIAL POOL, intentic's OWN model keys, and the SECOND documented exception to the secret-free
     * model above (intenticCloudflare is the first). It is a larger exception than that one and says so here
     * rather than in a commit message: a tunnel token is spent provisioning DNS, while these keys serve model
     * turns, so for as long as a user is on the trial their prompts pass through the platform. That is the whole
     * cost of letting someone chat before they own any AI subscription, it is bounded to the trial, and every
     * surface that offers the trial says it in those words.
     *
     * `keys` is the switch. Empty (the default, and the only sane one for a self-hosted platform) disables the
     * trial outright: the routes 404, the daemon provisions nothing, and the chat's front door is the free
     * Google sign-in alone. Several keys are a POOL. Google's free tier is sized for one developer, so a launch
     * day exhausts one project's quota and the next key takes the turn rather than the user meeting a 429. */
    trial: z
        .object({
            // Comma-separated Google AI Studio API keys, tried in order. TRIAL_KEYS.
            keys: z.string().default(``).meta({ secret: true }),
            // Google's OpenAI-compatible surface. Any OpenAI-shaped upstream works; this is the one whose free
            // tier is meant for serving end users. TRIAL_BASE_URL.
            baseUrl: z.url().default(`https://generativelanguage.googleapis.com/v1beta/openai`),
            /* Comma-separated model ids the trial may ROUTE TO, in preference order. Empty (the default) uses
             * the curated ladder in code (trial-ladder.ts).
             *
             * This narrows what the trial SPENDS, not what it OFFERS, the two used to be the same list and
             * that was the bug. The trial now publishes a single synthetic id and picks a real model per
             * message, walking this list until one answers, so an operator keeping a free tier off the
             * expensive end sets it here and users never see the difference. An operator who repoints
             * TRIAL_BASE_URL off Google must set it: the curated ladder names Google's aliases, and this
             * replaces it wholesale rather than filtering it. TRIAL_MODELS. */
            models: z.string().default(``),
            // Messages per signed-in account per UTC day. Enough to judge the product, far too few to work on.
            // TRIAL_DAILY_MESSAGES.
            dailyMessages: z.coerce.number().int().nonnegative().default(12),
        })
        .prefault({}),
    /* THE CREATOR POOL, the optional paid membership whose revenue premium-extension creators share.
     *
     * `stripeSecretKey` + `stripePriceId` are the switch, exactly like trial.keys: both empty (the default,
     * and the right one for a self-hosted platform) and the pool does not exist: /pool routes 404, the web
     * app offers no membership, premium extensions cannot be enabled anywhere that points at this platform.
     * Stripe stays the money's source of truth; the platform mirrors just enough (pool/pool-membership.ts)
     * to answer "is this user premium" without a Stripe round-trip on hot paths. */
    pool: z
        .object({
            // The Stripe secret key (sk_… / rk_…). POOL_STRIPE_SECRET_KEY.
            stripeSecretKey: z.string().default(``).meta({ secret: true }),
            // The signing secret of the /pool/webhook endpoint (whsec_…), without it subscription events
            // are refused, so a pool that takes money must set it. POOL_STRIPE_WEBHOOK_SECRET.
            stripeWebhookSecret: z.string().default(``).meta({ secret: true }),
            // The recurring Price the checkout sells (price_…). POOL_STRIPE_PRICE_ID.
            stripePriceId: z.string().default(``),
            // The membership's monthly price in USD as the transparency page states it, display + pool math
            // only; what Stripe actually charges is the Price above. POOL_PRICE_USD.
            priceUsd: z.coerce.number().nonnegative().default(20),
            /* WHAT THE MEMBERSHIP BUYS BEFORE IT BUYS ANYTHING FOR A CREATOR: the per-member monthly cost of
             * running the platform, a member's hosted machine and disk above all, taken off the top, so the
             * pool is what is left rather than the whole ticket.
             *
             * Without this the shares are levied on gross, and a member who spends their whole allowance
             * leaves the platform ~$2 of $20 while costing it more than that to host: the more someone uses
             * the product, the worse it does, which is not a pricing bug that can be grown out of. Taking it
             * off the top instead means the published share stays LITERALLY true of the pool it names, the
             * alternative, quietly paying creators 90% of something called $20 that isn't, is the kind of
             * asterisk this whole model exists not to have. The transparency report states it as its own
             * line for the same reason. 0 restores the old gross-share behaviour. POOL_INFRA_USD. */
            infraUsd: z.coerce.number().nonnegative().default(5),
            // The fraction of a spent credit's VALUE its recipient earns, a donated credit pays the
            // extension's creator this share, a consumed credit pays the service's provider this share
            // (credit value is derived and published: (priceUsd − infraUsd) / (30 × dailyCredits)). The
            // published number the whole model stands on, change it loudly or not at all. POOL_CREATOR_SHARE.
            creatorShare: z.coerce.number().min(0).max(1).default(0.9),
            // A member's daily credit allowance, reset at UTC midnight like the trial. The membership's cost
            // ceiling: 1000/day bounds what a member can spend, on service runs and on install donations,
            // which is what lets a flat price fund a per-credit economy at all. POOL_DAILY_CREDITS.
            dailyCredits: z.coerce.number().int().nonnegative().default(1000),
            // What a service's provider earns per consumed credit, as a share of its value, kept a separate
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
            /* Comma-separated emails that count as premium WITHOUT a subscription, complimentary
             * memberships. Checked at premium-answer time (pool-membership.ts), never seeded as rows, so it
             * works the moment the account exists and reverts the moment the email leaves the list. A comped
             * member rides the same daily credit meter as a paying one but is absent from the ledger's member
             * count and revenue (they pay nothing); their spends still earn creators the usual share, which
             * comes out of the pool, comp sparingly. Local dev's way to a runnable paid-services flow, and
             * the operator's way to comp a person. POOL_COMP_EMAILS. */
            compEmails: z.string().default(``),
            // The registry whose listings decide which repositories back a publisher name, the authority a
            // publisher claim is checked against (creator/creator-claim.ts). The official registry by default;
            // a platform running its own points this at that repository's marketplace file, and claims are then
            // proved against the listings it actually serves. POOL_REGISTRY_URL.
            registryUrl: z.url().default(`https://raw.githubusercontent.com/intentic/registry/HEAD/.claude-plugin/marketplace.json`),
            // The day of the month a closed month's statements become payable. A month closes as soon as it is
            // over and pays mid-month, so the gap is a stated hold window for refunds and card disputes rather
            // than an unexplained delay, and a creator reads a date instead of "soon". POOL_PAYOUT_DAY.
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
            // The currency transfers are made in, the platform's own Stripe currency. POOL_PAYOUT_CURRENCY.
            payoutCurrency: z.string().default(`usd`),

            /* OPEN ADMISSION (pool/pool-admission.ts), the published thresholds a provider is measured
             * against. Every one of them is here rather than in the code because the whole promise of
             * rules-based admission is that the rules are readable in advance: a number a provider cannot
             * look up is a human review wearing a constant's clothes. */
            // Whether a provider may list a service without an operator. Off restores the hand-written flow;
            // operator rows keep working either way, because no gate applies to a row with no owner.
            // POOL_OPEN_ADMISSION.
            openAdmission: z.stringbool().default(true),
            // The price band a listing may publish inside, and the tighter ceiling probation holds it under.
            // A new listing that could name any price would make the probation badge the only thing standing
            // between a member and a 1000-credit surprise. POOL_SERVICE_MIN_CREDITS / _MAX / _PROBATION_MAX.
            serviceMinCredits: z.coerce.number().int().positive().default(1),
            serviceMaxCredits: z.coerce.number().int().positive().default(200),
            probationMaxCredits: z.coerce.number().int().positive().default(25),
            // How long a passed conformance probe stays good enough to publish on. Short on purpose: the
            // probe's whole claim is "this endpoint works right now". POOL_PROBE_FRESH_MINUTES.
            probeFreshMinutes: z.coerce.number().int().positive().default(60),
            // Served runs a probation listing needs before it graduates, and the refund rate that both blocks
            // graduation and trips the watch. POOL_GRADUATION_RUNS / POOL_MAX_REFUND_RATE.
            graduationRuns: z.coerce.number().int().positive().default(50),
            maxRefundRate: z.coerce.number().min(0).max(1).default(0.2),
            // How many recent runs the tripwire judges on, small enough to react, large enough that three
            // unlucky timeouts don't delist a working service. POOL_WATCH_WINDOW_RUNS.
            watchWindowRuns: z.coerce.number().int().positive().default(20),
            // Consecutive failed canary probes before a live listing is suspended. POOL_CANARY_FAILURES.
            canaryFailures: z.coerce.number().int().positive().default(3),
            // How often a provider may move a listing's price. POOL_PRICE_CHANGE_HOURS.
            priceChangeHours: z.coerce.number().int().nonnegative().default(24),
            // The most listings one account may hold live at once, the crude Sybil bound the design doc
            // names, priced against nothing yet because no abuse has been observed. POOL_MAX_SERVICES.
            maxServicesPerOwner: z.coerce.number().int().positive().default(5),
        })
        .prefault({}),
    // Where the connect bootstrap scripts are served from, the cloud lane bakes `${scriptOrigin}/connect`
    // into a new VM's first-boot script (sandbox/cloud/user-data.ts), the same URL the setup wizard's
    // copy-paste command uses. A self-hosted platform points this at its own site. SCRIPT_ORIGIN.
    scriptOrigin: z.url().default(`https://intentic.dev`),
    api: z
        .object({
            url: z.url().default(`http://localhost:6480`),
            port: z.coerce.number().int().positive().default(6480),
            // Bind address. Loopback in dev, localhost is the origin the dev cert, CORS, and Better Auth all
            // trust, so a container must set API_HOST=0.0.0.0 for the reverse proxy / tunnel (a separate
            // container or host) to reach it. TLS is still terminated by that proxy in prod.
            host: z.string().default(`127.0.0.1`),
            // Dev TLS: paths to a cert/key (the @intentic-app/localhost-https package) so the API serves https,
            // matching the https SPA. Google's FedCM One Tap needs https and won't run on http://localhost.
            // Empty in prod, where TLS is terminated by the proxy in front of the API.
            httpsKey: z.string().default(``),
            httpsCert: z.string().default(``),
        })
        .prefault({}),
    /* THE AGENT WALLET's signer, the platform half of a sandbox spending USDC on x402 endpoints.
     *
     * `custodyUrl` + `custodyKey` are the switch, exactly like pool.stripeSecretKey: both empty (the
     * default, and the right one for a self-hosted platform) and there is no signer: /wallet routes 404,
     * a sandbox's wallet capability stays pending and says so on its card. The platform never holds key
     * material either way: the credential here authenticates it to a custody provider that holds the
     * member's wallet and signs with it (wallet/wallet-custody.ts). */
    wallet: z
        .object({
            // The custody provider's API root. WALLET_CUSTODY_URL.
            custodyUrl: z.string().default(``),
            // The platform's API credential there. WALLET_CUSTODY_KEY.
            custodyKey: z.string().default(``).meta({ secret: true }),
        })
        .prefault({}),
    /* THE PUSH RELAY's forwarding credential, the FOURTH documented exception to the secret-free model
     * (intenticCloudflare, trial.keys and hosted.flyApiToken are the others), and the narrowest: Apple only
     * accepts pushes from the app's vendor, so a daemon on the owner's own hardware cannot notify the iOS
     * shell without SOMEONE holding this key, and that someone can only be the platform. What passes through
     * is a notification's title and body, never a transcript, never a diff (the daemon's payloads are
     * pointers back into the workspace by design), but it passes through READABLE, unlike web push, and the
     * push-relay README states that trade in full.
     *
     * `keyP8` is the switch, exactly like trial.keys: empty (the default, and the right one for a platform
     * that ships no iOS app) and the relay does not exist: /push routes 404, and the web app inside the
     * shell reports notifications unsupported rather than half-working. */
    apns: z
        .object({
            // The APNs auth key, the .p8 file's contents, literal "\n" escapes accepted. APNS_KEY_P8.
            keyP8: z.string().default(``).meta({ secret: true }),
            // The key's id (from the Apple developer portal) and the team it belongs to. APNS_KEY_ID,
            // APNS_TEAM_ID.
            keyId: z.string().default(``),
            teamId: z.string().default(``),
            // The iOS shell's bundle id. APNs routes on it (`apns-topic`). APNS_BUNDLE_ID.
            bundleId: z.string().default(`dev.intentic.app`),
            // Apple's production gateway; point at https://api.sandbox.push.apple.com for development builds
            // (a token minted by a debug install is unknown to the production gateway). APNS_URL.
            url: z.url().default(`https://api.push.apple.com`),
        })
        .prefault({}),
    // Pino logging. LOG_LEVEL sets verbosity; LOG_PRETTY toggles human-readable dev output (colorized,
    // in-process) vs. single-line JSON for prod. Defaults to pretty everywhere but production.
    log: z
        .object({
            level: z.enum([`fatal`, `error`, `warn`, `info`, `debug`, `trace`, `silent`]).default(`info`),
            // z.stringbool parses "true"/"false"/"1"/"0" from the env string (z.coerce.boolean treats any
            // non-empty string, including "false", as true).
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

// Dotted paths of secret fields, pass to mask() before logging the config.
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
    `apns.keyP8`,
];

export const loadConfig = (): Config => loadPuristicConfig(definition);
