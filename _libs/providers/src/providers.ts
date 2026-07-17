import type { Providers } from "@intentic/engine";
import { createAuthentikProvider } from "./auth/authentik.js";
import type { AuthentikApi } from "./auth/authentik-api.js";
import { authentikApi } from "./auth/authentik-api.js";
import { createAuthentikClientProvider } from "./auth/authentik-client.js";
import { createBackupProvider } from "./backup/backup.js";
import type { SshExecutor } from "./core/ssh.js";
import { sshExecutor } from "./core/ssh.js";
import { createGarageProvider } from "./backings/garage.js";
import { createGarageBucketProvider } from "./backings/garage-bucket.js";
import { createPostgresProvider } from "./backings/postgres.js";
import { createPostgresDatabaseProvider } from "./backings/postgres-database.js";
import { createValkeyProvider } from "./backings/valkey.js";
import { createValkeyNamespaceProvider } from "./backings/valkey-namespace.js";
import { createCiProvider } from "./forgejo/ci.js";
import { createForgejoProvider } from "./forgejo/forgejo.js";
import type { ForgejoApi } from "./forgejo/forgejo-api.js";
import { forgejoApi } from "./forgejo/forgejo-api.js";
import { createForgejoNotifyProvider } from "./forgejo/forgejo-notify.js";
import { createForgejoOrgProvider } from "./forgejo/forgejo-org.js";
import { createForgejoRunnerProvider } from "./forgejo/forgejo-runner.js";
import { createForgejoTeamProvider } from "./forgejo/forgejo-team.js";
import { createForgejoUserProvider } from "./forgejo/forgejo-user.js";
import { createRepoProvider } from "./forgejo/repo.js";
import { createGhCiProvider } from "./github/gh-ci.js";
import { createGhRepoProvider } from "./github/gh-repo.js";
import { createGitHubProvider } from "./github/github.js";
import type { GitHubApi } from "./github/github-api.js";
import { githubApi } from "./github/github-api.js";
import { createGlCiProvider } from "./gitlab/gl-ci.js";
import { createGlRepoProvider } from "./gitlab/gl-repo.js";
import { createGitLabProvider } from "./gitlab/gitlab.js";
import type { GitLabApi } from "./gitlab/gitlab-api.js";
import { gitlabApi } from "./gitlab/gitlab-api.js";
import { createHostProvider } from "./host/host.js";
import { createWorkspaceProvider } from "./host/workspace.js";
import { createDiscordProvider } from "./integrations/discord.js";
import type { DiscordApi } from "./integrations/discord-api.js";
import { discordApi } from "./integrations/discord-api.js";
import { createStripeProvider } from "./integrations/stripe.js";
import type { StripeApi } from "./integrations/stripe-api.js";
import { stripeApi } from "./integrations/stripe-api.js";
import { createDeploymentProvider } from "./komodo/deployment.js";
import { createKomodoProvider } from "./komodo/komodo.js";
import type { KomodoApi } from "./komodo/komodo-api.js";
import { komodoApi } from "./komodo/komodo-api.js";
import { createKomodoNotifyProvider } from "./komodo/komodo-notify.js";
import { createKomodoPeripheryProvider } from "./komodo/komodo-periphery.js";
import { createKomodoServerProvider } from "./komodo/komodo-server.js";
import { createKomodoUserProvider } from "./komodo/komodo-user.js";
import { createCfRouteProvider, type DnsPropagationWait } from "./network/cf-route.js";
import { createCloudflareProvider } from "./network/cloudflare.js";
import type { CloudflareApi } from "./network/cloudflare-api.js";
import { cloudflareApi } from "./network/cloudflare-api.js";
import { createTunnelProvider } from "./network/tunnel.js";
import { createSignozProvider } from "./observability/signoz.js";
import { createInfisicalProvider } from "./services/infisical.js";
import { createInvoiceninjaProvider } from "./services/invoiceninja.js";
import { createOpenprojectProvider } from "./services/openproject.js";
import { createOutlineProvider } from "./services/outline.js";
import { createPaperlessProvider } from "./services/paperless.js";

