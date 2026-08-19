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

// The authoring surface. A developer declares the inventory they have — i.have.host / i.have.cloudflare —
// and what they want — i.want.app (built from source) and i.want.service (an off-the-shelf shared tool).
// The have/want split is lifecycle ownership, not requirements: intentic reads a have but never creates or
// destroys it (`intentic deploy destroy` leaves it untouched), while a want it owns end-to-end — created,
// reconciled, pruned, destroyed. Requirements are input fields (`on`/`expose`/`use`/`observe`/`notify`)
// and may point at haves and wants alike.
// The support stack each app requires (git+CI, deploy orchestrator, runner, tunnel, routes) is derived by
// the resolver, never declared here. These handles are the inert refs i.have.* / i.want.* hand back, which
// i.want.app wires `on`/`expose`/`observe` with.

// --- Inventory handles; their output properties are inert refs ---

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

// --- The app, its source repo, and its environments ---

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

// --- People and teams (i.want.user / i.want.team). Identity handles: bare refs with no output props —
// nothing references an output off them (usernames and org names are authored or deterministic literals the
// resolver passes around directly), they exist only to be wired into teams and app grants. ---

export type User = Ref<"forgejo-user">;
export type Team = Ref<"forgejo-team">;

// The backup destination (i.have.backup). A bare ref like User/Team — nothing references an output off it;
// it exists only to record that backups are wanted and where they go.
export type Backup = Ref<"backup">;

// The Discord back-communication channel (i.have.discord). A bare ref — the provider owns the guild/channels
// structure; the resolver references its webhook outputs to wire notifications.
export type Discord = Ref<"discord">;

// An external SaaS integration (i.have.stripe). A bare ref — the provider validates the API key during
// reconcile; the key is injected into consuming apps as a $secret env, so nothing references an output off it.
export type Stripe = Ref<"stripe">;

// A team's members are User handles; its Komodo role applies to the deployments of the apps it manages.
export interface WantTeamInput {
    members: readonly User[];
    komodo: KomodoRole;
}

// An app's grant of a team at a Forgejo role. The first grant on an app owns its repo.
export interface AppTeamGrant {
    team: Team;
    role: ForgejoRole;
}

// --- A shared off-the-shelf service (i.want.service); its output refs are inert, like inventory handles ---

export interface Service extends Ref<"signoz" | "outline" | "paperless" | "openproject" | "invoiceninja" | "infisical"> {
    readonly url: Ref<string>;
    readonly internalUrl: Ref<string>;
    // The host-internal OTLP endpoint apps send telemetry to; an app wires it via WantAppInput.observe.
    // Only signoz produces it — the emit-time observe guard rejects observing any other kind.
    readonly otlpEndpoint: Ref<string>;
}

// --- The per-host AI-agent workspace sandbox (i.want.workspace); its output refs are inert. Unlike a service
// it takes no domain — its route is the wildcard `*.<zone>` derived from the discovered zone. ---

export interface Workspace extends Ref<"workspace"> {
    // The sandbox's host-internal daemon url, the daemon's /health url, and the `<zone>` base its
    // preview-<repo>*.<zone> dev-server previews sit under.
    readonly internalUrl: Ref<string>;
    readonly healthUrl: Ref<string>;
    readonly previewBase: Ref<string>;
}

// --- Backing capabilities (i.want.database / cache / auth / objectStorage). Each is a shared instance an
// app consumes via WantAppInput.use; the resolver mints per-app credentials and injects the connection env
// vars. The output refs here are the INSTANCE coordinates (what the per-app binding node connects with), not
// the app's credentials — those live on the binding node the resolver emits. ---

// A database capability, provided by Postgres. Internal-only. Apps that `use` it get a DATABASE_URL injected.
export interface Database extends Ref<"postgres"> {
    readonly internalHost: Ref<string>;
    readonly port: Ref<string>;
}

// A cache capability, provided by Valkey. Internal-only. Apps that `use` it get VALKEY_URL + REDIS_URL.
export interface Cache extends Ref<"valkey"> {
    readonly internalHost: Ref<string>;
    readonly port: Ref<string>;
}

// An auth capability, provided by Authentik (an OIDC identity provider). Always routed (the issuer is a public
// HTTPS URL). Apps that `use` it get a per-app OIDC client: OIDC_ISSUER + OIDC_CLIENT_ID + OIDC_CLIENT_SECRET.
export interface Auth extends Ref<"authentik"> {
    readonly url: Ref<string>;
    readonly issuerUrl: Ref<string>;
    readonly internalUrl: Ref<string>;
}

