import type { SandboxSummary } from "@intentic/api-contract";
import {
    REACH_DEVICE_ACTING_GRANTS,
    REACH_DEVICE_GRANTS,
    reachHostOf,
    type ReachDevice,
    type ReachLinkIn,
    type ReachLinkOut,
    type ReachLinkTerms,
    type SandboxReach,
} from "@intentic/sandbox-contract/schemas/sandbox-reach";
import type { MemberTier } from "@intentic/sandbox-contract/schemas/shared";

// THE ACCOUNT'S ACCESS AS ONE GRAPH. The platform says which sandboxes the account is in and at what tier; each of those
// sandboxes says, for this reader, what it is tied to outside itself (GET /system/reach). This joins the answers by the
// ids they share (a sandbox's platform id or address, a computer's machine id or host name, a server's host name) into
// one set of nodes and edges, then names what deserves reading first: a computer, a server, another sandbox or the
// account itself that other people's agents can act on.
//
// Pure and language-free, like the sandbox map's model (features/sandbox/map/reachModel.ts): the composable gathers the
// reads, the views word it. A sandbox the editor could not read this time keeps its last answer, marked by how it
// stands now, since access changes: what an owner narrowed yesterday is drawn as it was only until it is read again.

/** How one sandbox's read stands: answered this visit, being asked, or why it could not be asked now. */
export type ReadState = `fresh` | `reading` | `asleep` | `unreachable` | `signin` | `old` | `locked`;

export interface ReachRead {
    readonly state: ReadState;
    /** The newest answer held, this visit's or an earlier one's; absent when it never answered here. */
    readonly answer?: SandboxReach | undefined;
}

/** What the graph reads off the platform's row. */
export type PlatformSandbox = Pick<SandboxSummary, `id` | `name` | `image` | `tier` | `daemonUrl` | `hosted`> & {
    readonly hostReport?: { readonly machine: string } | null | undefined;
};

export interface AccountGraphInput {
    readonly email: string;
    readonly orgs: readonly { readonly id: string; readonly name: string; readonly role: string }[];
    readonly sandboxes: readonly PlatformSandbox[];
    readonly reads: ReadonlyMap<string, ReachRead>;
}

export const YOU_ID = `you`;
export const CLOUD_ID = `cloud`;

/** `yours`: the account owns it. `shared`: it was given a tier there. `beyond`: not in the account's list at all, met only
 *  as the far end of a link, either way round. */
export type Standing = `yours` | `shared` | `beyond`;

export interface GraphSandbox {
    readonly id: string;
    readonly sandboxId?: string | undefined;
    readonly name: string;
    readonly image?: string | null | undefined;
    readonly standing: Standing;
    /** The reader's tier: the daemon's word where it answered, else the platform's. Absent beyond the account. */
    readonly tier?: MemberTier | undefined;
    /** The platform's word, when the daemon's disagrees with it: the platform's copy lags a change made inside. */
    readonly platformTier?: MemberTier | undefined;
    readonly read?: ReadState | undefined;
    readonly readAt?: number | undefined;
    readonly agents?: boolean | undefined;
    readonly people?: number | undefined;
    readonly org?: { readonly id: string; readonly name: string } | undefined;
    /** Holds a fleet card: its agents may make sandboxes on its owner's account. */
    readonly fleet?: { readonly yours: boolean; readonly others?: number | undefined } | undefined;
    readonly cloud: boolean;
}

export type MachineKind = `computer` | `phone` | `browser` | `server` | `cloud`;

export interface GraphMachine {
    readonly id: string;
    readonly kind: MachineKind;
    readonly label: string;
    readonly platform?: string | undefined;
    readonly online?: boolean | undefined;
    /** A server's `user@host`, a computer's host name when it differs from its label. */
    readonly detail?: string | undefined;
}

export type EdgeKind = `member` | `link` | `device` | `server` | `runs`;

export interface GraphEdge {
    readonly id: string;
    readonly kind: EdgeKind;
    readonly from: string;
    readonly to: string;
    /** The card the tie rides on, in the sandbox it starts from. */
    readonly card?: string | undefined;
    readonly tier?: MemberTier | undefined;
    readonly terms?: (ReachLinkTerms & { readonly runAs?: string | undefined }) | undefined;
    /** A link's far side, as last asked: answering, silent or revoked. */
    readonly answer?: string | undefined;
    readonly grants?: readonly string[] | undefined;
    readonly user?: string | undefined;
    readonly admin?: boolean | undefined;
    /** The reader can drive it: their own conversations at its start may use it (a membership is always theirs). */
    readonly yours: boolean;
    /** It lets whoever drives it act there (run, change, operate, sign in), not only look or ask. */
    readonly acting: boolean;
    /** Other people at its start whose own agents may use it; absent where the roster is not the reader's to read. */
    readonly others?: number | undefined;
}

