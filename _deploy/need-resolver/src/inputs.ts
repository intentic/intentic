import type { Input, Readiness, SecretRef } from "@intentic/graph";

// The author-supplied data shapes. They reference only protocol primitives, so the intent stays free of any
// dependency on the authoring handles.

// How image-pin bumps roll out on this host.
// - pinned (default): recreate the service on the new pin and health-gate; rollback is `git revert` + re-apply.
// - guarded: snapshot before update, health-gate, auto-rollback on failure; requires i.have.backup.
export type UpdatePolicy = "pinned" | "guarded";

// The host an app runs on: its SSH connection, authored inline. SSH port defaults to 22 when omitted.
export interface HostInput {
    address: string;
    user: string;
    sshKey: SecretRef;
    port?: number;
    updatePolicy?: UpdatePolicy;
    // How the sandbox reaches this host's SSH: "direct" (default) dials address:port, "cloudflared" tunnels through
    // the host's own Cloudflare SSH tunnel.
    via?: "direct" | "cloudflared";
}

// The Cloudflare account an app is exposed through. When `zone` is authored, resolve validates the domains
// against it without touching the API; absent, the zone is discovered from the token on each resolve.
export interface CloudflareInput {
    apiToken: SecretRef;
    zone?: string;
}

// A GitHub account the apps are sourced through: repos, CI, and container registry. `owner` defaults to the
// token's authenticated user when omitted.
export interface GitHubInput {
    token: SecretRef;
    owner?: string;
}

// A GitLab account the apps are sourced through: projects, CI, and the container registry. Self-hostable, so
// `url` selects the instance (default https://gitlab.com).
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

// The Discord bot token intentic uses to own the back-communication channel; the user supplies only the token.
// Absent = no Discord integration.
export interface DiscordInput {
    botToken: SecretRef;
}

// An external SaaS integration the apps use (e.g. Stripe). Only the API key is authored; intentic validates it
// during reconcile and injects it into consuming apps. Absent = no integration.
export interface StripeInput {
    apiKey: SecretRef;
}

// How long restic keeps snapshots before `forget --prune` drops them. Omitted fields fall back to the provider's
// defaults.
export interface BackupRetention {
    daily?: number;
    weekly?: number;
    monthly?: number;
}

// The backup destination the operator provides. `repo` is a restic repo URL; `credentials` are the backend's
// access keys keyed by the env var restic expects; `schedule` is a cron expression (default daily at 03:00).
export interface BackupInput {
    repo: string;
    password: SecretRef;
    credentials?: Record<string, SecretRef>;
    schedule?: string;
    retention?: BackupRetention;
    signoz?: boolean;
}

// An off-the-shelf shared service the host runs, deployed directly from a pinned image (unlike apps, which build
// from source). Catalog: SigNoz, Outline, Paperless-ngx, OpenProject, Invoice Ninja, Infisical.
export type ServiceKind = "signoz" | "outline" | "paperless" | "openproject" | "invoiceninja" | "infisical";

export interface ServiceInput {
    kind: ServiceKind;
    domain: string;
}

// A person who works on the apps: a real Forgejo git account + a Komodo UI user. The login password is
// intentic-generated (one per user, reused for both logins).
export interface UserInput {
    username: string;
    email: string;
}

// A team of users. Becomes a Forgejo organization + team, and grants members a single Komodo permission level on
// the team's attached apps. `members` are user ids (i.want.user).
export type ForgejoRole = "admin" | "write" | "read";
export type KomodoRole = "admin" | "execute" | "read";

export interface TeamInput {
    members: readonly string[];
    komodo: KomodoRole;
}

// An app's grant of a team at a Forgejo role. The first grant on an app owns its repo; the rest are added as
// collaborator teams at their role.
export interface AppTeamGrantInput {
    team: string;
    role: ForgejoRole;
}
