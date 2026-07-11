import type { Move } from "@intentic/graph";
import type {
    AppTeamGrantInput,
    BackupInput,
    CloudflareInput,
    DiscordInput,
    EnvironmentInput,
    GitHubInput,
    GitLabInput,
    HostInput,
    ServiceInput,
    StripeInput,
    TeamInput,
    UserInput,
} from "./inputs.js";

// The intent the builder records and the resolver consumes — "what you have" + "what you want" as pure
// data. App `on`/`expose` are resource-id strings (not handles), so the intent stays serializable and
// depends on nothing from the authoring layer. Multiple hosts are supported; the control plane is derived
// (one Forgejo + Komodo shared across all hosts). There is a single Cloudflare account.

export interface HostIntent {
    readonly id: string;
    readonly input: HostInput;
}

export interface CloudflareIntent {
    readonly id: string;
    readonly input: CloudflareInput;
}

// The backup destination the operator declared (i.have.backup). A singleton — one restic repository
// protects the control-plane host's state.
export interface BackupIntent {
    readonly id: string;
    readonly input: BackupInput;
}

export interface GitHubIntent {
    readonly id: string;
    readonly input: GitHubInput;
}

export interface GitLabIntent {
    readonly id: string;
    readonly input: GitLabInput;
}

export interface DiscordIntent {
    readonly id: string;
    readonly input: DiscordInput;
}

// The external SaaS integration the operator declared (i.have.stripe). A singleton, like discord.
export interface StripeIntent {
    readonly id: string;
    readonly input: StripeInput;
}

export interface UserIntent {
    readonly id: string;
    readonly input: UserInput;
}

export interface TeamIntent {
    readonly id: string;
    readonly input: TeamInput;
}

// A backing capability an app consumes — the abstract name, mapped to its concrete provider by the catalog
// in @intentic/state-resolver (database -> Postgres, cache -> Valkey, auth -> Authentik, object-storage ->
// Garage). Declared with i.want.database / i.want.cache / i.want.auth / i.want.objectStorage.
export type BackingCapability = "database" | "cache" | "auth" | "object-storage";

// A backing instance the author wants: one shared service deployed onto a host (`on`) from a pinned image
// over SSH. Internal-only capabilities (database/cache) have no `expose`/`domain`; auth always routes and
// object-storage routes when a domain is given. Like AppIntent, `on`/`expose` are resource-id strings.
export interface BackingIntent {
    readonly id: string;
    readonly capability: BackingCapability;
    readonly on: string;
    readonly expose?: string;
    readonly domain?: string;
    // Prune protection for the data the instance holds. Defaults to true at resolve; author protect: false
    // to allow removal from config to delete the instance (and its volume).
    readonly protect?: boolean;
}

// One app -> backing binding. The resolver mints a per-app sub-resource (database+role / OIDC client /
// bucket+key / Valkey ACL user) on the target instance and injects its credential env vars into every
// deployment. `target` is a backing instance id; `capability` is recorded so emit can validate the kind.
export interface AppBindingInput {
    readonly capability: BackingCapability;
    readonly target: string;
}

export interface AppIntent {
    readonly id: string;
    readonly on: string;
    readonly expose: string;
    // The id of a discord resource (i.have.discord) this app's CI/CD alerts are posted to. The resolver
    // derives a forgejo-notify + komodo-notify wired to the discord provider's per-app webhook.
    readonly notify?: string;
    // The id of a service (i.want.service) this app sends telemetry to. The resolver injects that service's
    // OTLP endpoint into each deployment's env and depends the deployment on it. Absent = no telemetry.
    readonly observe?: string;
    // The backing capabilities this app uses (i.want.database / cache / auth / objectStorage). The resolver
    // emits a per-app binding node per entry and injects its connection env vars into every deployment.
    readonly use?: readonly AppBindingInput[];
    // The teams that manage this app, each at a Forgejo role. The first grant's team owns the repo; absent or
    // empty = admin-owned (the default single-admin behaviour). Resolver validates each team is declared.
    readonly teams?: readonly AppTeamGrantInput[];
    readonly environments: Readonly<Record<string, EnvironmentInput>>;
}

// A shared off-the-shelf service the author wants: a catalog `kind` deployed onto a host (`on`) and exposed
// through a Cloudflare account (`expose`). Like AppIntent, `on`/`expose` are resource-id strings.
export interface ServiceIntent extends ServiceInput {
    readonly id: string;
    readonly on: string;
    readonly expose: string;
}

// The per-host AI-agent workspace the author wants: a sandbox container that holds the project's dev workspace
// and fronts its live preview. Its public route is the wildcard `*.<zone>` derived from the discovered
// zone, so no domain is authored. Like AppIntent, `on`/`expose` are resource-id strings.
export interface WorkspaceIntent {
    readonly id: string;
    readonly on: string;
    readonly expose: string;
    // When set, the sandbox reads it as ANTHROPIC_BASE_URL so the agent uses a custom (e.g. local)
    // Anthropic-compatible endpoint. Absent ⇒ the agent talks to Anthropic's cloud.
    readonly agentBaseUrl?: string;
    // The ids of services (i.want.service) exposed to the in-sandbox agent as MCP tools. The resolver wires
    // each one's MCP endpoint URL + a generated scoped token into the workspace node. Absent ⇒ no tools.
    readonly tools?: readonly string[];
    // Owner-approved overlay Dockerfile content extending the sandbox image; the provider builds it on the
    // host and runs the sandbox from the result. Absent ⇒ the stock image.
    readonly dockerfile?: string;
}

// hosts/cloudflare may be empty so an app-less intent stays valid; the SDK's `on`/`expose` types guarantee
// at least one host and cloudflare are declared whenever an app or service is, and the resolver asserts the
// same before deriving.
export interface IntentSet {
    readonly hosts: readonly HostIntent[];
    readonly cloudflare?: CloudflareIntent;
    readonly github?: GitHubIntent;
    readonly gitlab?: GitLabIntent;
    readonly discord?: DiscordIntent;
    readonly stripe?: StripeIntent;
    readonly backup?: BackupIntent;
    readonly users: readonly UserIntent[];
    readonly teams: readonly TeamIntent[];
    readonly apps: readonly AppIntent[];
    readonly services: readonly ServiceIntent[];
    readonly workspaces: readonly WorkspaceIntent[];
    readonly backings: readonly BackingIntent[];
    // Node-id renames to reconcile in place before apply (authored via i.moved).
    readonly moved?: readonly Move[];
}
