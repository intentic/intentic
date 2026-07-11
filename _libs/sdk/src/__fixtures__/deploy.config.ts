// Test fixture: a representative authoring declaration, compiled and asserted against deploy.graph.ts.
// The canonical user-facing example lives in /examples/deploy.config.ts; this copy exists only to pin the
// compiled desired-state graph. In-repo we import relatively so it runs under vitest with no resolve
// condition (a real consumer would `import { defineStack, env } from "@intentic/sdk"`).
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

        // What I want: an app shipped to two environments, owned by the `squad` team. The tool derives the
        // Git+CI, deploy orchestrator, runner, repo (under the team's org), and routes on the host I declared,
        // exposed through the Cloudflare account I declared.
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
    // The CLI discovers this from the API token; the fixture pins it so the compiled graph is deterministic.
    "example.com",
);
