import type { ResourceType } from "./resource-types.js";

// Runtime authority for which outputs each resource type produces, keyed exhaustively over ResourceType (a missing
// type is a compile error). Mirrors the Ref<string> output props on the handle interfaces in @intentic/sdk; keep in
// sync.
export const OUTPUTS: Readonly<Record<ResourceType, readonly string[]>> = Object.freeze({
    host: ["internalIp", "publicIp"],
    cloudflare: ["zoneId", "accountId"],
    // Per-app webhook URLs are dynamic (one per app with notify: discord), declared as the prefix "appWebhook:".
    discord: ["guildId", "reconcileWebhook", "appWebhook:"],
    // Pure sink: apiKey reaches consuming apps as a $secret env, not a $ref; no outputs to expose.
    stripe: [],
    "cf-route": ["url"],
    tunnel: ["tunnelId", "cname"],
    forgejo: ["url", "internalUrl", "runnerToken", "gitToken", "packagesToken"],
    // Identity nodes are pure sinks; usernames/org names are literals the resolver passes around directly.
    "forgejo-user": [],
    "forgejo-org": [],
    "forgejo-team": [],
    repo: ["cloneUrl", "sshUrl"],
    "control-repo": ["cloneUrl", "sshUrl"],
    "forgejo-runner": [],
    komodo: ["url", "internalUrl"],
    // Komodo Periphery on a worker host (outbound to Core); pure side-effect, no outputs.
    "komodo-periphery": [],
    // Worker host registered as a Komodo Server; exposes the server name deployments target.
    "komodo-server": ["serverName"],
    "komodo-user": [],
    ci: [],
    deployment: ["internalUrl", "url"],
    "forgejo-notify": [],
    "komodo-notify": [],
    signoz: ["url", "internalUrl", "otlpEndpoint"],
    // Self-hosted catalog services: compose stack plus Cloudflare route; unlike signoz, no ingest endpoint output.
    outline: ["url", "internalUrl"],
    paperless: ["url", "internalUrl"],
    openproject: ["url", "internalUrl"],
    invoiceninja: ["url", "internalUrl"],
    infisical: ["url", "internalUrl"],
    // previewBase is the `<zone>` base dev-server previews sit under.
    workspace: ["internalUrl", "healthUrl", "previewBase"],
    // Pure sink; nothing refs an output off a backup job.
    backup: [],
    // Host-internal coordinates a binding node connects with; credentials live on the binding node, not here.
    postgres: ["internalHost", "port"],
    valkey: ["internalHost", "port"],
    // Connection URL injected into the app's deployment; embeds the app-scoped, provider-generated credential.
    "postgres-database": ["url"],
    "valkey-namespace": ["url"],
    // Authentik auth + Garage object-storage vocabulary; declared for exhaustiveness, providers land later.
    authentik: ["url", "issuerUrl", "internalUrl"],
    "authentik-client": ["issuer", "clientId", "clientSecret"],
    garage: ["internalEndpoint", "endpoint"],
    "garage-bucket": ["endpoint", "accessKey", "secretKey", "bucket"],
    // GitHub inventory node, resolves the PAT's owner (user or org).
    github: ["owner"],
    // GitHub repo, same output shape as the Forgejo "repo" type.
    "gh-repo": ["cloneUrl", "sshUrl"],
    // GitHub Actions workflow + repo secrets, a pure sink, like "ci".
    "gh-ci": [],
    // GitLab inventory node, resolves the PAT's owner (user or group).
    gitlab: ["owner"],
    // GitLab project, same output shape as the Forgejo "repo" type.
    "gl-repo": ["cloneUrl", "sshUrl"],
    // GitLab CI (.gitlab-ci.yml) + CI/CD variables, a pure sink, like "ci".
    "gl-ci": [],
});
