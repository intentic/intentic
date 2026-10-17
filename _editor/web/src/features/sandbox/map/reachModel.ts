import type { ControlScope, ControlTokenSummary } from "@intentic/sandbox-contract/policy/control-scopes";
import { type Fence, pathInsideFolder } from "@intentic/sandbox-contract/policy/fence-paths";
import { isSignedInAccount, personaAllowsCapability } from "@intentic/sandbox-contract/policy/persona-capability";
import { fenceHoldsPersona, personaHome } from "@intentic/sandbox-contract/policy/persona-home";
import type { AgentProvider } from "@intentic/sandbox-contract/schemas/agent";
import type { Area } from "@intentic/sandbox-contract/schemas/areas";
import type { CapabilityKind } from "@intentic/sandbox-contract/schemas/capabilities";
import type { InboundLinkSummary } from "@intentic/sandbox-contract/schemas/links";
import { type Member, memberAccess, REACHABLE_CREDENTIAL_KINDS } from "@intentic/sandbox-contract/schemas/members";
import { type Persona, PersonaPowersSchema } from "@intentic/sandbox-contract/schemas/personas";
import type { MemberRole } from "@intentic/sandbox-contract/schemas/shared";

// THE SANDBOX'S WHOLE REACH AS ONE GRAPH, BUILT FROM WHAT THE DAEMON ENFORCES. Two halves meet at the box: the
// principals that can get in (people, control tokens, other sandboxes handing it tasks) and what the box reaches once
// they are in (its areas and personas inside it, the connections, machines, sandboxes and models outside). Each
// principal carries the part of the graph it reaches, worked out with the rules the daemon refuses on, so a map that
// lights a node for someone is saying something the daemon would let them do:
//
// - areas a person sees and edits: their grant's `areas` and `edit` (sandbox-contract `memberAccess`);
// - personas: the cards their fence holds (`fenceHoldsPersona`, the daemon's persona-reach.ts);
// - connections: their credential reach (secrets/credential-reach.ts), and for someone who only chats, only what the
//   personas they reach let a turn act through (`personaAllowsCapability`, the daemon's turnPersona);
// - a control token: unfenced and unlimited, as a request it admits carries no identity (app.ts), at its scope's rung;
// - another sandbox's link: its tasks run unattended as the link's persona, or with no signed-in account when it names
//   none (links/link-tasks.ts, personas.ts `unattended-unpinned`).
//
// Pure and language-free: the composable beside it gathers the reads, the view puts words on the ids.

/** How a principal reaches a node: changes it by hand, reads it, acts through it, or acts through it only as a persona. */
export type ReachHow = `edit` | `see` | `use` | `through`;

export type GroupKey = `services` | `accounts` | `machines` | `sandboxes` | `network` | `models`;

/** The order the outward groups stand in, nearest-to-the-work first. */
const GROUP_ORDER: readonly GroupKey[] = [`services`, `accounts`, `machines`, `sandboxes`, `network`, `models`];

export type NodeKind = `area` | `rest` | `persona` | `secret` | `capability` | `model` | `port` | `outbox` | `session`;

export type NodeTone = `success` | `warning` | `danger` | `info` | `neutral`;

export interface MapNode {
    readonly id: string;
    readonly kind: NodeKind;
    readonly label: string;
    /** A second, quieter name: the tile a named connection came from, an area's folder count, a model's account count. */
    readonly detail?: string | undefined;
    readonly logo?: string | undefined;
    readonly icon?: string | undefined;
    /** Its own health, in the board's words; absent where it has none worth a dot. */
    readonly state?: string | undefined;
    readonly tone: NodeTone;
    /** A browser window open on it right now. */
    readonly live?: boolean | undefined;
    /** The capability kind, for a connection; where its page is and which rule decides it. */
    readonly capabilityKind?: CapabilityKind;
    /** The record's own id (an area's, a persona's, a connection's), for the link to the page that edits it. */
    readonly ref?: string;
    /** A model source's provider, whose own mark draws it. */
    readonly provider?: AgentProvider | undefined;
}

export interface MapGroup {
    readonly key: GroupKey;
    readonly nodes: readonly MapNode[];
}

export type PrincipalKind = `person` | `token` | `link`;

