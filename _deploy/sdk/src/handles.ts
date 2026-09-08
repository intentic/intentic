import type { Ref } from "@intentic/graph";
import type {
    BackupInput,
    CloudflareInput,
    DiscordInput,
    EnvironmentInput,
    ForgejoRole,
    GitHubInput,
    GitLabInput,
    HostInput,
    KomodoRole,
    ServiceInput,
    StripeInput,
    UserInput,
} from "@intentic/need-resolver";

// Authoring surface: i.have.* is inventory intentic reads but never creates or destroys; i.want.* is desired state
// owned end-to-end (created, reconciled, pruned, destroyed). Requirement fields (on/expose/use/observe/notify) point
// at either; these interfaces are the inert refs handed back.

// Inventory handles; output properties are inert refs.

export interface Host extends Ref<"host"> {
    readonly internalIp: Ref<string>;
    readonly publicIp: Ref<string>;
}

export interface Cloudflare extends Ref<"cloudflare"> {
    readonly zoneId: Ref<string>;
    readonly accountId: Ref<string>;
}

export interface GitHub extends Ref<"github"> {
    readonly owner: Ref<string>;
}

export interface GitLab extends Ref<"gitlab"> {
    readonly owner: Ref<string>;
}

// The app, its source repo, and its environments.

export interface Repo extends Ref<"repo"> {
    readonly cloneUrl: Ref<string>;
    readonly sshUrl: Ref<string>;
}

export interface Deployment extends Ref<"deployment"> {
    readonly internalUrl: Ref<string>;
    readonly url: Ref<string>;
}

export interface App<Names extends string = string> extends Ref<"app"> {
    readonly repo: Repo;
    readonly environments: Readonly<Record<Names, Deployment>>;
}

// People and teams (i.want.user / i.want.team): bare refs with no output props; usernames and org names are literals
// the resolver passes around directly.

export type User = Ref<"forgejo-user">;
export type Team = Ref<"forgejo-team">;

// Backup destination (i.have.backup); bare ref, nothing references an output off it.
export type Backup = Ref<"backup">;

// Discord channel (i.have.discord); bare ref, but the resolver reads its webhook outputs to wire notifications.
export type Discord = Ref<"discord">;

// Stripe integration (i.have.stripe); bare ref, apiKey injects into consuming apps as $secret env, not a ref.
export type Stripe = Ref<"stripe">;

// Team members are User handles; the Komodo role applies to the deployments of apps it manages.
export interface WantTeamInput {
    members: readonly User[];
    komodo: KomodoRole;
}

// A team grant at a Forgejo role; the first grant on an app owns its repo.
export interface AppTeamGrant {
    team: Team;
    role: ForgejoRole;
}

// Shared off-the-shelf service (i.want.service); output refs are inert, like inventory handles.

export interface Service extends Ref<"signoz" | "outline" | "paperless" | "openproject" | "invoiceninja" | "infisical"> {
    readonly url: Ref<string>;
    readonly internalUrl: Ref<string>;
    // OTLP endpoint apps send telemetry to; only signoz produces it, the observe guard rejects other kinds.
    readonly otlpEndpoint: Ref<string>;
}

// Per-host AI-agent workspace sandbox (i.want.workspace); unlike a service it takes no domain, routed at the
// wildcard `*.<zone>`.

export interface Workspace extends Ref<"workspace"> {
    // previewBase is the `<zone>` base for preview-<repo>*.<zone> dev-server previews.
    readonly internalUrl: Ref<string>;
    readonly healthUrl: Ref<string>;
    readonly previewBase: Ref<string>;
}

// Backing capabilities (i.want.database/cache/auth/objectStorage): a shared instance apps consume via
// WantAppInput.use. Output refs here are instance coordinates only; per-app credentials live on the binding node.

// Database capability (Postgres), internal-only; apps that `use` it get a DATABASE_URL injected.
export interface Database extends Ref<"postgres"> {
    readonly internalHost: Ref<string>;
    readonly port: Ref<string>;
}

// Cache capability (Valkey), internal-only; apps that `use` it get VALKEY_URL + REDIS_URL.
export interface Cache extends Ref<"valkey"> {
    readonly internalHost: Ref<string>;
    readonly port: Ref<string>;
}

