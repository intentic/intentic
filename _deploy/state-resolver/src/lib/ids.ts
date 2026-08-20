// The single source of truth for every derived id and platform domain. Both the resolver and the core
// handle constructor (App.environments) import these, so the ids they produce cannot drift. Platform
// ids are role-based and host-scoped (shared per host); repo/deployment ids are app-scoped.

export const forgejoId = (hostId: string): string => `${hostId}-git`;
export const runnerId = (hostId: string): string => `${forgejoId(hostId)}-runner`;
export const komodoId = (hostId: string): string => `${hostId}-deploy`;
export const tunnelId = (hostId: string): string => `${hostId}-tunnel`;
// The scheduled restic backup job for a host, host-scoped (one backup destination per host).
export const backupId = (hostId: string): string => `${hostId}-backup`;
// The human-facing Cloudflare tunnel name (must be stable + unique within the account).
export const tunnelName = (hostId: string): string => `intentic-${hostId}`;
export const repoId = (appId: string): string => `${appId}-repo`;
// Forgejo identities are host-scoped (one Forgejo per host), keyed off the author's user/team id. A team is a
// Forgejo org (named by the team id) with one team inside it.
export const forgejoUserId = (hostId: string, userId: string): string => `${forgejoId(hostId)}-user-${userId}`;
export const forgejoOrgId = (hostId: string, teamId: string): string => `${forgejoId(hostId)}-org-${teamId}`;
export const forgejoTeamId = (hostId: string, teamId: string): string => `${forgejoOrgId(hostId, teamId)}-team`;
// The Komodo UI account per declared user, host-scoped like the deploy orchestrator itself.
export const komodoUserId = (hostId: string, userId: string): string => `${komodoId(hostId)}-user-${userId}`;
// The Forgejo org login a team maps to (the repo + registry namespace for the apps it owns). The team id is
// already globally unique (the builder's claim()), and Forgejo org names must be unique per instance, so the
// team id IS the org name.
export const orgName = (teamId: string): string => teamId;
// The env var key for a user's intentic-generated login password (one per user, reused for Forgejo + Komodo).
export const userPasswordKey = (userId: string): string => `INTENTIC_USER_PASSWORD_${userId.replace(/[^A-Za-z0-9]/g, "_").toUpperCase()}`;
export const deploymentId = (appId: string, environment: string): string => `${appId}.${environment}`;
// The CI/CD wiring node per environment: a Forgejo Actions workflow + repo secrets, keyed off the deployment.
export const ciId = (appId: string, environment: string): string => `${deploymentId(appId, environment)}-ci`;
// CI/CD notification sinks, app-scoped: a Forgejo repo webhook and a Komodo alerter targeting Discord.
export const forgejoNotifyId = (appId: string): string => `${repoId(appId)}-notify`;
export const komodoNotifyId = (appId: string): string => `${appId}-notify`;
export const gitDomain = (zone: string): string => `git.${zone}`;
export const deployDomain = (zone: string): string => `deploy.${zone}`;
// The workspace sandbox's single-label wildcard preview route: every per-project preview hostname is
// `preview-<project>.<zone>` (`preview-<project>--<app>.<zone>` per app; sandboxes with a connect token append
// `-<sandboxId>`), one label deep so a free Cloudflare Universal SSL `*.<zone>` cert covers it. The wildcard
// flows through cf-route + the tunnel ingress, where it MUST be ordered last (it overlaps every other hostname
// on the zone).
export const previewDomain = (zone: string): string => `*.${zone}`;
// A deterministic host port per deployment so co-located environments don't collide. Resolver-owned so the
// tunnel's ingress (hostname -> http://<internalIp>:<port>) can be computed without depending on the
// deployment node, which is what lets the tunnel come up before the control plane uses it.
export const deploymentPort = (id: string): number => 20000 + [...id].reduce((acc, ch) => (acc * 31 + ch.charCodeAt(0)) % 10000, 7);
// The single admin identity for both Forgejo and the deploy orchestrator, also the repo owner namespace
// and the deploy orchestrator's git account. NOT "admin": Forgejo reserves that name (it collides with the /admin route), so
// `forgejo admin user create --username admin` fails.
export const adminUsername = "intentic";
// The Forgejo container registry authority. Uses the public git domain so the registry is reachable from
// ALL hosts (control-plane and workers alike) through the Cloudflare tunnel. CI pushes over HTTPS, all
// deploy orchestrator instances pull from the same URL. The port-less authority uses the default HTTPS port (443).
export const registryAuthority = (zone: string): string => gitDomain(zone);

