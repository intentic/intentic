import type { Fence } from "@intentic/sandbox-contract/policy/fence-paths";
import { isSignedInAccount } from "@intentic/sandbox-contract/policy/persona-capability";
import { fenceHoldsPersona, personaHome } from "@intentic/sandbox-contract/policy/persona-home";
import type { Area } from "@intentic/sandbox-contract/schemas/areas";
import type { Persona } from "@intentic/sandbox-contract/schemas/personas";
import {
    areaId,
    capabilityId,
    type GroupKey,
    type MapNode,
    overlaps,
    personaAllows,
    personaId,
    type Principal,
    type ReachCapability,
    type ReachHow,
    type ReachInput,
    type ReachMap,
    REST_ID,
    secretId,
    shelvesOf,
} from "./reachModel";

// WHAT A FOCUS LIGHTS ON THE REACH MAP (reachModel.ts builds the map itself): the nodes a node is tied to whoever holds
// it, the principals that reach it, and what stays bright when the reader points at a principal, a node or a block.

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

// A block that stands in for many nodes (a folded group, the box's secrets): its id, and the nodes it holds.
export const bundleId = (key: GroupKey | `secrets`): string => `bundle:${key}`;

const bundleMembers = (map: ReachMap, id: string): readonly MapNode[] =>
    id === bundleId(`secrets`) ? map.secrets : (map.groups.find((group) => bundleId(group.key) === id)?.nodes ?? []);

// The stronger of two ways to reach: acting through a thing beats only reading it, and both beat reaching it as a persona.
const STRENGTH = { edit: 3, use: 3, see: 2, through: 1 } as const satisfies Record<ReachHow, number>;

// Who reaches anything a block holds, each at the strongest way they reach any of it.
const bundleHolders = (map: ReachMap, members: readonly MapNode[]): Map<string, ReachHow> => {
    const holders = new Map<string, ReachHow>();
    for (const principal of map.principals) {
        for (const member of members) {
            const how = principal.reach.get(member.id);
            const held = holders.get(principal.id);
            if (how !== undefined && (held === undefined || STRENGTH[how] > STRENGTH[held])) {
                holders.set(principal.id, how);
            }
        }
    }
    return holders;
};

export const lightingOf = (map: ReachMap, input: RelationInput, focus: Focus): Lighting => {
    if (focus.kind === `principal`) {
        const principal = map.principals.find((entry) => entry.id === focus.id);
        return { principals: new Map([[focus.id, `self`]]), nodes: principal?.reach ?? new Map(), threads: [] };
    }
    if (focus.id.startsWith(`bundle:`)) {
        const members = bundleMembers(map, focus.id);
        const nodes = new Map<string, ReachHow | `self` | `related`>([[focus.id, `self`], ...members.map((member) => [member.id, `related`] as const)]);
        return { principals: bundleHolders(map, members), nodes, threads: [] };
    }
    const { lit, threads } = relationsOf(input, focus.id);
    const nodes = new Map<string, ReachHow | `self` | `related`>([...lit].map((id) => [id, id === focus.id ? `self` : `related`]));
    return { principals: new Map(holdersOf(map, focus.id).map(({ principal, how }) => [principal.id, how])), nodes, threads };
};