export interface Principal {
    readonly id: string;
    readonly kind: PrincipalKind;
    /** An address for a person, a label for a token or a link. */
    readonly label: string;
    /** The tier a person's grant makes; `owner` for the owner. */
    readonly role?: MemberRole;
    /** The signed-in reader. */
    readonly self?: boolean;
    readonly scope?: ControlScope;
    /** The persona a link's tasks wear; absent, they wear none. */
    readonly actsAs?: string | undefined;
    /** `invited`: the grant stands and they have not signed in yet. `inert`: it holds nothing (expired, its minter gone,
     *  its persona gone). */
    readonly status: `active` | `invited` | `inert`;
    /** Why an inert principal holds nothing. */
    readonly inert?: `expired` | `minter` | `persona` | `invite` | undefined;
    /** Tasks a link has handed over that wait for a yes here. */
    readonly waiting?: number | undefined;
    readonly reach: ReadonlyMap<string, ReachHow>;
}

export interface ReachMap {
    readonly principals: readonly Principal[];
    readonly areas: readonly MapNode[];
    readonly personas: readonly MapNode[];
    readonly secrets: readonly MapNode[];
    readonly groups: readonly MapGroup[];
    /** Every node by id, inside the box and out. */
    readonly nodes: ReadonlyMap<string, MapNode>;
    /** Whether the roster of people could be read; below the owner it cannot, and the map says who it leaves out. */
    readonly rosterRead: boolean;
}

/** A connection as the capabilities board already words it (connectionRows.ts), with the kind the rules read. */
export interface ReachCapability {
    readonly id: string;
    readonly kind: CapabilityKind;
    readonly title: string;
    readonly tile?: string | undefined;
    readonly logo?: string | undefined;
    readonly icon: string;
    readonly state: string;
    readonly tone: NodeTone;
    /** For a site account, the identity whose browser it was born in (`config.identity`). */
    readonly identity?: string | undefined;
}

export interface ReachModelSource {
    readonly id: string;
    readonly provider?: AgentProvider | undefined;
    readonly label: string;
    readonly detail?: string | undefined;
    readonly logo?: string | undefined;
    readonly icon?: string | undefined;
    readonly tone: NodeTone;
}

export interface ReachInput {
    readonly areas: readonly Area[];
    readonly personas: readonly Persona[];
    readonly capabilities: readonly ReachCapability[];
    /** Stored secrets the owner keeps or the sandbox made (not a connection's own, which ride its connection). */
    readonly secrets: readonly string[];
    readonly models: readonly ReachModelSource[];
    /** Undefined when the roster is not the reader's to read. */
    readonly roster?: { readonly owner?: string | undefined; readonly members: readonly Member[] } | undefined;
    /** Addresses whose invite has not been taken up yet, and those whose invite ran out. */
    readonly invited?: ReadonlySet<string>;
    readonly expired?: ReadonlySet<string>;
    readonly tokens?: readonly ControlTokenSummary[] | undefined;
    readonly inbound?: readonly InboundLinkSummary[] | undefined;
    /** The signed-in reader: their address and tier, so they appear even when the roster is not theirs to read. */
    readonly self?: { readonly email: string; readonly role: MemberRole } | undefined;
    /** Ids of signed-in capabilities with a browser window open now, and whether a signed-out one is open. */
    readonly liveAccounts?: ReadonlySet<string>;
    readonly anonymousBrowser?: boolean;
    /** Ports reachable from outside right now, and files in the public outbox. */
    readonly publicPorts?: readonly { readonly port: number; readonly title: string }[];
    readonly outboxFiles?: number;
    readonly now: number;
}

// Which outward group a connection stands in; a kind not named here is a service.
const GROUP_OF_KIND = new Map<CapabilityKind, GroupKey>([
    [`cli`, `services`],
    [`mcp`, `services`],
    [`plugin`, `services`],
    [`extension`, `services`],
    [`agent`, `services`],
    [`devops`, `services`],
    [`monorepo`, `services`],
    [`wallet`, `services`],
    [`identity`, `accounts`],
    [`browser`, `accounts`],
    [`webext`, `accounts`],
    [`device`, `machines`],
    [`phone`, `machines`],
    [`ssh`, `machines`],
    [`docker`, `machines`],
    [`link`, `sandboxes`],
    [`fleet`, `sandboxes`],
    [`vpn`, `network`],
    [`netdisk`, `network`],
    [`exit`, `network`],
    [`endpoint`, `models`],
    [`localmodel`, `models`],
]);