export type ExposureKind = `machine` | `server` | `operate` | `inbound` | `fleet`;

/** Something other people, or a sandbox outside the account, can act on through one tie: read first. */
export interface Exposure {
    readonly kind: ExposureKind;
    readonly edge: string;
    /** Where the reach starts (a sandbox) and what it lands on (a machine, a server, a sandbox, or the account). */
    readonly from: string;
    readonly to: string;
    /** How many other people's agents, where that is known; a link from beyond the account has none to count. */
    readonly others?: number | undefined;
}

export interface AccountGraph {
    readonly you: { readonly id: typeof YOU_ID; readonly email: string; readonly orgs: AccountGraphInput[`orgs`] };
    readonly sandboxes: readonly GraphSandbox[];
    readonly machines: readonly GraphMachine[];
    readonly edges: readonly GraphEdge[];
    readonly exposures: readonly Exposure[];
    readonly nodes: ReadonlyMap<string, GraphSandbox | GraphMachine>;
}

export const sandboxNodeId = (sandboxId: string): string => `sandbox:${sandboxId}`;
const beyondNodeId = (key: string): string => `beyond:${key}`;

const STANDING_ORDER: readonly Standing[] = [`yours`, `shared`, `beyond`];
const MACHINE_ORDER: readonly MachineKind[] = [`computer`, `phone`, `browser`, `server`, `cloud`];

const KNOWN_GRANTS: ReadonlySet<string> = new Set(REACH_DEVICE_GRANTS);
const ACTING_GRANTS: ReadonlySet<string> = new Set(REACH_DEVICE_ACTING_GRANTS);

/** A device's switches in the contract's order, unknown ones (a newer daemon's) after, as they came. */
const orderedGrants = (grants: readonly string[]): string[] => {
    const known = REACH_DEVICE_GRANTS.filter((grant) => grants.includes(grant));
    return [...known, ...grants.filter((grant) => !KNOWN_GRANTS.has(grant))];
};

const actingDevice = (grants: readonly string[]): boolean => grants.some((grant) => ACTING_GRANTS.has(grant));
const actingLink = (terms: ReachLinkTerms | undefined): boolean => terms?.operate === true || terms?.tasks === true;

const lower = (value: string | undefined): string | undefined => {
    const trimmed = value?.trim().toLowerCase() ?? ``;
    return trimmed === `` ? undefined : trimmed;
};

/** The reader's tier on one sandbox, and the platform's word beside it when the two disagree. */
interface TierReading {
    readonly tier: MemberTier;
    readonly platformTier: MemberTier | undefined;
}

// What the platform says the reader is, read against what the daemon enforces: the daemon's word wins.
const tierOf = (row: PlatformSandbox, answer: SandboxReach | undefined): TierReading => {
    const enforced = answer?.reader.tier;
    return enforced === undefined || enforced === row.tier ? { tier: row.tier, platformTier: undefined } : { tier: enforced, platformTier: row.tier };
};

interface Builder {
    readonly sandboxes: Map<string, GraphSandbox>;
    readonly machines: Map<string, GraphMachine>;
    readonly edges: Map<string, GraphEdge>;
    /** Platform rows by their address's host name, for a link whose card named no id. */
    readonly byHost: ReadonlyMap<string, string>;
    /** Computers by host name and by label, for a sandbox's own host and a device that said no machine id. */
    readonly computerByName: Map<string, string>;
}

const addMachine = (builder: Builder, machine: GraphMachine): string => {
    const held = builder.machines.get(machine.id);
    if (held === undefined) {
        builder.machines.set(machine.id, machine);
    } else if (machine.online === true && held.online !== true) {
        // Any one sandbox seeing it connected is enough to say it is up.
        builder.machines.set(machine.id, { ...held, online: true });
    }
    return machine.id;
};

