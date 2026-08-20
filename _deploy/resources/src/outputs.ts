import type { ResourceType } from "./resource-types.js";

// The single runtime authority for which outputs each resource type produces, keyed exhaustively by
// the closed ResourceType union (a missing type is a compile error). Values mirror the Ref<string>
// output props declared on the handle interfaces in @intentic/sdk; the core outputs test asserts
// the two never drift. The engine reads this to know which produced/observed values to expose as
// {$ref:"id.output"} targets, providers never declare their own outputs.
export const OUTPUTS: Readonly<Record<ResourceType, readonly string[]>> = Object.freeze({
    host: ["internalIp", "publicIp"],
    cloudflare: ["zoneId", "accountId"],
    // The Discord guild (server) + the webhook URL for the #reconcile channel. Per-app webhook URLs are
    // dynamic (one per app that wires notify: discord), declared as a prefix pattern "appWebhook:".
    discord: ["guildId", "reconcileWebhook", "appWebhook:"],
    // An external SaaS integration (e.g. Stripe). A pure sink in v1: the provider validates the API key on
    // read/apply but exposes no refs, the apiKey is injected into consuming apps as a $secret env, not a $ref.
    stripe: [],
    "cf-route": ["url"],
    tunnel: ["tunnelId", "cname"],
    forgejo: ["url", "internalUrl", "runnerToken", "gitToken", "packagesToken"],
    // Identity nodes are pure sinks: usernames/org names are authored or deterministic literals the resolver
    // passes around directly, so nothing refs an output off them (like ci/forgejo-notify/komodo-notify).
    "forgejo-user": [],
    "forgejo-org": [],
    "forgejo-team": [],
    repo: ["cloneUrl", "sshUrl"],
    "control-repo": ["cloneUrl", "sshUrl"],
    "forgejo-runner": [],
    komodo: ["url", "internalUrl"],
    // Komodo Periphery deployed on a worker host (outbound to Core), a pure side-effect like the runner.
    "komodo-periphery": [],
    // A worker host registered as a Komodo Server, exposes the server name the deployment provider targets.
    "komodo-server": ["serverName"],
    "komodo-user": [],
    ci: [],
    deployment: ["internalUrl", "url"],
    "forgejo-notify": [],
    "komodo-notify": [],
    signoz: ["url", "internalUrl", "otlpEndpoint"],
    // Self-hosted catalog services: one compose stack on the host + a Cloudflare route, like signoz but
    // without an ingest endpoint apps ref, so just the two URL outputs.
    outline: ["url", "internalUrl"],
    paperless: ["url", "internalUrl"],
    openproject: ["url", "internalUrl"],
    invoiceninja: ["url", "internalUrl"],
    infisical: ["url", "internalUrl"],
    // The per-host workspace sandbox: its host-internal daemon url, the daemon's /health url for readiness,
    // and the `<zone>` base its dev-server previews sit under.
    workspace: ["internalUrl", "healthUrl", "previewBase"],
    // A scheduled backup job, a pure sink (nothing refs an output off it), like ci/forgejo-runner.
    backup: [],
    // Backing instances: the host-internal coordinates a consuming app's binding node connects with. The
    // per-app credentials live on the binding node below, not here (apps never ref the instance directly).
    postgres: ["internalHost", "port"],
    valkey: ["internalHost", "port"],
    // Per-app binding nodes: the connection URL injected into the consuming app's deployments. Carries the
    // app-scoped credential (provider-generated, embedded in the URL), so it is a credentialed output sink.
    "postgres-database": ["url"],
    "valkey-namespace": ["url"],
    // Phase 2 backing vocabulary (Authentik auth + Garage object-storage). Declared here so the resolver/emit
    // and the OUTPUTS authority stay exhaustive; the providers + emit routing land in Phase 2.
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