const groupOfKind = (kind: CapabilityKind): GroupKey => GROUP_OF_KIND.get(kind) ?? `services`;

export const REST_ID = `rest`;
const areaId = (id: string): string => `area:${id}`;
const personaId = (id: string): string => `persona:${id}`;
const capabilityId = (id: string): string => `cap:${id}`;
const secretId = (name: string): string => `secret:${name}`;

// Every folder an area set names, or undefined for none named (the whole workspace).
const foldersOf = (areas: readonly Area[], held: readonly string[] | undefined): Fence =>
    held === undefined ? undefined : [...new Set(held.flatMap((id) => areas.find((area) => area.id === id)?.folders ?? []))];

// Whether a fence and an area share any ground: one holds the other's folder, either way round.
const overlaps = (fence: Fence, area: Area): boolean =>
    fence === undefined || area.folders.some((folder) => fence.some((held) => pathInsideFolder(held, folder) || pathInsideFolder(folder, held)));

const shelvesOf = (persona: Persona) => PersonaPowersSchema.parse(persona.powers ?? {});

/** Whether a persona lets a turn act through this connection: the daemon's own rule, shared through the contract. */
const personaAllows = (persona: Persona, capability: Pick<ReachCapability, `id` | `kind`>): boolean =>
    personaAllowsCapability(capability, persona.capabilities, shelvesOf(persona));

// What a credential reach decides: only the kinds a member's reach can withhold; the rest hold nothing to withhold.
const decides = (kind: CapabilityKind): boolean => REACHABLE_CREDENTIAL_KINDS.includes(kind);

interface Credentials {
    readonly capabilities: ReadonlySet<string>;
    readonly secrets: ReadonlySet<string>;
}

// Builds one principal's reach from the parts every kind of principal is made of: where it works, which personas it may
// wear, whether it runs turns at all, and how it reaches what the turns spend.
interface ReachParts {
    /** Areas it changes by hand, and areas it reads (undefined: the whole workspace). */
    readonly edit: Fence | `none`;
    readonly see: Fence | `none`;
    readonly personas: readonly Persona[];
    /** `direct`: its turns act through anything its credentials allow. `personas`: only what those personas allow.
     *  `none`: it starts no turn. */
    readonly turns: `direct` | `personas` | `none`;
    /** `through` marks everything outward as reached only inside something narrower (a persona, one conversation). */
    readonly how: `use` | `through`;
    /** Undefined: every credential. */
    readonly credentials?: Credentials | undefined;
    /** A turn nobody watches with no persona named holds no signed-in account. */
    readonly accountsDenied?: boolean;
}

// The areas a fence reaches, at one strength; the stronger answer wins, since editing an area is also seeing it.
const markAreas = (reach: Map<string, ReachHow>, areas: readonly Area[], fence: Fence | `none`, how: `see` | `edit`): void => {
    if (fence === `none`) {
        return;
    }
    const ids = [...areas.filter((area) => overlaps(fence, area)).map((area) => areaId(area.id)), ...(fence === undefined ? [REST_ID] : [])];
    for (const id of ids) {
        if (reach.get(id) !== `edit`) {
            reach.set(id, how);
        }
    }
};

// Whether a principal's turns may act through one connection: its credentials first, then a watcher-less turn's missing
// accounts, then (for one who acts only as a persona) whether any persona it may wear allows it.
const turnsReach = (parts: ReachParts, capability: ReachCapability): boolean => {
    const credited = parts.credentials === undefined || !decides(capability.kind) || parts.credentials.capabilities.has(capability.id);
    const signedIn = parts.accountsDenied !== true || !isSignedInAccount(capability.kind);
    const worn = parts.turns !== `personas` || parts.personas.some((persona) => personaAllows(persona, capability));
    return credited && signedIn && worn;
};