// A tie seen from both its ends is one edge: the asking side knows whether the reader can drive it and how many others
// can, the taking side holds the terms it enforces. What either knows fills what the other left out; on the terms, the
// taking side's own record wins (`taking`), since the asking side only repeats what it was last told.
const merged = (held: GraphEdge, edge: GraphEdge, taking: boolean): GraphEdge => ({
    ...held,
    card: held.card ?? edge.card,
    answer: held.answer ?? edge.answer,
    terms: taking ? (edge.terms ?? held.terms) : (held.terms ?? edge.terms),
    others: held.others ?? edge.others,
    yours: held.yours || edge.yours,
    acting: held.acting || edge.acting,
});

const addEdge = (builder: Builder, edge: GraphEdge, taking = false): void => {
    const held = builder.edges.get(edge.id);
    builder.edges.set(edge.id, held === undefined ? edge : merged(held, edge, taking));
};

// A far sandbox by what a link card or an inbound link named: the account's own row when its id or address matches,
// else a sandbox beyond the account, named as the tie names it.
const farSandbox = (builder: Builder, far: { readonly sandboxId?: string | undefined; readonly host?: string | undefined; readonly name: string }): string => {
    if (far.sandboxId !== undefined && builder.sandboxes.has(sandboxNodeId(far.sandboxId))) {
        return sandboxNodeId(far.sandboxId);
    }
    const host = lower(far.host);
    const matched = host === undefined ? undefined : builder.byHost.get(host);
    if (matched !== undefined) {
        return sandboxNodeId(matched);
    }
    const id = beyondNodeId(far.sandboxId ?? host ?? far.name.toLowerCase());
    if (!builder.sandboxes.has(id)) {
        builder.sandboxes.set(id, { id, sandboxId: far.sandboxId, name: far.name, standing: `beyond`, cloud: false });
    }
    return id;
};

const deviceMachine = (builder: Builder, from: string, device: ReachDevice): string => {
    const kind: MachineKind = device.kind === `phone` ? `phone` : device.kind === `browser` ? `browser` : `computer`;
    const hostname = lower(device.hostname);
    const known = hostname === undefined ? undefined : builder.computerByName.get(hostname);
    const id =
        device.machineId !== undefined
            ? `machine:${device.machineId}`
            : (known ?? (hostname !== undefined ? `host:${hostname}` : `card:${from}:${device.card}`));
    addMachine(builder, {
        id,
        kind,
        label: device.label,
        platform: device.platform,
        online: device.online,
        detail: hostname !== undefined && hostname !== device.label.toLowerCase() ? device.hostname : undefined,
    });
    if (kind === `computer`) {
        for (const name of [hostname, lower(device.label)]) {
            if (name !== undefined && !builder.computerByName.has(name)) {
                builder.computerByName.set(name, id);
            }
        }
    }
    return id;
};

const linkOutEdge = (builder: Builder, from: string, link: ReachLinkOut): void => {
    const to = farSandbox(builder, { sandboxId: link.sandboxId, host: link.host, name: link.name ?? link.host });
    addEdge(builder, {
        id: `link:${from}>${to}`,
        kind: `link`,
        from,
        to,
        card: link.card,
        answer: link.answer,
        terms: link.terms,
        yours: link.yours,
        acting: actingLink(link.terms),
        others: link.others,
    });
};

const linkInEdge = (builder: Builder, to: string, link: ReachLinkIn): void => {
    const from = farSandbox(builder, { sandboxId: link.sandboxId, host: link.host, name: link.label });
    addEdge(builder, {
        id: `link:${from}>${to}`,
        kind: `link`,
        from,
        to,
        terms: link.terms,
        // Whether the reader can drive it is the asking side's to say; read from there when the reader reads that side.
        yours: false,
        acting: actingLink(link.terms),
    }, true);
};

const tiesOf = (builder: Builder, from: string, answer: SandboxReach): void => {
    for (const link of answer.linksOut) {
        linkOutEdge(builder, from, link);
    }
    for (const link of answer.linksIn ?? []) {
        linkInEdge(builder, from, link);
    }
    for (const device of answer.devices) {
        const grants = orderedGrants(device.grants);
        const to = deviceMachine(builder, from, device);
        addEdge(builder, {
            id: `device:${from}>${to}:${device.card}`,
            kind: `device`,
            from,
            to,
            card: device.card,
            grants,
            yours: device.yours,
            acting: actingDevice(grants),
            others: device.others,
        });
    }
    for (const server of answer.servers) {
        const host = lower(server.host) ?? server.host;
        const to = addMachine(builder, { id: `server:${host}`, kind: `server`, label: host });
        addEdge(builder, {
            id: `server:${from}>${to}:${server.card}`,
            kind: `server`,
            from,
            to,
            card: server.card,
            user: server.user,
            admin: server.admin,
            yours: server.yours,
            acting: true,
            others: server.others,
        });
    }
};

