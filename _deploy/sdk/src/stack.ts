import type { Move } from "@intentic/graph";
import { makeRef } from "@intentic/graph";
import type {
    AppIntent,
    BackingCapability,
    BackingIntent,
    BackupInput,
    BackupIntent,
    CloudflareInput,
    CloudflareIntent,
    DiscordInput,
    DiscordIntent,
    EnvironmentInput,
    GitHubInput,
    GitHubIntent,
    GitLabInput,
    GitLabIntent,
    HostInput,
    HostIntent,
    IntentSet,
    ServiceIntent,
    StripeInput,
    StripeIntent,
    TeamIntent,
    UserInput,
    UserIntent,
    WorkspaceIntent,
} from "@intentic/need-resolver";
import { deploymentId, repoId } from "@intentic/state-resolver";
import type {
    App,
    Auth,
    Backup,
    Cache,
    Cloudflare,
    Database,
    Deployment,
    Discord,
    GitHub,
    GitLab,
    Host,
    ObjectStorage,
    Repo,
    Service,
    Stack,
    Stripe,
    Team,
    User,
    WantAppInput,
    WantServiceInput,
    WantTeamInput,
    WantWorkspaceInput,
    Workspace,
} from "./handles.js";

// The builder is a pure intent recorder: i.have.* / i.want.app record what was declared and hand back typed
// handles for wiring. No derivation happens here — that is the resolver's job. Multiple hosts are supported
// (one control plane is derived); there is a single Cloudflare account. The App handle's per-environment
// ids come from the same deploymentId() the resolver uses, so they cannot drift.
export const createStack = (): { stack: Stack; intent: IntentSet } => {
    const claimed = new Set<string>();
    const claim = (id: string): void => {
        if (claimed.has(id)) {
            throw new Error(`duplicate resource id: "${id}"`);
        }
        claimed.add(id);
    };

    const users: UserIntent[] = [];
    const teams: TeamIntent[] = [];
    const apps: AppIntent[] = [];
    const services: ServiceIntent[] = [];
    const workspaces: WorkspaceIntent[] = [];
    const backings: BackingIntent[] = [];
    const moved: Move[] = [];
    const hosts: HostIntent[] = [];
    // The capability of each declared backing, keyed by its id — so app() can map a `use` handle (an inert
    // ref carrying no runtime capability) back to its BackingCapability for the recorded AppBindingInput.
    const backingCapabilities = new Map<string, BackingCapability>();
    const intent: {
        hosts: HostIntent[];
        cloudflare?: CloudflareIntent;
        github?: GitHubIntent;
        gitlab?: GitLabIntent;
        discord?: DiscordIntent;
        stripe?: StripeIntent;
        backup?: BackupIntent;
        users: UserIntent[];
        teams: TeamIntent[];
        apps: AppIntent[];
        services: ServiceIntent[];
        workspaces: WorkspaceIntent[];
        backings: BackingIntent[];
        moved: Move[];
    } = { hosts, users, teams, apps, services, workspaces, backings, moved };

    const host = (id: string, input: HostInput): Host => {
        claim(id);
        hosts.push({ id, input });
        return Object.freeze({ ...makeRef(id), internalIp: makeRef<string>(id, "internalIp"), publicIp: makeRef<string>(id, "publicIp") }) as Host;
    };

    const cloudflare = (id: string, input: CloudflareInput): Cloudflare => {
        if (intent.cloudflare !== undefined) {
            throw new Error("a Cloudflare account is already declared; intentic supports a single Cloudflare account");
        }
        claim(id);
        intent.cloudflare = { id, input };
        return Object.freeze({ ...makeRef(id), zoneId: makeRef<string>(id, "zoneId"), accountId: makeRef<string>(id, "accountId") }) as Cloudflare;
    };

    const backup = (id: string, input: BackupInput): Backup => {
        if (intent.backup !== undefined) {
            throw new Error("a backup is already declared; intentic supports a single backup destination");
        }
        claim(id);
        intent.backup = { id, input };
        return Object.freeze(makeRef(id)) as Backup;
    };

    const github = (id: string, input: GitHubInput): GitHub => {
        if (intent.github !== undefined) {
            throw new Error("a GitHub account is already declared; intentic supports a single GitHub account");
        }
        claim(id);
        intent.github = { id, input };
        return Object.freeze({ ...makeRef(id), owner: makeRef<string>(id, "owner") }) as GitHub;
    };

    const gitlab = (id: string, input: GitLabInput): GitLab => {
        if (intent.gitlab !== undefined) {
            throw new Error("a GitLab account is already declared; intentic supports a single GitLab account");
        }
        claim(id);
        intent.gitlab = { id, input };
        return Object.freeze({ ...makeRef(id), owner: makeRef<string>(id, "owner") }) as GitLab;
    };

    const discord = (id: string, input: DiscordInput): Discord => {
        if (intent.discord !== undefined) {
            throw new Error("a Discord account is already declared; intentic supports a single Discord account");
        }
        claim(id);
        intent.discord = { id, input };
        return Object.freeze(makeRef(id)) as Discord;
    };

    const stripe = (id: string, input: StripeInput): Stripe => {
        if (intent.stripe !== undefined) {
            throw new Error("a Stripe integration is already declared; intentic supports a single Stripe account");
        }
        claim(id);
        intent.stripe = { id, input };
        return Object.freeze(makeRef(id)) as Stripe;
    };

    const app = <const E extends Record<string, EnvironmentInput>>(id: string, input: WantAppInput & { environments: E }): App<keyof E & string> => {
        claim(id);
        apps.push({
            id,
            on: input.on.resourceId,
            expose: input.expose.resourceId,
            ...(input.notify !== undefined ? { notify: input.notify.resourceId } : {}),
            ...(input.observe !== undefined ? { observe: input.observe.resourceId } : {}),
            ...(input.use !== undefined
                ? { use: input.use.map((handle) => ({ capability: capabilityOf(handle.resourceId), target: handle.resourceId })) }
                : {}),
            ...(input.teams !== undefined ? { teams: input.teams.map((grant) => ({ team: grant.team.resourceId, role: grant.role })) } : {}),
            environments: input.environments,
        });

        const environments: Record<string, Deployment> = {};
        for (const name of Object.keys(input.environments)) {
            const did = deploymentId(id, name);
            environments[name] = Object.freeze({
                ...makeRef(did),
                internalUrl: makeRef<string>(did, "internalUrl"),
                url: makeRef<string>(did, "url"),
            }) as Deployment;
        }

        const rid = repoId(id);
        const repo = Object.freeze({ ...makeRef(rid), cloneUrl: makeRef<string>(rid, "cloneUrl"), sshUrl: makeRef<string>(rid, "sshUrl") }) as Repo;
        return Object.freeze({ ...makeRef(id), repo, environments: Object.freeze(environments) }) as App<keyof E & string>;
    };

    const service = (id: string, input: WantServiceInput): Service => {
        claim(id);
        services.push({ id, kind: input.kind, on: input.on.resourceId, expose: input.expose.resourceId, domain: input.domain });
        return Object.freeze({
            ...makeRef(id),
            url: makeRef<string>(id, "url"),
            internalUrl: makeRef<string>(id, "internalUrl"),
            otlpEndpoint: makeRef<string>(id, "otlpEndpoint"),
        }) as Service;
    };

    const workspace = (id: string, input: WantWorkspaceInput): Workspace => {
        claim(id);
        workspaces.push({
            id,
            on: input.on.resourceId,
            expose: input.expose.resourceId,
            ...(input.agentBaseUrl !== undefined ? { agentBaseUrl: input.agentBaseUrl } : {}),
            ...(input.tools !== undefined ? { tools: input.tools.map((handle) => handle.resourceId) } : {}),
            ...(input.dockerfile !== undefined ? { dockerfile: input.dockerfile } : {}),
        });
        return Object.freeze({
            ...makeRef(id),
            internalUrl: makeRef<string>(id, "internalUrl"),
            healthUrl: makeRef<string>(id, "healthUrl"),
            previewBase: makeRef<string>(id, "previewBase"),
        }) as Workspace;
    };

    // The capability a `use` handle refers to, by its recorded backing id. Throws if the handle is not a
    // declared backing (a programming error — the type system already guarantees it is a Backing handle).
    const capabilityOf = (backingId: string): BackingCapability => {
        const capability = backingCapabilities.get(backingId);
        if (capability === undefined) {
            throw new Error(`app uses backing "${backingId}" that was not declared with i.want.database/cache/auth/objectStorage`);
        }
        return capability;
    };

    const database = (id: string, input: { on: Host; protect?: boolean }): Database => {
        claim(id);
        backings.push({ id, capability: "database", on: input.on.resourceId, ...(input.protect !== undefined ? { protect: input.protect } : {}) });
        backingCapabilities.set(id, "database");
        return Object.freeze({ ...makeRef(id), internalHost: makeRef<string>(id, "internalHost"), port: makeRef<string>(id, "port") }) as Database;
    };

    const cache = (id: string, input: { on: Host; protect?: boolean }): Cache => {
        claim(id);
        backings.push({ id, capability: "cache", on: input.on.resourceId, ...(input.protect !== undefined ? { protect: input.protect } : {}) });
        backingCapabilities.set(id, "cache");
        return Object.freeze({ ...makeRef(id), internalHost: makeRef<string>(id, "internalHost"), port: makeRef<string>(id, "port") }) as Cache;
    };

    const auth = (id: string, input: { on: Host; expose: Cloudflare; domain: string; protect?: boolean }): Auth => {
        claim(id);
        backings.push({
            id,
            capability: "auth",
            on: input.on.resourceId,
            expose: input.expose.resourceId,
            domain: input.domain,
            ...(input.protect !== undefined ? { protect: input.protect } : {}),
        });
        backingCapabilities.set(id, "auth");
        return Object.freeze({
            ...makeRef(id),
            url: makeRef<string>(id, "url"),
            issuerUrl: makeRef<string>(id, "issuerUrl"),
            internalUrl: makeRef<string>(id, "internalUrl"),
        }) as Auth;
    };

    const objectStorage = (id: string, input: { on: Host; expose?: Cloudflare; domain?: string; protect?: boolean }): ObjectStorage => {
        claim(id);
        backings.push({
            id,
            capability: "object-storage",
            on: input.on.resourceId,
            ...(input.expose !== undefined ? { expose: input.expose.resourceId } : {}),
            ...(input.domain !== undefined ? { domain: input.domain } : {}),
            ...(input.protect !== undefined ? { protect: input.protect } : {}),
        });
        backingCapabilities.set(id, "object-storage");
        return Object.freeze({
            ...makeRef(id),
            endpoint: makeRef<string>(id, "endpoint"),
            internalEndpoint: makeRef<string>(id, "internalEndpoint"),
        }) as ObjectStorage;
    };

    const user = (id: string, input: UserInput): User => {
        claim(id);
        users.push({ id, input });
        return Object.freeze(makeRef(id)) as User;
    };

    const team = (id: string, input: WantTeamInput): Team => {
        claim(id);
        teams.push({ id, input: { members: input.members.map((member) => member.resourceId), komodo: input.komodo } });
        return Object.freeze(makeRef(id)) as Team;
    };

    const recordMove = (from: string, to: string): void => {
        moved.push({ from, to });
    };

    const stack: Stack = {
        have: { host, cloudflare, github, gitlab, backup, discord, stripe },
        want: { app, service, workspace, database, cache, auth, objectStorage, user, team },
        moved: recordMove,
    };
    return { stack, intent };
};
