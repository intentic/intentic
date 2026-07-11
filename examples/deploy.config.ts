// Canonical intent file. `intentic resolve` imports this module, reads the exported `intent`, computes
// every valid desired-state artifact (one per option combination that meets the needs), and
// auto-picks one; `intentic apply` then reconciles that artifact until state reads true.
//
// `env` comes from its true source, @intentic/graph (the SDK does not re-export it).

import { env } from "@intentic/graph";
import { defineIntent } from "@intentic/sdk";

export const intent = defineIntent((i) => {
    // What I have: the host the apps run on (its SSH connection) and the Cloudflare account they're exposed
    // through. address/user are authored literals and the SSH key + API token are env-sourced secrets; the DNS
    // zone and the account that owns it are discovered from the API token (the app domains pick which of the
    // token's zones to use), so neither is authored here.
    const host = i.have.host("host", {
        address: "127.0.0.1",
        user: "deploy",
        sshKey: env("HOST_SSH_KEY"),
    });

    const cf = i.have.cloudflare("cf", {
        apiToken: env("CLOUDFLARE_API_TOKEN"),
    });

    // What I have: a Discord bot that intentic uses as the back-communication channel. intentic owns the
    // full server structure (categories, channels, webhooks); the operator supplies only the bot token.
    // CI/CD notifications + reconcile summaries are posted automatically for apps that wire it.
    const discord = i.have.discord("discord", {
        botToken: env("DISCORD_BOT_TOKEN"),
    });

    // What I want (a shared service): SignOz for observability, deployed onto the host and exposed at its own
    // domain. Apps wire to it via `observe` below; intentic injects its OTLP endpoint into each deployment.
    const obs = i.want.service("obs", {
        kind: "signoz",
        on: host,
        expose: cf,
        domain: "signoz.example.com",
    });

    // What I want (backing capabilities): a database (Postgres) and a cache (Valkey), both internal-only —
    // intentic deploys each onto the host and an app consumes them via `use` below. There is no domain: apps
    // reach them over the host's internal network, never a public route. The catalog maps the abstract
    // capability to its concrete provider, so the intent never names Postgres/Valkey.
    const db = i.want.database("db", { on: host });
    const cache = i.want.cache("cache", { on: host });

    // What I want (more backing capabilities): single sign-on (Authentik) and object storage (Garage). auth
    // always routes — the OIDC issuer must be a public HTTPS URL — so it takes a domain; objectStorage is
    // internal-only unless given one. An app that `use`s auth gets a per-app OIDC client (OIDC_ISSUER /
    // OIDC_CLIENT_ID / OIDC_CLIENT_SECRET injected); one that uses objectStorage gets a per-app bucket + key
    // (S3_ENDPOINT / S3_ACCESS_KEY / S3_SECRET_KEY / S3_BUCKET).
    const auth = i.want.auth("auth", { on: host, expose: cf, domain: "auth.example.com" });
    const store = i.want.objectStorage("store", { on: host, expose: cf, domain: "s3.example.com" });

    // What I want (the AI-agent workspace): a per-host sandbox for the project's repos that serves live
    // previews. It takes no domain — previews are served at the wildcard
    // `*.preview.<zone>` derived from the discovered zone. The browser drives the agent in it directly.
    i.want.workspace("workspace", { on: host, expose: cf });

    // Who works on the app: people get a Forgejo git account + a Komodo UI user (each with an intentic-generated
    // password, surfaced in the secrets file). A team becomes a Forgejo organization + team and a Komodo
    // permission scope: its members can act on the deployments of the apps it manages at the `komodo` level.
    const alice = i.want.user("alice", { username: "alice", email: "alice@example.com" });
    const bob = i.want.user("bob", { username: "bob", email: "bob@example.com" });
    const platform = i.want.team("platform", { members: [alice, bob], komodo: "execute" });

    // What I want (an app): shipped to two environments. The tool derives the needs (source control, Docker
    // registry, infra control, deployment target, domain) and the support stack that meets them — on the host
    // I declared, exposed through the Cloudflare I declared — and exports the app's telemetry to `obs`. The
    // `platform` team owns the app: its org owns the repo (the repo + image namespace) and its members get
    // write on the repo + Komodo execute on the deployments.
    // `use` wires the backing capabilities: intentic mints a per-app database + role and a per-app Valkey ACL
    // user, then injects DATABASE_URL and VALKEY_URL/REDIS_URL into every deployment (no manual env wiring).
    i.want.app("my-app", {
        on: host,
        expose: cf,
        notify: discord,
        observe: obs,
        use: [db, cache, auth, store],
        teams: [{ team: platform, role: "write" }],
        environments: {
            staging: { domain: "staging.example.com", branch: "develop" },
            production: { domain: "app.example.com", branch: "main" },
        },
    });
});