const build = (input: ReachInput, parts: ReachParts): Map<string, ReachHow> => {
    const reach = new Map<string, ReachHow>();
    markAreas(reach, input.areas, parts.see, `see`);
    markAreas(reach, input.areas, parts.edit, `edit`);
    if (parts.turns === `none`) {
        return reach;
    }
    const outward = [
        ...input.capabilities.filter((capability) => turnsReach(parts, capability)).map((capability) => capabilityId(capability.id)),
        ...input.secrets.filter((name) => parts.credentials === undefined || parts.credentials.secrets.has(name)).map(secretId),
        ...input.models.map((model) => model.id),
        // What its turns can put in front of the internet: anyone who runs turns can publish.
        ...networkIds(input),
    ];
    for (const persona of parts.personas) {
        reach.set(personaId(persona.id), `use`);
    }
    for (const id of outward) {
        reach.set(id, parts.how);
    }
    return reach;
};

const networkIds = (input: ReachInput): string[] => [
    ...(input.publicPorts ?? []).map((port) => `port:${port.port}`),
    ...((input.outboxFiles ?? 0) > 0 ? [`outbox`] : []),
];

const EVERYTHING: Omit<ReachParts, `personas`> = { edit: undefined, see: undefined, turns: `direct`, how: `use` };

const lower = (email: string): string => email.toLowerCase();

const personReach = (input: ReachInput, member: Member): Map<string, ReachHow> => {
    const access = memberAccess(member);
    if (access.manage) {
        return build(input, { ...EVERYTHING, personas: input.personas });
    }
    const see = foldersOf(input.areas, access.see);
    const edit = access.edit === `none` ? `none` : access.edit === `all` ? see : foldersOf(input.areas, access.edit);
    const credentials =
        member.credentials === undefined
            ? undefined
            : { capabilities: new Set(member.credentials.capabilities), secrets: new Set(member.credentials.secrets) };
    return build(input, {
        see,
        edit,
        personas: input.personas.filter((card) => fenceHoldsPersona(see, card)),
        turns: access.agents === `off` ? `none` : access.agents === `chat` ? `personas` : `direct`,
        // Somebody who only chats acts through whichever card they talk to.
        how: access.agents === `chat` ? `through` : `use`,
        credentials,
    });
};

// A control token carries no identity, so no fence and no credential limit: its scope is the whole of what narrows it.
const tokenReach = (input: ReachInput, scope: ControlScope): Map<string, ReachHow> => {
    switch (scope) {
        case `read`:
            return build(input, { ...EVERYTHING, edit: `none`, turns: `none`, personas: [] });
        // One conversation: whatever that conversation reaches, and nothing beside it.
        case `editor`:
            return build(input, { ...EVERYTHING, edit: `none`, how: `through`, personas: input.personas });
        case `drive`:
        case `land`:
            return build(input, { ...EVERYTHING, edit: `none`, personas: input.personas });
    }
};

const linkReach = (input: ReachInput, link: InboundLinkSummary): Map<string, ReachHow> => {
    const actsAs = link.terms.actsAs;
    // Unpinned: the full toolbox, the whole workspace, and no signed-in account, since nobody here is watching.
    if (actsAs === undefined) {
        return build(input, { ...EVERYTHING, edit: `none`, personas: [], accountsDenied: true });
    }
    const persona = input.personas.find((card) => card.id === actsAs);
    if (persona === undefined) {
        return new Map();
    }
    return build(input, {
        // Its tasks work inside the persona's folders, the conversation itself being unfenced.
        see: persona.workspace?.folders === undefined || persona.workspace.folders.length === 0 ? undefined : persona.workspace.folders,
        edit: `none`,
        personas: [persona],
        turns: `personas`,
        how: `through`,
    });
};

const tokenInert = (input: ReachInput, token: ControlTokenSummary): `expired` | `minter` | undefined => {
    if (token.expiresAt !== undefined && token.expiresAt <= input.now) {
        return `expired`;
    }
    // A token works only while whoever minted it still holds the operating tier (control-tokens.ts `minterBound`); the
    // roster says so only to the reader allowed to read it.
    const minter = token.createdBy === undefined ? undefined : lower(token.createdBy);
    // A roster that does not name its owner cannot say whether the minter still manages: say nothing rather than guess.
    const owner = input.roster?.owner ?? (input.self?.role === `owner` ? input.self.email : undefined);
    if (minter === undefined || input.roster === undefined || owner === undefined || lower(owner) === minter) {
        return undefined;
    }
    return input.roster.members.some((member) => lower(member.email) === minter && memberAccess(member).manage) ? undefined : `minter`;
};

