// Example: deploy an app using GitLab as the source-control + CI backend.
// Instead of self-hosting Forgejo, intentic uses GitLab projects, GitLab CI (.gitlab-ci.yml), and the GitLab
// Container Registry. Komodo still runs on the host as the deploy orchestrator, you own your infrastructure;
// GitLab owns the source pipeline. Works with gitlab.com or a self-hosted instance (set `url`).

import { env } from "@intentic/graph";
import { defineIntent } from "@intentic/sdk";

export const intent = defineIntent((i) => {
    // What I have: a host (SSH) and a GitLab account (PAT). `url` defaults to https://gitlab.com; set it to a
    // self-hosted instance if needed. `owner` defaults to the token's user; set it to a group path to publish there.
    const host = i.have.host("host", {
        address: "203.0.113.10",
        user: "deploy",
        sshKey: env("HOST_SSH_KEY"),
    });

    i.have.gitlab("gl", {
        token: env("GITLAB_TOKEN"),
        url: "https://gitlab.com",
    });

    const cf = i.have.cloudflare("cf", {
        apiToken: env("CLOUDFLARE_API_TOKEN"),
    });

    // What I want: an app. intentic derives a GitLab project, a single .gitlab-ci.yml (build → GitLab Container
    // Registry → notify Komodo, one job per environment), Komodo on the host rolling out the pushed image, and a
    // Cloudflare tunnel + DNS route. No Forgejo, no self-hosted runner, and no host SSH key ever leaves for GitLab.
    i.want.app("my-app", {
        on: host,
        expose: cf,
        environments: {
            production: { domain: "app.example.com", branch: "main" },
            staging: { domain: "staging.example.com", branch: "develop" },
        },
    });
});