// An object-storage capability, provided by Garage (S3-compatible). Internal by default; routed when given a
// domain. Apps that `use` it get a per-app bucket + key: S3_ENDPOINT + S3_ACCESS_KEY + S3_SECRET_KEY + S3_BUCKET.
export interface ObjectStorage extends Ref<"garage"> {
    readonly endpoint: Ref<string>;
    readonly internalEndpoint: Ref<string>;
}

// A backing capability handle an app can consume. The discriminating Ref tag (postgres/valkey/authentik/
// garage) lets the builder map a `use` entry back to its BackingCapability.
export type Backing = Database | Cache | Auth | ObjectStorage;

// --- Intent input. "Wants require haves" is enforced structurally: on: Host, expose: Cloudflare. ---

export interface WantAppInput {
    on: Host;
    expose: Cloudflare;
    // The Discord channel this app's CI/CD alerts are posted to; wired like expose/observe.
    notify?: Discord;
    // A service to send this app's telemetry to; the resolver injects its OTLP endpoint into each deployment.
    observe?: Service;
    // The backing capabilities this app consumes. For each, the resolver mints a per-app sub-resource on the
    // instance and injects its connection env vars (DATABASE_URL, VALKEY_URL/REDIS_URL, …) into every
    // deployment, spread BEFORE the author's own env so an explicit override still wins.
    use?: readonly Backing[];
    // The teams that manage this app, each at a Forgejo role. The first grant's team owns the repo (its org is
    // the repo + registry namespace); omitted/empty falls back to the single admin owner.
    teams?: readonly AppTeamGrant[];
    environments: Record<string, EnvironmentInput>;
}

export interface WantServiceInput extends ServiceInput {
    on: Host;
    expose: Cloudflare;
}

// The workspace sandbox takes its host + Cloudflare account; its `*.<zone>` route to the sandbox's dev
// server is derived from the zone. It is preview-only on the server — the browser-direct path is connect.sh.
export interface WantWorkspaceInput {
    on: Host;
    expose: Cloudflare;
    // Optional Anthropic-compatible base URL for the in-sandbox agent (set as ANTHROPIC_BASE_URL on the
    // sandbox container). Point it at a local gateway (e.g. LiteLLM/Ollama) to run the agent against a local
    // model; absent ⇒ the agent talks to Anthropic's cloud.
    agentBaseUrl?: string;
    // Provisioned internal services (i.want.service) to expose to the in-sandbox agent as MCP tools. Each is
    // reached as a remote MCP endpoint at its routed domain, authenticated with an intentic-generated scoped
    // token; the resolver wires the URL + token into the workspace node. The service's kind must expose an MCP
    // endpoint in the catalog (e.g. signoz). Wire a provisioned tool exactly like an app wires `observe`.
    tools?: readonly Service[];
    // Content of an owner-approved overlay Dockerfile (FROM the official sandbox image) extending the sandbox's
    // environment — typically readFileSync of .intentic/local/environment.approved.Dockerfile. The provider builds it
    // on the host and recreates the sandbox from the result. Absent ⇒ the stock image.
    dockerfile?: string;
}

// Inventory you bring. intentic reads it and never creates or destroys it — `intentic deploy destroy` does not touch it.
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
    // `const` so environment names come from the object keys, e.g. App<"staging" | "production">.
    app<const E extends Record<string, EnvironmentInput>>(id: string, input: WantAppInput & { environments: E }): App<keyof E & string>;
    service(id: string, input: WantServiceInput): Service;
    // The per-host AI-agent workspace sandbox: holds the project's dev workspace + serves its preview at
    // `*.<zone>` (previews are preview-<repo>*.<zone>). Takes only on/expose — the wildcard route derives from the zone.
    workspace(id: string, input: WantWorkspaceInput): Workspace;
    // Backing capabilities. database/cache are internal-only, so they need only the host they run on; the
    // catalog maps each to its concrete provider (Postgres / Valkey). auth always routes (the OIDC issuer is
    // public), so it requires expose + domain; objectStorage routes only when a domain is given.
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
    // Record a node-id rename: the resource that was `from` is now `to`. Before the next apply, intentic
    // re-stamps the live resource in place (e.g. migrating a database's volume) instead of destroying the old
    // and creating the new. Author it alongside the rename and remove it once applied. `to` must be the new id
    // in the config; `from` must no longer be declared.
    moved(from: string, to: string): void;
}
