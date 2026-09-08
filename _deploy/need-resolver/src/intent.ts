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

// The intent the builder records and the resolver consumes: "what you have" + "what you want" as pure data. App
// `on`/`expose` are resource-id strings, not handles, so the intent stays serializable.

export interface HostIntent {
    readonly id: string;
    readonly input: HostInput;
}

export interface CloudflareIntent {
    readonly id: string;
    readonly input: CloudflareInput;
}

// The backup destination the operator declared (i.have.backup); a singleton.
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

// The external SaaS integration the operator declared (i.have.stripe); a singleton, like discord.
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

// A backing capability an app consumes, mapped to its concrete provider by the catalog in
// @intentic/state-resolver. Declared with i.want.database / i.want.cache / i.want.auth / i.want.objectStorage.
export type BackingCapability = "database" | "cache" | "auth" | "object-storage";

// A backing instance the author wants: one shared service deployed onto a host (`on`) over SSH. Internal-only
// capabilities (database/cache) have no `expose`/`domain`.
export interface BackingIntent {
    readonly id: string;
    readonly capability: BackingCapability;
    readonly on: string;
    readonly expose?: string;
    readonly domain?: string;
    // Prune protection for the instance's data. Defaults to true at resolve; author protect: false to allow removal.
    readonly protect?: boolean;
}

// One app -> backing binding. The resolver mints a per-app sub-resource on the target instance and injects its
// credential env vars into every deployment.
export interface AppBindingInput {
    readonly capability: BackingCapability;
    readonly target: string;
}

export interface AppIntent {
    readonly id: string;
    readonly on: string;
    readonly expose: string;
    // The id of a discord resource this app's CI/CD alerts are posted to.
    readonly notify?: string;
    // The id of a service this app sends telemetry to; the resolver injects its OTLP endpoint. Absent = no telemetry.
    readonly observe?: string;
    // The backing capabilities this app uses. The resolver emits a per-app binding node per entry.
    readonly use?: readonly AppBindingInput[];
    // The teams that manage this app, each at a Forgejo role. The first grant's team owns the repo; absent or empty
    // = admin-owned.
    readonly teams?: readonly AppTeamGrantInput[];
    readonly environments: Readonly<Record<string, EnvironmentInput>>;
}

// A shared off-the-shelf service the author wants: a catalog `kind` deployed onto a host and exposed through a
// Cloudflare account.
export interface ServiceIntent extends ServiceInput {
    readonly id: string;
    readonly on: string;
    readonly expose: string;
}

// The per-host AI-agent workspace the author wants: a sandbox container holding the project's dev workspace and
// fronting its live preview. Its public route is the wildcard `*.<zone>` of the discovered zone.
export interface WorkspaceIntent {
    readonly id: string;
    readonly on: string;
    readonly expose: string;
    // When set, the sandbox reads it as ANTHROPIC_BASE_URL to use a custom Anthropic-compatible endpoint.
    readonly agentBaseUrl?: string;
    // The ids of services exposed to the in-sandbox agent as MCP tools; the resolver wires each one's endpoint URL +
    // a generated scoped token into the workspace node.
    readonly tools?: readonly string[];
    // Owner-approved overlay Dockerfile content extending the sandbox image; the provider builds it on the host and
    // runs the sandbox from the result.
    readonly dockerfile?: string;
}

// hosts/cloudflare may be empty so an app-less intent stays valid; the SDK guarantees at least one host and
// cloudflare are declared whenever an app or service is.
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
