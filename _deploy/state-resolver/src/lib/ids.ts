// Single source of truth for every derived id and platform domain; the resolver and the core handle constructor
// (App.environments) both import these so ids can't drift. Platform ids are role-based and host-scoped;
// repo/deployment ids are app-scoped.

export const forgejoId = (hostId: string): string => `${hostId}-git`;
export const runnerId = (hostId: string): string => `${forgejoId(hostId)}-runner`;
export const komodoId = (hostId: string): string => `${hostId}-deploy`;
export const tunnelId = (hostId: string): string => `${hostId}-tunnel`;
// The scheduled restic backup job for a host, host-scoped (one backup destination per host).
export const backupId = (hostId: string): string => `${hostId}-backup`;
// The human-facing Cloudflare tunnel name (must be stable + unique within the account).
export const tunnelName = (hostId: string): string => `intentic-${hostId}`;
export const repoId = (appId: string): string => `${appId}-repo`;
// Forgejo identities are host-scoped, keyed off the user/team id; a team is a Forgejo org (named by the team id)
// with one team inside it.
export const forgejoUserId = (hostId: string, userId: string): string => `${forgejoId(hostId)}-user-${userId}`;
export const forgejoOrgId = (hostId: string, teamId: string): string => `${forgejoId(hostId)}-org-${teamId}`;
export const forgejoTeamId = (hostId: string, teamId: string): string => `${forgejoOrgId(hostId, teamId)}-team`;
// The Komodo UI account per declared user, host-scoped like the deploy orchestrator itself.
export const komodoUserId = (hostId: string, userId: string): string => `${komodoId(hostId)}-user-${userId}`;
// Forgejo org login a team maps to; the team id is already globally unique, so it doubles as the org name.
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
// Wildcard preview route; must be ordered last in the tunnel ingress since it overlaps every other hostname.
export const previewDomain = (zone: string): string => `*.${zone}`;
// Deterministic port per deployment, avoiding collisions; computable without the deployment node existing.
export const deploymentPort = (id: string): number => 20000 + [...id].reduce((acc, ch) => (acc * 31 + ch.charCodeAt(0)) % 10000, 7);
// Admin identity for Forgejo + Komodo; not "admin", Forgejo reserves that name (collides with /admin).
export const adminUsername = "intentic";
// Forgejo registry authority; uses the public git domain so it's reachable from every host through the tunnel.
export const registryAuthority = (zone: string): string => gitDomain(zone);

// Binding node id, app+instance scoped so bindings never collide across apps or instances.
export const bindingId = (appId: string, instanceId: string): string => `${appId}-uses-${instanceId}`;

// Postgres db/role name and Valkey ACL username for an app; the app id sanitized to a SQL-safe identifier (no
// hyphens/dots), stable so re-applies are idempotent.
export const dbName = (appId: string): string => appId.replace(/[^A-Za-z0-9]+/g, "_").toLowerCase();
export const cacheUser = (appId: string): string => appId.replace(/[^A-Za-z0-9]+/g, "_").toLowerCase();

// Authentik OIDC slug and Garage bucket name for an app; sanitized to a DNS/S3-style label (lowercase alnum +
// hyphens, no leading/trailing hyphen), unlike dbName/cacheUser's underscores.
export const appSlug = (appId: string): string =>
    appId
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, "-")
        .replace(/^-+|-+$/g, "");
export const bucketName = (appId: string): string => appSlug(appId);

// Deterministic port for a backing instance, disjoint from deploymentPort's 20000-29999 band.
export const backingPort = (instanceId: string): number => 40000 + [...instanceId].reduce((acc, ch) => (acc * 31 + ch.charCodeAt(0)) % 10000, 7);

// Env var key for a generated secret, uppercased with non-alnum collapsed to "_", like userPasswordKey.
export const secretKey = (prefix: string, id: string): string => `${prefix}_${id.replace(/[^A-Za-z0-9]/g, "_").toUpperCase()}`;

// gh-repo reuses repoId; gh-ci parallels ciId. Deployment is the shared Komodo type on every stack.
export const ghCiId = (appId: string, environment: string): string => `${deploymentId(appId, environment)}-gh-ci`;

// gl-repo reuses repoId; gl-ci is app-scoped (one .gitlab-ci.yml per app, not per environment).
export const glCiId = (appId: string): string => `${appId}-gl-ci`;

// GitLab registry authority: gitlab.com maps to registry.gitlab.com; else `registry.<host>`, overridable.
export const gitlabRegistry = (url: string, override?: string): string => {
    if (override !== undefined) {
        return override;
    }
    const host = url.replace(/^https?:\/\//, "").replace(/\/+$/, "");
    return host === "gitlab.com" ? "registry.gitlab.com" : `registry.${host}`;
};
