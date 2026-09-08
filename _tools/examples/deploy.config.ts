// Canonical intent file: `intentic deploy resolve` computes every valid desired-state artifact from the exported
// `intent` and picks one; `intentic deploy apply` reconciles until it holds. `env` comes from @intentic/graph; the SDK
// doesn't re-export it.

import { env } from "@intentic/graph";
import { defineIntent } from "@intentic/sdk";

export const intent = defineIntent((i) => {
    // Host (SSH) and the Cloudflare account apps expose through: address/user and secrets are authored/env-sourced, but
    // the DNS zone and its owning account are discovered from the API token.
    const host = i.have.host("host", {
        address: "127.0.0.1",
        user: "deploy",
        sshKey: env("HOST_SSH_KEY"),
    });

    const cf = i.have.cloudflare("cf", {
        apiToken: env("CLOUDFLARE_API_TOKEN"),
    });

    // Discord bot as intentic's back-channel: intentic owns the full server structure (categories, channels, webhooks);
    // only the bot token is supplied. CI/CD notifications and reconcile summaries post automatically for apps that wire
    // it.
    const discord = i.have.discord("discord", {
        botToken: env("DISCORD_BOT_TOKEN"),
    });

    // Shared SignOz observability service on the host, exposed at its own domain; apps wire to it via `observe`, and
    // intentic injects its OTLP endpoint into each deployment.
    const obs = i.want.service("obs", {
        kind: "signoz",
        on: host,
        expose: cf,
        domain: "signoz.example.com",
    });

    // Postgres and Valkey, internal-only backing capabilities on the host; apps reach them over the host's network via
    // `use`, never a public route. The catalog maps the abstract capability to its provider.
    const db = i.want.database("db", { on: host });
    const cache = i.want.cache("cache", { on: host });

    // Single sign-on (Authentik) and object storage (Garage). auth always needs a domain (its OIDC issuer must be
    // public HTTPS); objectStorage is internal-only unless given one. `use` injects:
    // OIDC_ISSUER / OIDC_CLIENT_ID / OIDC_CLIENT_SECRET for auth.
    // S3_ENDPOINT / S3_ACCESS_KEY / S3_SECRET_KEY / S3_BUCKET for objectStorage.
    const auth = i.want.auth("auth", { on: host, expose: cf, domain: "auth.example.com" });
    const store = i.want.objectStorage("store", { on: host, expose: cf, domain: "s3.example.com" });

    // Per-host sandbox serving live previews of the project's repos, no domain: previews land on the wildcard
    // `*.preview.<zone>` from the discovered zone. The browser drives the agent directly.
    i.want.workspace("workspace", { on: host, expose: cf });

    // People get a Forgejo account and a Komodo user (generated passwords in the secrets file); a team becomes a
    // Forgejo org+team and a Komodo permission scope, letting its members act on the apps it manages.
    const alice = i.want.user("alice", { username: "alice", email: "alice@example.com" });
    const bob = i.want.user("bob", { username: "bob", email: "bob@example.com" });
    const platform = i.want.team("platform", { members: [alice, bob], komodo: "execute" });

    // App shipped to two environments: the tool derives its needs and the support stack that meets them; `platform`
    // gets repo write plus Komodo execute. `use` injects DATABASE_URL and VALKEY_URL/REDIS_URL automatically.
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