// Auth capability (Authentik OIDC), always routed since the issuer is a public HTTPS URL. Apps that `use` it get
// a per-app OIDC_ISSUER + OIDC_CLIENT_ID + OIDC_CLIENT_SECRET.
export interface Auth extends Ref<"authentik"> {
    readonly url: Ref<string>;
    readonly issuerUrl: Ref<string>;
    readonly internalUrl: Ref<string>;
}

// Object-storage capability (Garage, S3-compatible); internal by default, routed when given a domain. Apps that
// `use` it get S3_ENDPOINT + S3_ACCESS_KEY + S3_SECRET_KEY + S3_BUCKET.
export interface ObjectStorage extends Ref<"garage"> {
    readonly endpoint: Ref<string>;
    readonly internalEndpoint: Ref<string>;
}

// Backing capability handle; the Ref tag (postgres/valkey/authentik/garage) maps a `use` entry back to its capability.
export type Backing = Database | Cache | Auth | ObjectStorage;

// Intent input; "wants require haves" is enforced structurally via on: Host, expose: Cloudflare.

export interface WantAppInput {
    on: Host;
    expose: Cloudflare;
    // Discord channel this app's CI/CD alerts post to; wired like expose/observe.
    notify?: Discord;
    // Service to send this app's telemetry to; the resolver injects its OTLP endpoint into each deployment.
    observe?: Service;
    // Backing capabilities to consume; injected env vars spread before the author's own, so overrides win.
    use?: readonly Backing[];
    // Teams managing this app; the first grant's team owns the repo (its org), else falls back to the admin owner.
    teams?: readonly AppTeamGrant[];
    environments: Record<string, EnvironmentInput>;
}

export interface WantServiceInput extends ServiceInput {
    on: Host;
    expose: Cloudflare;
}

// Workspace sandbox takes host + Cloudflare account; its `*.<zone>` route to the dev server derives from the zone.
// Preview-only on the server; the browser-direct path is connect.sh.
export interface WantWorkspaceInput {
    on: Host;
    expose: Cloudflare;
    // Base URL set as ANTHROPIC_BASE_URL on the sandbox container; absent means Anthropic's cloud.
    agentBaseUrl?: string;
    // Services exposed to the agent as MCP tools; the service kind must expose an MCP endpoint in the catalog.
    tools?: readonly Service[];
    // Overlay Dockerfile (FROM the sandbox image); provider builds and recreates the sandbox. Absent ⇒ stock image.
    dockerfile?: string;
}

// Inventory you bring; intentic reads it but never creates or destroys it (`intentic deploy destroy` leaves it
// untouched).
export interface Have {
    host(id: string, input: HostInput): Host;
    cloudflare(id: string, input: CloudflareInput): Cloudflare;
    github(id: string, input: GitHubInput): GitHub;
    gitlab(id: string, input: GitLabInput): GitLab;
    backup(id: string, input: BackupInput): Backup;
    discord(id: string, input: DiscordInput): Discord;
    stripe(id: string, input: StripeInput): Stripe;
}

// Desired state intentic owns end-to-end: created, reconciled, pruned, destroyed.
export interface Want {
    // `const` infers environment names straight from the object's keys.
    app<const E extends Record<string, EnvironmentInput>>(id: string, input: WantAppInput & { environments: E }): App<keyof E & string>;
    service(id: string, input: WantServiceInput): Service;
    // Per-host AI-agent workspace; preview served at `*.<zone>` (preview-<repo>*.<zone>), derived from the zone.
    workspace(id: string, input: WantWorkspaceInput): Workspace;
    // Backing capabilities: database/cache are internal-only (host only); auth always routes (OIDC issuer is public,
    // needs expose+domain); objectStorage routes only when given a domain.
    database(id: string, input: { on: Host }): Database;
    cache(id: string, input: { on: Host }): Cache;
    auth(id: string, input: { on: Host; expose: Cloudflare; domain: string }): Auth;
    objectStorage(id: string, input: { on: Host; expose?: Cloudflare; domain?: string }): ObjectStorage;
    user(id: string, input: UserInput): User;
    team(id: string, input: WantTeamInput): Team;
}

export interface Stack {
    readonly have: Have;
    readonly want: Want;
    // Records a node-id rename (from -> to); intentic re-stamps the live resource in place instead of destroying and
    // recreating it. `to` must be declared, `from` must not; remove once applied.
    moved(from: string, to: string): void;
}
