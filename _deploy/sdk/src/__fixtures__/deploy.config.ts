// Test fixture compiled and asserted against deploy.graph.ts; the canonical example lives in
// /_tools/examples/deploy.config.ts. Imports relatively so it runs under vitest; a real consumer imports from
// "@intentic/sdk".
import { env } from "@intentic/graph";
import { defineStack } from "../index.js";

export const graph = defineStack(
    (i) => {
        // What I have: one SSH + Docker host, one Cloudflare account.
        const host = i.have.host("host", {
            address: "203.0.113.10",
            user: "deploy",
            sshKey: env("HOST_SSH_KEY"),
        });

        const cf = i.have.cloudflare("cf", {
            apiToken: env("CLOUDFLARE_API_TOKEN"),
        });

        // Who works on the app: a user (Forgejo git account + Komodo UI user) and a team that owns the app.
        const dev = i.want.user("dev", { username: "dev", email: "dev@example.com" });
        const squad = i.want.team("squad", { members: [dev], komodo: "execute" });

        // An app shipped to two environments, owned by squad; derives git+CI, deploy, runner, repo, and routes.
        i.want.app("my-app", {
            on: host,
            expose: cf,
            teams: [{ team: squad, role: "write" }],
            environments: {
                staging: { domain: "staging.example.com", branch: "develop", env: { DATABASE_URL: env("STAGING_DATABASE_URL") } },
                production: { domain: "app.example.com", branch: "main", env: { DATABASE_URL: env("PRODUCTION_DATABASE_URL") } },
            },
        });
    },
    // The CLI normally discovers this from the API token; pinned here for a deterministic compiled graph.
    "example.com",
);
