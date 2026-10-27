import type {
    AccessClusterKey,
    AccessGroupKey,
    AccessHow,
    AccessMapScene,
    AccessNodeId,
    AccessPersonaId,
    AccessPrincipal,
} from "@intentic/site-content/access-map";

// THE ACCESS MAP'S LIGHTINGS, worked out at build: for each way in, everything it reaches and how; for each thing, who
// reaches it and what it is tied to. `AccessMapFigure.astro` embeds the result, and its script only switches which one
// shows, so the figure's lighting can be read and tested here rather than in a browser.

/** What a lit thing wears: how it is reached, the thing pointed at itself, or a tie to it (a persona's home, its connections). */
export type Lit = AccessHow | "focus" | "tie";
/** A lit wire: solid where the reach is direct, dashed where it is only as a persona. */
export type Wire = "on" | "through";
/** `p:<principal>` a way in's line to the wall, `c:<cluster>` its gate, `g:<group>` a port and the line out to a group. */
export type WireKey = `p:${string}` | `c:${AccessClusterKey}` | `g:${AccessGroupKey}`;

export interface Lighting {
    readonly principals: readonly string[];
    readonly nodes: Partial<Record<AccessNodeId, Lit>>;
    /** The small word a lit room or the vault wears: "edits", "reads", "as Maya". */
    readonly tags: Partial<Record<AccessNodeId, string>>;
    readonly wires: Partial<Record<WireKey, Wire>>;
    /** "2 of 5" beside a group's name, under a way in. */
    readonly counts: Partial<Record<AccessGroupKey, string>>;
}

/** A caption's rows for one thing: who reaches it, grouped by how, strongest first. */
export interface ReachedByRow {
    readonly label: string;
    readonly names: readonly string[];
}

const HOW_ORDER: readonly AccessHow[] = ["edit", "use", "see", "through"];

/** The key a way in's lighting is filed under, apart from the things' own ids. */
export const principalKey = (principal: Pick<AccessPrincipal, "id">): string => `who:${principal.id}`;

/** Every thing on the map, inside the box and out, in the order the drawing stands them. */
export const nodeIdsOf = (scene: AccessMapScene): AccessNodeId[] => [
    ...scene.areas.map((area) => area.id),
    ...scene.personas.map((persona) => persona.id),
    "secrets",
    ...scene.groups.flatMap((group) => group.items.map((item) => item.id)),
];

export const accessLightings = (scene: AccessMapScene): Map<string, Lighting> => {
    const nodeIds = nodeIdsOf(scene);
    const areaIds = new Set<AccessNodeId>(scene.areas.map((area) => area.id));
    const outwardIds = new Set<AccessNodeId>(scene.groups.flatMap((group) => group.items.map((item) => item.id)));
    const personaName = (id: AccessPersonaId | undefined): string | undefined => scene.personas.find((persona) => persona.id === id)?.name;

    // Tagged where the drawing has room for a word: the rooms and the vault.
    const tagFor = (how: AccessHow, actsAs: AccessPersonaId | undefined): string => {
        const persona = how === "through" ? personaName(actsAs) : undefined;
        return persona === undefined ? scene.tags[how] : `as ${persona}`;
    };

    // The lines out of the east wall: one per group something lit stands in, dashed when all of it is reached only as a
    // persona (or, `only`, as the caller says).
    const groupWires = (nodes: Lighting["nodes"], only?: Wire): Map<WireKey, Wire> => {
        const wires = new Map<WireKey, Wire>();
        for (const group of scene.groups) {
            const lit = group.items.map((item) => nodes[item.id]).filter((how) => how !== undefined);
            if (lit.length > 0) {
                wires.set(`g:${group.key}`, only ?? (lit.every((how) => how === "through") ? "through" : "on"));
            }
        }
        return wires;
    };

    // Each lit way in's line to the wall, and its cluster's gate, solid if any line through it is.
    const gateWires = (lit: readonly AccessPrincipal[], wireOf: (principal: AccessPrincipal) => Wire): Map<WireKey, Wire> => {
        const wires = new Map<WireKey, Wire>();
        for (const principal of lit) {
            const wire = wireOf(principal);
            wires.set(`p:${principal.id}`, wire);
            const gate: WireKey = `c:${principal.cluster}`;
            wires.set(gate, wires.get(gate) === "on" || wire === "on" ? "on" : "through");
        }
        return wires;
    };

    // A way in: everything its grant reaches, how.
    const ofPrincipal = (principal: AccessPrincipal): Lighting => {
        const nodes: Lighting["nodes"] = { ...principal.reach };
        const tags = new Map<AccessNodeId, string>();
        for (const id of nodeIds) {
            const how = principal.reach[id];
            if (how !== undefined && (areaIds.has(id) || id === "secrets")) {
                tags.set(id, tagFor(how, principal.actsAs));
            }
        }
        const counts = scene.groups.map(
            (group) => [group.key, `${group.items.filter((item) => nodes[item.id] !== undefined).length} of ${group.items.length}`] as const,
        );
        return {
            principals: [principal.id],
            nodes,
            tags: Object.fromEntries(tags),
            wires: Object.fromEntries([...gateWires([principal], () => "on"), ...groupWires(nodes)]),
            counts: Object.fromEntries(counts),
        };
    };

    // What a thing is tied to: a persona to its home and its connections, an area to the personas homed there, a
    // connection to the personas that carry it.
    const tiesOf = (id: AccessNodeId): AccessNodeId[] => {
        const persona = scene.personas.find((card) => card.id === id);
        if (persona !== undefined) {
            return [persona.home, ...persona.allows];
        }
        if (areaIds.has(id)) {
            return scene.personas.filter((card) => card.home === id).map((card) => card.id);
        }
        return scene.personas.filter((card) => card.allows.some((allowed) => allowed === id)).map((card) => card.id);
    };

    // A thing: who reaches it, and what it is tied to.
    const ofNode = (id: AccessNodeId): Lighting => {
        const reachers = scene.principals.filter((principal) => principal.reach[id] !== undefined);
        const nodes = new Map<AccessNodeId, Lit>([[id, "focus"]]);
        for (const tie of tiesOf(id)) {
            nodes.set(tie, "tie");
        }
        const outward: Lighting["nodes"] = Object.fromEntries([...nodes].filter(([key]) => outwardIds.has(key)));
        return {
            principals: reachers.map((principal) => principal.id),
            nodes: Object.fromEntries(nodes),
            tags: {},
            wires: Object.fromEntries([
                ...gateWires(reachers, (principal) => (principal.reach[id] === "through" ? "through" : "on")),
                // The thing's own group is reached directly; a group lit only by a tie is reached through that persona.
                ...groupWires(outward, outwardIds.has(id) ? "on" : "through"),
            ]),
            counts: {},
        };
    };

    return new Map([
        ...scene.principals.map((principal) => [principalKey(principal), ofPrincipal(principal)] as const),
        ...nodeIds.map((id) => [id, ofNode(id)] as const),
    ]);
};

/** Who reaches one thing, sorted by how, for its caption. */
export const reachedBy = (scene: AccessMapScene, id: AccessNodeId): ReachedByRow[] =>
    HOW_ORDER.map((how) => ({
        label: scene.reachedBy.how[how],
        names: scene.principals.filter((principal) => principal.reach[id] === how).map((principal) => principal.name),
    })).filter((row) => row.names.length > 0);

/** "A", "A and B", "A, B and C": the caption's lists read as a sentence. */
export const listed = (names: readonly string[]): string =>
    names.length <= 1 ? (names[0] ?? "") : `${names.slice(0, -1).join(", ")} and ${names.at(-1) ?? ""}`;