// The reader first, then the owner, then by how much they may do.
const ROLE_RANK = { owner: 0, maintainer: 1, writer: 2, collaborator: 3, guest: 4, viewer: 5 } as const satisfies Record<MemberRole, number>;

const memberRow = (input: ReachInput, member: Member, selfEmail: string | undefined): Principal => {
    const address = lower(member.email);
    const expired = input.expired?.has(address) === true;
    const invited = input.invited?.has(address) === true;
    return {
        id: `person:${address}`,
        kind: `person`,
        label: member.email,
        role: memberAccess(member).manage ? `maintainer` : member.role,
        self: address === selfEmail,
        status: expired ? `inert` : invited ? `invited` : `active`,
        inert: expired ? `invite` : undefined,
        reach: personReach(input, member),
    };
};

// Below the owner the roster is not the reader's: they still stand on the map as themselves, at their own tier.
const selfRow = (input: ReachInput, self: { readonly email: string; readonly role: MemberRole }): Principal => ({
    id: `person:${lower(self.email)}`,
    kind: `person`,
    label: self.email,
    role: self.role,
    self: true,
    status: `active`,
    reach: self.role === `maintainer` ? build(input, { ...EVERYTHING, personas: input.personas }) : new Map(),
});

const people = (input: ReachInput): Principal[] => {
    const selfEmail = input.self === undefined ? undefined : lower(input.self.email);
    const owner = input.roster?.owner ?? (input.self?.role === `owner` ? input.self.email : undefined);
    const rows: Principal[] = [];
    if (owner !== undefined) {
        const reach = build(input, { ...EVERYTHING, personas: input.personas });
        rows.push({ id: `person:${lower(owner)}`, kind: `person`, label: owner, role: `owner`, self: lower(owner) === selfEmail, status: `active`, reach });
    }
    for (const member of input.roster?.members ?? []) {
        if (!rows.some((row) => row.id === `person:${lower(member.email)}`)) {
            rows.push(memberRow(input, member, selfEmail));
        }
    }
    if (input.roster === undefined && input.self !== undefined && input.self.role !== `owner`) {
        rows.push(selfRow(input, input.self));
    }
    return rows.toSorted(
        (left, right) =>
            Number(right.self === true) - Number(left.self === true) ||
            ROLE_RANK[left.role ?? `viewer`] - ROLE_RANK[right.role ?? `viewer`] ||
            left.label.localeCompare(right.label),
    );
};

const SCOPE_RANK = { land: 0, drive: 1, editor: 2, read: 3 } as const satisfies Record<ControlScope, number>;

const tokens = (input: ReachInput): Principal[] =>
    (input.tokens ?? [])
        .toSorted((left, right) => SCOPE_RANK[left.scope] - SCOPE_RANK[right.scope] || left.label.localeCompare(right.label))
        .map((token) => {
            const inert = tokenInert(input, token);
            return {
                id: `token:${token.id}`,
                kind: `token` as const,
                label: token.label,
                scope: token.scope,
                status: inert === undefined ? (`active` as const) : (`inert` as const),
                inert,
                reach: inert === undefined ? tokenReach(input, token.scope) : new Map<string, ReachHow>(),
            };
        });

const links = (input: ReachInput): Principal[] =>
    (input.inbound ?? []).map((link) => {
        const actsAs = link.terms.actsAs;
        const lost = actsAs !== undefined && !input.personas.some((card) => card.id === actsAs);
        return {
            id: `link:${link.id}`,
            kind: `link` as const,
            label: link.label,
            actsAs,
            status: lost ? (`inert` as const) : (`active` as const),
            inert: lost ? (`persona` as const) : undefined,
            waiting: link.requests.length > 0 ? link.requests.length : undefined,
            reach: linkReach(input, link),
        };
    });

const areaNodes = (input: ReachInput): MapNode[] => [
    ...input.areas.map((area) => ({
        id: areaId(area.id),
        kind: `area` as const,
        label: area.label ?? area.id,
        detail: area.folders.join(`, `),
        icon: `folder`,
        tone: `neutral` as const,
        ref: area.id,
    })),
    // Whatever no area names, or the whole workspace where there are no areas: only the unfenced reach it.
    { id: REST_ID, kind: `rest` as const, label: REST_ID, icon: `folder-open`, tone: `neutral` as const },
];

