import type { Input, Readiness, SecretRef } from "@intentic/graph";

// The author-supplied data shapes. They reference only protocol primitives so the intent that carries
// them stays free of any dependency on the authoring handles.

// How image-pin bumps roll out on this host. "pinned" (default): recreate the service on the new pin and
// health-gate (Phase-1 behavior); rollback is `git revert` + re-apply. "guarded": wrap each stateful
// service's bump in a transaction, pre-update restic snapshot, recreate, health-gate, and auto-rollback
// (old image + restored data) on failure. "guarded" requires i.have.backup (it reuses its restic repo).
export type UpdatePolicy = "pinned" | "guarded";

// The host an app runs on: its SSH connection, authored inline. address/user are literals; the private
// key is a secret. SSH port defaults to 22 when omitted.
export interface HostInput {
    address: string;
    user: string;
    sshKey: SecretRef;
    port?: number;
    updatePolicy?: UpdatePolicy;
    // How the sandbox reaches this host's SSH: "direct" (default) dials address:port; "cloudflared" tunnels
    // through the host's own Cloudflare SSH tunnel, for a NAT'd self-host the sandbox can't reach by IP.
    via?: "direct" | "cloudflared";
}

// The Cloudflare account an app is exposed through. `zone` is authored at connect time (the token is used
// once to list zones so the user picks one); when present, resolve validates the authored domains against it
// without touching the API. Absent, the zone is discovered from the token on each resolve. The owning account
// is resolved from the zone either way, so it is never declared here.
export interface CloudflareInput {
    apiToken: SecretRef;
    zone?: string;
}

// A GitHub account the apps are sourced through: repos, CI (GitHub Actions), and container registry (GHCR).
// The PAT authenticates every API call; `owner` defaults to the token's authenticated user when omitted.
export interface GitHubInput {
    token: SecretRef;
    owner?: string;
}

// A GitLab account the apps are sourced through: projects, CI (.gitlab-ci.yml), and the GitLab Container
// Registry. Self-hostable, so `url` selects the instance (default https://gitlab.com). The PAT authenticates
// every API call; `owner` (user or group path) defaults to the token's authenticated user when omitted;
// `registry` overrides the derived container-registry authority for self-hosted instances.
export interface GitLabInput {
    token: SecretRef;
    url?: string;
    owner?: string;
    registry?: string;
}

export interface EnvironmentInput {
    domain: string;
    branch: string;
    env?: Record<string, Input<string>>;
    readyWhen?: Readiness;
}

// The Discord bot token intentic uses to own the back-communication channel. intentic creates and
// manages the guild, categories, channels, and webhooks; the user supplies only the bot token.
// Absent = no Discord integration (no CI/CD notifications, no reconcile summaries).
export interface DiscordInput {
    botToken: SecretRef;
}

// An external SaaS integration the apps use (e.g. Stripe). Only the API key is authored (a secret); intentic
// validates it during reconcile and injects it into consuming apps' deployments. Absent = no integration.
export interface StripeInput {
    apiKey: SecretRef;
}

// How long restic keeps snapshots before `forget --prune` drops them. Omitted fields fall back to the
// provider's defaults (7 daily / 4 weekly / 6 monthly).
export interface BackupRetention {
    daily?: number;
    weekly?: number;
    monthly?: number;
}

// The backup destination the operator provides: a restic repository plus the secrets to reach + decrypt it.
// `repo` is a restic repo URL (s3:…, b2:…, sftp:…, rest:…). `password` is the restic encryption password.
// `credentials` are the backend's access keys (e.g. AWS_ACCESS_KEY_ID/AWS_SECRET_ACCESS_KEY, B2_ACCOUNT_ID/…),
// keyed by the env var restic expects. `schedule` is a cron expression (default daily at 03:00). `signoz`
// opts the (large, reconstructable) observability volumes into the backup set; off by default.
export interface BackupInput {
    repo: string;
    password: SecretRef;
    credentials?: Record<string, SecretRef>;
    schedule?: string;
    retention?: BackupRetention;
    signoz?: boolean;
}

// An off-the-shelf shared service the host runs, named by `kind` from the service catalog. Unlike apps
// (built from source through the platform), a service is deployed directly onto the host from a pinned
// image and exposed at its own `domain`. Catalog: SigNoz (observability), Outline (wiki), Paperless-ngx
// (documents), OpenProject (project management), Invoice Ninja (invoicing), Infisical (secrets management).
export type ServiceKind = "signoz" | "outline" | "paperless" | "openproject" | "invoiceninja" | "infisical";

export interface ServiceInput {
    kind: ServiceKind;
    domain: string;
}

// A person who works on the apps: a real Forgejo git account + a Komodo UI user. The login password is
// intentic-generated (one per user, reused for both logins), so it is not authored here.
export interface UserInput {
    username: string;
    email: string;
}

// A team of users. Becomes a Forgejo organization (named by the team id) + a team inside it, and grants its
// members a single Komodo permission level on the deployments of the apps the team is attached to. `members`
// are user ids (i.want.user); the intent stays a serializable id graph, like AppIntent.on/expose.
export type ForgejoRole = "admin" | "write" | "read";
export type KomodoRole = "admin" | "execute" | "read";

export interface TeamInput {
    members: readonly string[];
    komodo: KomodoRole;
}

// An app's grant of a team at a Forgejo role. `team` is a team id. The first grant on an app owns its repo
// (its org is the repo + registry namespace); the rest are added as collaborator teams at their role.
export interface AppTeamGrantInput {
    team: string;
    role: ForgejoRole;
}
