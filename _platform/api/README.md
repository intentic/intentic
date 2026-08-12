# @intentic-app/api

The **platform backend** — Hono + oRPC + Prisma + Better Auth. The platform is an **identity + sandbox-URL store**: it authenticates the user (Google) and stores the sandbox URL the browser tells it so the browser can reach the sandbox directly. It never probes the sandbox or tracks liveness and owns no infrastructure; it sits **off the command path with exactly one exception** — the free trial ([src/trial/](src/trial/)) — and the browser otherwise talks to the sandbox daemon directly over the sandbox's own tunnel. Runs under `tsx` in dev on :6480 (the web dev-server proxies to it). Consumes [`@intentic-app/api-contract`](../../_platform/api-contract) (`implement`) + [`@intentic-app/prisma`](../../_platform/prisma).

## Responsibilities

- Authenticate the user (Better Auth + Google) and expose the typed oRPC surface (`me`, `setup.*`).
- Mint the per-user connection token + serve the setup one-liner. The workspace gate is enforced in the browser, which probes the daemon's `/health` directly — the platform never decides liveness.
- Store the sandbox's public `daemonUrl` the **browser** derives (`sandbox-<sha256(token)[:12]>.<zone>`) and writes (`setup.bind`), and serve it back (`setup.binding`) so the browser knows where to reach it. Persist nothing else about the sandbox.
- Serve the **free trial** ([src/trial/](src/trial/)): an OpenAI-compatible model API on intentic's own free-tier keys, so a user can chat before connecting any AI account. Metered per signed-in account per UTC day (`TrialUsage`), authenticated by the sandbox's connect token. **Off by default** — no `TRIAL_KEYS`, no trial.
- Run the **creator pool** ([src/pool/](src/pool/)): the paid membership (Stripe checkout/portal/webhook — Stripe stays the money's source of truth, `Membership` is the local mirror), the **install donation** a premium extension earns by (`Donation`, deduped per user/extension/month — the platform's ONLY signal about non-service extensions; no usage telemetry exists), and the **public transparency read** that states member count, the split, and every recipient's credits and earnings. **Off by default** — no `POOL_STRIPE_SECRET_KEY` + `POOL_STRIPE_PRICE_ID`, no pool.
- Meter **credit spends** ([src/pool/pool-credits.ts](src/pool/pool-credits.ts), [pool-services.ts](src/pool/pool-services.ts)): members get a daily credit allowance (the trial meter's atomic spend-then-refund shape) that both donations and service runs draw from. A run spends a service's published price, is forwarded to the provider's upstream with a timestamped HMAC (the Stripe-webhook scheme in reverse — the platform is the intermediary, so the provider verifies origin instead of identifying the user), and the provider answers by STREAMING NDJSON in the contract's ServiceStreamEvent vocabulary — validated line by line at this trust boundary, relayed live, and closed with the platform's own `receipt` trailer; a stream that dies before its `result` (like a 5xx or a timeout) is refunded with the run row saying so. Services are operator-created `Service` rows (plus the self-contained demo behind `POOL_DEMO_SERVICE`, [pool-demo.ts](src/pool/pool-demo.ts)); every spent credit pays its recipient a published share of its value on the same transparency read.
- The setup wizard's **cloud lane** ([src/sandbox/cloud/](src/sandbox/cloud/)): create ONE VM in the **user's own** cloud account (Hetzner / DigitalOcean / Oracle Always-Free) whose first boot runs the sandbox's setup code. The pasted provider credential is request-scoped like the Cloudflare zone listing — spent on the provider's catalog + create calls, never persisted — so the platform keeps no way back into the machine; only display metadata (`Sandbox.cloud`) survives.

## Routes (see [src/app.ts](src/app.ts))

- `/api/auth/**` — Better Auth (Google OAuth, session).
- `${API_BASE_PATH}/*` — the oRPC OpenAPI handler ([src/router.ts](src/router.ts): `me`, `setup.connect`, `setup.zones`, `setup.bind`, `setup.binding`). `bind` stores the browser-derived `daemonUrl`; `binding` reads it back.
- `/trial/*` — the free trial's model API (`/trial/status`, `/trial/v1/models`, `/trial/v1/chat/completions`), authenticated by the sandbox connect token. 404s entirely when `TRIAL_KEYS` is unset.
- `/pool/*` — the creator pool's non-browser routes: the daemon's ledger report + premium probe (connect-token), the services catalog + metered `POST /pool/services/:slug/run` (connect-token), Stripe's webhook (signature), and the public `GET /pool/transparency`. The browser half (membership state + credits, checkout, portal) rides the oRPC contract. 404s entirely when the pool is unconfigured.
- `/health` — DB connectivity.

## Key files

- [src/main.ts](src/main.ts) — entrypoint: `serve(...)`.
- [src/app.ts](src/app.ts) — the Hono app factory + all route wiring; [src/router.ts](src/router.ts) + [src/context.ts](src/context.ts) — oRPC.
- [src/auth.ts](src/auth.ts) — Better Auth (Google sign-in + the desktop one-time-token handoff).
- [src/sandbox/cloud/index.ts](src/sandbox/cloud/index.ts) — the cloud lane's provider switch; one plain-fetch adapter per provider beside it (Oracle's request signing in [src/sandbox/cloud/oci-sign.ts](src/sandbox/cloud/oci-sign.ts), the first-boot script in [src/sandbox/cloud/user-data.ts](src/sandbox/cloud/user-data.ts)).
- [src/config.ts](src/config.ts) — `@puristic/env` config; [src/prisma.ts](src/prisma.ts) — client factory; [src/types.ts](src/types.ts) — the shared Prisma type.

## Conventions & gotchas

- The platform is **off the command path except for the free trial** — there is no relay, no socket to the sandbox, and no sandbox-originated calls other than the daemon's announce and its trial probe. The browser calls the sandbox daemon directly (authenticated by the user's Google ID token); the platform only holds the stored URL. Trial turns are the one thing that passes through, they are labelled as such in every surface that offers them ([`TRIAL_NOTICE`](../../_sandbox/sandbox-contract/src/agent-catalog.ts)), and connecting any account takes the user off that path for good.
- **Three documented secret exceptions**, all intentic's own credentials and all optional: `INTENTIC_CLOUDFLARE_API_TOKEN` (provisioning sandbox tunnels for users who bring no Cloudflare), `TRIAL_KEYS` (the free-trial pool), and `POOL_STRIPE_SECRET_KEY`/`POOL_STRIPE_WEBHOOK_SECRET` (the creator pool's Stripe account). Everything else — Claude/git tokens, SSH keys, the user's Cloudflare — lives in the sandbox.
- `setup.connect` returns only the connection token + the connect-script URLs. The sandbox's public URL is **derived deterministically** from that token + the chosen zone (`sandbox-<sha256(token)[:12]>.<zone>`, matching the CLI's tunnel hostname) and written by the browser via `setup.bind` — the sandbox never calls the platform.
- Config is nested + SCREAMING_SNAKE-derived by `@puristic/env`; secrets are plaintext in the DB for now. No platform test harness — verify with `pnpm build` + `pnpm lint`.