// The per-app binding node id for an app consuming a backing instance: app-scoped + instance-scoped so an
// app binding two instances (or two apps binding one) never collide. The provider mints the app's isolated
// sub-resource (db+role / ACL user / OIDC client / bucket) on that instance under this id.
export const bindingId = (appId: string, instanceId: string): string => `${appId}-uses-${instanceId}`;

// The Postgres database + owning role an app gets on a database instance, and the Valkey ACL user it gets on
// a cache instance. The app id is the natural name; sanitized to a SQL-safe identifier (Postgres unquoted
// identifiers and Valkey ACL usernames disallow hyphens/dots). Stable per app so re-applies are idempotent.
export const dbName = (appId: string): string => appId.replace(/[^A-Za-z0-9]+/g, "_").toLowerCase();
export const cacheUser = (appId: string): string => appId.replace(/[^A-Za-z0-9]+/g, "_").toLowerCase();

// The Authentik OIDC application slug and the Garage bucket name an app gets on an auth / object-storage
// instance. Both require a DNS/S3-style label (lowercase alnum + hyphens, no leading/trailing hyphen), so the
// app id is sanitized to that shape, distinct from dbName/cacheUser, which use underscores for SQL/ACL names.
export const appSlug = (appId: string): string =>
    appId
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, "-")
        .replace(/^-+|-+$/g, "");
export const bucketName = (appId: string): string => appSlug(appId);

// A deterministic host port a backing instance publishes on (so co-located instances don't collide), in a
// band disjoint from deploymentPort's 20000-29999. Resolver-owned like deploymentPort, so a binding node can
// build the connection URL (host:port) without depending on the instance's runtime.
export const backingPort = (instanceId: string): number => 40000 + [...instanceId].reduce((acc, ch) => (acc * 31 + ch.charCodeAt(0)) % 10000, 7);

// The env var key for an intentic-generated secret derived from a resource id, uppercased + non-alnum
// collapsed to "_", matching userPasswordKey. Used for backing admin + per-app credential secret keys.
export const secretKey = (prefix: string, id: string): string => `${prefix}_${id.replace(/[^A-Za-z0-9]/g, "_").toUpperCase()}`;

// GitHub-path IDs. gh-repo reuses repoId (same shape, different provider); gh-ci parallels ciId. The
// deployment is the shared Komodo "deployment" type on every stack.
export const ghCiId = (appId: string, environment: string): string => `${deploymentId(appId, environment)}-gh-ci`;

// GitLab-path IDs. gl-repo reuses repoId. Unlike gh-ci, gl-ci is APP-scoped, one .gitlab-ci.yml holds
// every environment's job, so there is a single node per app.
export const glCiId = (appId: string): string => `${appId}-gl-ci`;

// The GitLab Container Registry authority for an instance. gitlab.com uses registry.gitlab.com; a self-hosted
// instance's registry is instance-configured, so `registry.<host>` is a best-effort default the GitLabInput
// `registry` field overrides.
export const gitlabRegistry = (url: string, override?: string): string => {
    if (override !== undefined) {
        return override;
    }
    const host = url.replace(/^https?:\/\//, "").replace(/\/+$/, "");
    return host === "gitlab.com" ? "registry.gitlab.com" : `registry.${host}`;
};