const personaNodes = (input: ReachInput): MapNode[] =>
    input.personas.map((persona) => ({
        id: personaId(persona.id),
        kind: `persona` as const,
        label: persona.label ?? persona.id,
        detail: persona.brief,
        tone: `neutral` as const,
        ref: persona.id,
    }));

const capabilityNode = (capability: ReachCapability, live: boolean): MapNode => ({
    id: capabilityId(capability.id),
    kind: `capability`,
    label: capability.title,
    detail: capability.tile,
    logo: capability.logo,
    icon: capability.icon,
    state: capability.state,
    tone: capability.tone,
    live,
    capabilityKind: capability.kind,
    ref: capability.id,
});

// Healthy first would bury what needs a look under what does not: trouble rises within its group.
const TONE_RANK = { danger: 0, warning: 1, info: 2, neutral: 3, success: 4 } as const satisfies Record<NodeTone, number>;

const outward = (input: ReachInput): MapGroup[] => {
    const byGroup = new Map<GroupKey, MapNode[]>(GROUP_ORDER.map((key) => [key, []]));
    for (const capability of input.capabilities) {
        byGroup.get(groupOfKind(capability.kind))?.push(capabilityNode(capability, input.liveAccounts?.has(capability.id) === true));
    }
    for (const nodes of byGroup.values()) {
        nodes.sort((left, right) => TONE_RANK[left.tone] - TONE_RANK[right.tone] || left.label.localeCompare(right.label));
    }
    if (input.anonymousBrowser === true) {
        byGroup.get(`accounts`)?.push({ id: `session:anonymous`, kind: `session`, label: `session:anonymous`, icon: `globe`, tone: `neutral`, live: true });
    }
    byGroup.get(`network`)?.push(
        ...(input.publicPorts ?? []).map((port) => ({
            id: `port:${port.port}`,
            kind: `port` as const,
            label: String(port.port),
            detail: port.title,
            icon: `broadcast-tower`,
            tone: `warning` as const,
        })),
        ...((input.outboxFiles ?? 0) > 0
            ? [{ id: `outbox`, kind: `outbox` as const, label: `outbox`, detail: String(input.outboxFiles), icon: `share`, tone: `warning` as const }]
            : []),
    );
    byGroup.get(`models`)?.push(...input.models.map((model) => ({ ...model, kind: `model` as const })));
    return GROUP_ORDER.map((key) => ({ key, nodes: byGroup.get(key) ?? [] })).filter((group) => group.nodes.length > 0);
};

export const buildReachMap = (input: ReachInput): ReachMap => {
    const areas = areaNodes(input);
    const personas = personaNodes(input);
    const secrets: MapNode[] = input.secrets.map((name) => ({ id: secretId(name), kind: `secret`, label: name, icon: `key`, tone: `neutral` }));
    const groups = outward(input);
    const nodes = new Map<string, MapNode>([...areas, ...personas, ...secrets, ...groups.flatMap((group) => group.nodes)].map((node) => [node.id, node]));
    return {
        principals: [...people(input), ...tokens(input), ...links(input)],
        areas,
        personas,
        secrets,
        groups,
        nodes,
        rosterRead: input.roster !== undefined,
    };
};

// ---- what a focus lights ----

/** What a node is tied to on its own, whoever holds it: a persona's home and what it may act through, an identity's
 *  accounts, an area's personas. Drawn as the focus's own threads. */
export interface Relations {
    /** Nodes lit alongside it. */
    readonly lit: ReadonlySet<string>;
    /** The few drawn as threads from it: a persona's own accounts, an identity's accounts. */
    readonly threads: readonly string[];
}

type RelationInput = Pick<ReachInput, `areas` | `personas` | `capabilities` | `secrets` | `models`>;