// Where a sandbox runs: the cloud, or a computer named by its daemon (owner and Full access) or by its machine's own
// report to the platform (the owner's row), joined to a computer some sandbox reaches when one goes by that name.
const runsOn = (builder: Builder, row: PlatformSandbox, answer: SandboxReach | undefined): void => {
    const from = sandboxNodeId(row.id);
    if (row.hosted !== null && row.hosted !== undefined) {
        addMachine(builder, { id: CLOUD_ID, kind: `cloud`, label: `` });
        addEdge(builder, { id: `runs:${from}`, kind: `runs`, from, to: CLOUD_ID, yours: false, acting: false });
        return;
    }
    const name = answer?.self.runsOn?.host ?? row.hostReport?.machine;
    const key = lower(name);
    if (name === undefined || key === undefined) {
        return;
    }
    const to = builder.computerByName.get(key) ?? addMachine(builder, { id: `host:${key}`, kind: `computer`, label: name.trim() });
    builder.computerByName.set(key, to);
    addEdge(builder, { id: `runs:${from}`, kind: `runs`, from, to, yours: false, acting: false });
};

const exposureOf = (edge: GraphEdge, sandboxes: ReadonlyMap<string, GraphSandbox>): Exposure | undefined => {
    const others = edge.others ?? 0;
    const base = { edge: edge.id, from: edge.from, to: edge.to, others: edge.others };
    if (edge.kind === `device` && edge.acting && others > 0) {
        return { kind: `machine`, ...base };
    }
    if (edge.kind === `server` && others > 0) {
        return { kind: `server`, ...base };
    }
    if (edge.kind === `link`) {
        const asking = sandboxes.get(edge.from);
        // A sandbox outside the account handing work to one of the reader's: whoever drives it reaches in.
        if (asking?.standing === `beyond` && actingLink(edge.terms)) {
            return { kind: `inbound`, edge: edge.id, from: edge.from, to: edge.to };
        }
        if (edge.terms?.operate === true && others > 0) {
            return { kind: `operate`, ...base };
        }
    }
    return undefined;
};

// Read first: what lands on the reader's own account, then whatever acts on a machine, then sandboxes; more people first.
const EXPOSURE_ORDER: readonly ExposureKind[] = [`fleet`, `inbound`, `machine`, `server`, `operate`];
const exposureRank = (exposure: Exposure): number => EXPOSURE_ORDER.indexOf(exposure.kind) * 10_000 - (exposure.others ?? 0);

// One of the account's own rows, as its read left it.
const sandboxNode = (row: PlatformSandbox, read: ReachRead | undefined): GraphSandbox => {
    const answer = read?.answer;
    const tier = tierOf(row, answer);
    return {
        id: sandboxNodeId(row.id),
        sandboxId: row.id,
        name: row.name,
        image: row.image,
        standing: tier.tier === `owner` ? `yours` : `shared`,
        tier: tier.tier,
        platformTier: tier.platformTier,
        read: read?.state,
        readAt: answer?.readAt,
        agents: answer?.reader.agents,
        people: answer?.people,
        org: answer?.self.org,
        fleet: answer?.fleet,
        cloud: row.hosted !== null && row.hosted !== undefined,
    };
};

const hostsOf = (rows: readonly PlatformSandbox[]): Map<string, string> => {
    const byHost = new Map<string, string>();
    for (const row of rows) {
        const host = row.daemonUrl === null || row.daemonUrl === `` ? `` : reachHostOf(row.daemonUrl);
        if (host !== ``) {
            byHost.set(host, row.id);
        }
    }
    return byHost;
};

// What deserves reading first, most serious first: each tie's, then each fleet card that acts on the reader's account.
const exposuresOf = (edges: readonly GraphEdge[], sandboxes: ReadonlyMap<string, GraphSandbox>): Exposure[] => {
    const found = edges.flatMap((edge) => exposureOf(edge, sandboxes) ?? []);
    for (const sandbox of sandboxes.values()) {
        // A fleet card acts on its owner's account: the reader's own when the sandbox is theirs.
        if (sandbox.standing === `yours` && (sandbox.fleet?.others ?? 0) > 0) {
            found.push({ kind: `fleet`, edge: `fleet:${sandbox.id}`, from: sandbox.id, to: YOU_ID, others: sandbox.fleet?.others });
        }
    }
    return found.sort((a, b) => exposureRank(a) - exposureRank(b));
};