// The four side-effecting dependencies every provider is built over: SSH transport to the host and the
// three external HTTP surfaces. Each defaults to its real implementation; pass a fake to drive the whole
// suite in-memory (tests) or a real one to reconcile against live infra (the e2e harness, a future CLI).
export interface ProviderDeps {
    readonly ssh?: SshExecutor;
    readonly cloudflare?: CloudflareApi;
    readonly forgejo?: ForgejoApi;
    readonly komodo?: KomodoApi;
    readonly github?: GitHubApi;
    readonly gitlab?: GitLabApi;
    readonly discord?: DiscordApi;
    readonly stripe?: StripeApi;
    readonly authentik?: AuthentikApi;
    // The cf-route DNS-propagation wait; defaults to the real DoH probe. In-memory tests inject a no-op so
    // they never hit the network.
    readonly dnsPropagation?: DnsPropagationWait;
}

// Assemble the full ResourceType -> Provider map the engine reconciles against. This is the single seam
// between a compiled graph and execution: the engine never constructs providers, it is handed this map.
export const createProviders = (deps: ProviderDeps = {}): Providers => {
    const ssh = deps.ssh ?? sshExecutor;
    const cloudflare = deps.cloudflare ?? cloudflareApi;
    const forgejo = deps.forgejo ?? forgejoApi;
    const komodo = deps.komodo ?? komodoApi;
    const github = deps.github ?? githubApi;
    const gitlab = deps.gitlab ?? gitlabApi;
    const discord = deps.discord ?? discordApi;
    const stripe = deps.stripe ?? stripeApi;
    return {
        host: createHostProvider(ssh),
        cloudflare: createCloudflareProvider(cloudflare),
        "cf-route": createCfRouteProvider(cloudflare, deps.dnsPropagation),
        tunnel: createTunnelProvider(cloudflare, ssh),
        forgejo: createForgejoProvider(ssh),
        "forgejo-user": createForgejoUserProvider(forgejo),
        "forgejo-org": createForgejoOrgProvider(forgejo),
        "forgejo-team": createForgejoTeamProvider(forgejo),
        "forgejo-runner": createForgejoRunnerProvider(ssh),
        komodo: createKomodoProvider(ssh),
        "komodo-periphery": createKomodoPeripheryProvider(ssh),
        "komodo-server": createKomodoServerProvider(komodo),
        "komodo-user": createKomodoUserProvider(komodo),
        repo: createRepoProvider(forgejo),
        ci: createCiProvider(forgejo),
        deployment: createDeploymentProvider(komodo),
        "forgejo-notify": createForgejoNotifyProvider(forgejo),
        "komodo-notify": createKomodoNotifyProvider(komodo),
        signoz: createSignozProvider(ssh),
        outline: createOutlineProvider(ssh),
        paperless: createPaperlessProvider(ssh),
        openproject: createOpenprojectProvider(ssh),
        invoiceninja: createInvoiceninjaProvider(ssh),
        infisical: createInfisicalProvider(ssh),
        backup: createBackupProvider(ssh),
        postgres: createPostgresProvider(ssh),
        "postgres-database": createPostgresDatabaseProvider(ssh),
        valkey: createValkeyProvider(ssh),
        "valkey-namespace": createValkeyNamespaceProvider(ssh),
        authentik: createAuthentikProvider(ssh),
        "authentik-client": createAuthentikClientProvider(deps.authentik ?? authentikApi),
        garage: createGarageProvider(ssh),
        "garage-bucket": createGarageBucketProvider(ssh),
        github: createGitHubProvider(github),
        "gh-repo": createGhRepoProvider(github),
        "gh-ci": createGhCiProvider(github),
        gitlab: createGitLabProvider(gitlab),
        "gl-repo": createGlRepoProvider(gitlab),
        "gl-ci": createGlCiProvider(gitlab),
        discord: createDiscordProvider(discord),
        stripe: createStripeProvider(stripe),
        workspace: createWorkspaceProvider(ssh),
    };
};