// A persona lights where it works and everything it may act through, and threads the accounts it carries.
const personaRelations = (input: RelationInput, persona: Persona, lit: Set<string>, threads: string[]): void => {
    const folders = persona.workspace?.folders;
    const fence: Fence = folders === undefined || folders.length === 0 ? undefined : folders;
    for (const id of [...input.areas.filter((area) => overlaps(fence, area)).map((area) => areaId(area.id)), ...(fence === undefined ? [REST_ID] : [])]) {
        lit.add(id);
    }
    const allowed = input.capabilities.filter((capability) => personaAllows(persona, capability));
    // Every card runs on a model; the stored secrets reach its turns through the shell, so only a card with one has them.
    const spent = [...input.models.map((model) => model.id), ...(shelvesOf(persona).shell ? input.secrets.map(secretId) : [])];
    for (const id of [...allowed.map((capability) => capabilityId(capability.id)), ...spent]) {
        lit.add(id);
    }
    threads.push(...allowed.filter((capability) => isSignedInAccount(capability.kind)).map((capability) => capabilityId(capability.id)));
};

// An area (or the rest of the workspace) threads the personas that live in it.
const areaRelations = (input: RelationInput, area: Area | undefined): string[] =>
    input.personas
        .filter((persona) => {
            const home = personaHome(persona);
            return area === undefined ? home === undefined : home !== undefined && fenceHoldsPersona(area.folders, persona);
        })
        .map((persona) => personaId(persona.id));

// A signed-in account threads the cards that carry it (every card allows a connector by default, so lighting those would
// say nothing), and an identity the accounts born in its browser, an account the identity it was born in.
const capabilityRelations = (input: RelationInput, capability: ReachCapability): string[] => {
    const cards = isSignedInAccount(capability.kind) ? input.personas.filter((persona) => personaAllows(persona, capability)).map((persona) => personaId(persona.id)) : [];
    const kin = input.capabilities.filter(
        (account) => (capability.kind === `identity` && account.identity === capability.id) || (capability.identity !== undefined && account.id === capability.identity),
    );
    return [...cards, ...kin.map((account) => capabilityId(account.id))];
};

export const relationsOf = (input: RelationInput, nodeId: string): Relations => {
    const lit = new Set<string>([nodeId]);
    const threads: string[] = [];
    const persona = input.personas.find((card) => personaId(card.id) === nodeId);
    const capability = input.capabilities.find((entry) => capabilityId(entry.id) === nodeId);
    if (persona !== undefined) {
        personaRelations(input, persona, lit, threads);
    } else if (nodeId.startsWith(`area:`) || nodeId === REST_ID) {
        threads.push(...areaRelations(input, input.areas.find((entry) => areaId(entry.id) === nodeId)));
    } else if (capability !== undefined) {
        threads.push(...capabilityRelations(input, capability));
    }
    for (const id of threads) {
        lit.add(id);
    }
    return { lit, threads };
};

/** The principals that reach a node, and how. */
export const holdersOf = (map: ReachMap, nodeId: string): { readonly principal: Principal; readonly how: ReachHow }[] =>
    map.principals.flatMap((principal) => {
        const how = principal.reach.get(nodeId);
        return how === undefined ? [] : [{ principal, how }];
    });

/** How many of a group's nodes a principal reaches. */
export const reachedIn = (principal: Principal, nodes: readonly MapNode[]): number => nodes.filter((node) => principal.reach.has(node.id)).length;

// ---- what a focus lights ----

/** What the reader is pointing at, or has pinned: one principal, or one node. */
export interface Focus {
    readonly kind: `principal` | `node`;
    readonly id: string;
}

/** What stays bright under a focus, and how: everything else on the map dims. */
export interface Lighting {
    readonly principals: ReadonlyMap<string, ReachHow | `self`>;
    readonly nodes: ReadonlyMap<string, ReachHow | `self` | `related`>;
    /** Threads drawn from the focused node to what it is tied to. */
    readonly threads: readonly string[];
}

export const lightingOf = (map: ReachMap, input: RelationInput, focus: Focus): Lighting => {
    if (focus.kind === `principal`) {
        const principal = map.principals.find((entry) => entry.id === focus.id);
        return { principals: new Map([[focus.id, `self`]]), nodes: principal?.reach ?? new Map(), threads: [] };
    }
    const { lit, threads } = relationsOf(input, focus.id);
    const nodes = new Map<string, ReachHow | `self` | `related`>([...lit].map((id) => [id, id === focus.id ? `self` : `related`]));
    return { principals: new Map(holdersOf(map, focus.id).map(({ principal, how }) => [principal.id, how])), nodes, threads };
};
