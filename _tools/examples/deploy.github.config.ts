// Example: deploy an app using GitHub as the source-control + CI backend.
// Instead of self-hosting Forgejo, intentic uses GitHub repos, GitHub Actions, and GHCR. Komodo still runs
// on the host as the deploy orchestrator, you own your infrastructure; GitHub owns the source pipeline.

import { env } from "@intentic/graph";
import { defineIntent } from "@intentic/sdk";

export const intent = defineIntent((i) => {
    // What I have: a host (SSH) and a GitHub account (PAT).
    const host = i.have.host("host", {
        address: "203.0.113.10",
        user: "deploy",
        sshKey: env("HOST_SSH_KEY"),
    });

    i.have.github("gh", {
        token: env("GITHUB_TOKEN"),
    });

    const cf = i.have.cloudflare("cf", {
        apiToken: env("CLOUDFLARE_API_TOKEN"),
    });

    // What I want: an app. intentic derives a GitHub repo, a GitHub Actions workflow (build → GHCR →
    // notify Komodo), Komodo on the host rolling out the pushed image, and a Cloudflare tunnel + DNS route.
    // No Forgejo, no self-hosted runner, and no host SSH key ever leaves for GitHub.
    i.want.app("my-app", {
        on: host,
        expose: cf,
        environments: {
            production: { domain: "app.example.com", branch: "main" },
            staging: { domain: "staging.example.com", branch: "develop" },
        },
    });
});