export const buildAccountGraph = (input: AccountGraphInput): AccountGraph => {
    const builder: Builder = { sandboxes: new Map(), machines: new Map(), edges: new Map(), byHost: hostsOf(input.sandboxes), computerByName: new Map() };

    // The account's own rows first, so every tie can find them.
    for (const row of input.sandboxes) {
        const node = sandboxNode(row, input.reads.get(row.id));
        builder.sandboxes.set(node.id, node);
        const acting = node.tier !== `viewer` && node.tier !== `guest`;
        addEdge(builder, { id: `member:${node.id}`, kind: `member`, from: YOU_ID, to: node.id, tier: node.tier, yours: true, acting });
    }
    // Ties next, so a sandbox's host joins the computer its devices already named.
    for (const row of input.sandboxes) {
        const answer = input.reads.get(row.id)?.answer;
        if (answer !== undefined) {
            tiesOf(builder, sandboxNodeId(row.id), answer);
        }
    }
    for (const row of input.sandboxes) {
        runsOn(builder, row, input.reads.get(row.id)?.answer);
    }

    const edges = [...builder.edges.values()];
    const sandboxes = [...builder.sandboxes.values()].sort((a, b) => STANDING_ORDER.indexOf(a.standing) - STANDING_ORDER.indexOf(b.standing));
    const machines = [...builder.machines.values()].sort(
        (a, b) => MACHINE_ORDER.indexOf(a.kind) - MACHINE_ORDER.indexOf(b.kind) || a.label.localeCompare(b.label),
    );
    return {
        you: { id: YOU_ID, email: input.email, orgs: input.orgs },
        sandboxes,
        machines,
        edges,
        exposures: exposuresOf(edges, builder.sandboxes),
        nodes: new Map<string, GraphSandbox | GraphMachine>([...sandboxes.map((node) => [node.id, node] as const), ...machines.map((node) => [node.id, node] as const)]),
    };
};

/** What a focus lights: the nodes and edges tied to it, the way a reader asks of each kind of thing. */
export interface GraphLighting {
    readonly nodes: ReadonlySet<string>;
    readonly edges: ReadonlySet<string>;
}

// The reader: everything their own conversations can drive, following ties they can drive from wherever they run agents.
const litFromYou = (graph: AccountGraph): GraphLighting => {
    const nodes = new Set<string>([YOU_ID]);
    const edges = new Set<string>();
    const driving = new Set<string>();
    for (const edge of graph.edges) {
        if (edge.kind === `member`) {
            nodes.add(edge.to);
            edges.add(edge.id);
            const sandbox = graph.nodes.get(edge.to);
            if (sandbox !== undefined && `standing` in sandbox && sandbox.agents !== false) {
                driving.add(edge.to);
            }
        }
    }
    // Two hops past the account's own sandboxes at most, as a link carries a task on once more and no further.
    for (let hop = 0; hop < 2; hop += 1) {
        for (const edge of graph.edges) {
            if (edge.kind !== `member` && edge.kind !== `runs` && edge.yours && driving.has(edge.from)) {
                edges.add(edge.id);
                nodes.add(edge.to);
                if (edge.kind === `link` && edge.terms?.tasks === true) {
                    driving.add(edge.to);
                }
            }
        }
    }
    return { nodes, edges };
};

// A sandbox: who and what it is tied to, either way round, and the reader's way in.
// A machine or a server: every sandbox that reaches it or runs on it, and the reader's way into each of those.
const litAround = (graph: AccountGraph, id: string): GraphLighting => {
    const nodes = new Set<string>([id]);
    const edges = new Set<string>();
    for (const edge of graph.edges) {
        if (edge.from === id || edge.to === id) {
            edges.add(edge.id);
            nodes.add(edge.from);
            nodes.add(edge.to);
        }
    }
    if (!graph.machines.some((machine) => machine.id === id)) {
        return { nodes, edges };
    }
    for (const edge of graph.edges) {
        if (edge.kind === `member` && nodes.has(edge.to)) {
            edges.add(edge.id);
            nodes.add(YOU_ID);
        }
    }
    return { nodes, edges };
};

export const lightingOf = (graph: AccountGraph, focus: string): GraphLighting => (focus === YOU_ID ? litFromYou(graph) : litAround(graph, focus));
