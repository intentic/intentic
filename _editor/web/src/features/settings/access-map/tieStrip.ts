import { REACH_DEVICE_GRANTS, type ReachDeviceGrant } from "@intentic/sandbox-contract/schemas/sandbox-reach";
import type { IconName } from "@intentic/ui/icons";
import type { GraphEdge } from "./accountGraph";

// WHAT ONE TIE LETS ITS HOLDER DO, AS A ROW OF GLYPHS. Drawn where the tie lands (on the computer, the server or the
// sandbox it reaches) and in the list beside its name, so the reader compares rows by shape instead of reading a clause
// per switch. Every switch keeps its place whether it is on or off, so two computers with the same grant draw the same
// row and the one switch a third lacks shows as a gap in the same place. Pure and language-free: the words for each
// glyph are the view's (accessMapWords.ts).

/** One switch's place in the row: its glyph, and whether it is on. */
export interface StripSlot {
    readonly key: string;
    readonly icon: IconName;
    readonly on: boolean;
}

/** `agents`: what the sandbox's agents may do on a computer. `people`: what people may do to it from the editor.
 *  `link`: what one sandbox may do in another. */
export type StripGroupKey = `agents` | `people` | `link`;

export interface StripGroup {
    readonly key: StripGroupKey;
    readonly slots: readonly StripSlot[];
}

/** A name the tie carries that no glyph can say: the role a link's tasks wear, the service they act as, the account a
 *  server is signed in to as. */
export interface StripName {
    readonly key: `role` | `runAs` | `user`;
    readonly icon: IconName;
    readonly name: string;
}

export interface TieStrip {
    readonly groups: readonly StripGroup[];
    readonly names: readonly StripName[];
    /** A server card that holds an admin password its agents may type. */
    readonly admin: boolean;
    /** A link whose far side last said no, or did not answer. */
    readonly answer?: `revoked` | `silent` | undefined;
    /** Other people whose own agents may use it too. */
    readonly others: number;
    /** The reader's own conversations may use it; drawn fainter when not, as its line is. */
    readonly yours: boolean;
}

// Partial, so a switch the contract gains before it has a glyph here is still drawn, as a plug, in its place.
const DEVICE_GLYPHS = {
    shell: `terminal`,
    write: `pencil`,
    screen: `screen`,
    control: `pointer`,
    sandboxes: `boxes`,
    destructive: `trash`,
    programs: `play`,
    remoteView: `eye`,
    remoteControl: `pointer`,
    remoteTerminal: `terminal`,
} as const satisfies Partial<Record<ReachDeviceGrant, IconName>>;
const hasGlyph = (grant: string): grant is keyof typeof DEVICE_GLYPHS => Object.hasOwn(DEVICE_GLYPHS, grant);
const glyphOf = (grant: string): IconName => (hasGlyph(grant) ? DEVICE_GLYPHS[grant] : `plug`);

const PEOPLE: ReadonlySet<ReachDeviceGrant> = new Set([`remoteView`, `remoteControl`, `remoteTerminal`]);
const KNOWN: ReadonlySet<string> = new Set(REACH_DEVICE_GRANTS);

const LINK_GLYPHS = { tasks: `send`, records: `book`, operate: `terminal`, approve: `lock` } as const satisfies Record<string, IconName>;
type LinkSlot = keyof typeof LINK_GLYPHS;
const LINK_SLOTS: readonly LinkSlot[] = [`tasks`, `records`, `operate`, `approve`];

const deviceGroups = (grants: readonly string[]): StripGroup[] => {
    const on = new Set(grants);
    const slot = (grant: ReachDeviceGrant): StripSlot => ({ key: grant, icon: glyphOf(grant), on: on.has(grant) });
    // A switch a newer daemon added has no glyph here yet: it is still said, after the ones this build knows.
    const unknown = grants.filter((grant) => !KNOWN.has(grant)).map((grant): StripSlot => ({ key: grant, icon: `plug`, on: true }));
    return [
        { key: `agents`, slots: [...REACH_DEVICE_GRANTS.filter((grant) => !PEOPLE.has(grant)).map(slot), ...unknown] },
        { key: `people`, slots: REACH_DEVICE_GRANTS.filter((grant) => PEOPLE.has(grant)).map(slot) },
    ];
};

const linkStrip = (edge: GraphEdge): Pick<TieStrip, `groups` | `names` | `answer`> => {
    const terms = edge.terms;
    const answer = edge.answer === `revoked` || edge.answer === `silent` ? edge.answer : undefined;
    if (terms === undefined) {
        return { groups: [], names: [], answer };
    }
    return {
        groups: [{ key: `link`, slots: LINK_SLOTS.map((key) => ({ key, icon: LINK_GLYPHS[key], on: terms[key] })) }],
        names: [
            ...(terms.role === undefined ? [] : [{ key: `role` as const, icon: `user` as const, name: terms.role }]),
            ...(terms.runAs === undefined ? [] : [{ key: `runAs` as const, icon: `key` as const, name: terms.runAs }]),
        ],
        answer,
    };
};

/** The row a tie draws, or undefined for a tie that grants nothing to draw (the account's way in, where a sandbox runs). */
export const stripOf = (edge: GraphEdge): TieStrip | undefined => {
    const base = { others: edge.others ?? 0, yours: edge.yours };
    switch (edge.kind) {
        case `device`:
            return { ...base, groups: deviceGroups(edge.grants ?? []), names: [], admin: false };
        case `server`:
            return { ...base, groups: [], names: edge.user === undefined ? [] : [{ key: `user`, icon: `user`, name: edge.user }], admin: edge.admin === true };
        case `link`:
            return { ...base, ...linkStrip(edge), admin: false };
        default:
            return undefined;
    }
};

/** The ties that land on one thing on the map and carry a row: what reaches a computer or a server, and the links into a
 *  sandbox. A tie's row is drawn where it lands, the end its arrow points at. */
export const landingTies = (edges: readonly GraphEdge[], id: string): GraphEdge[] =>
    edges.filter((edge) => edge.to === id && (edge.kind === `device` || edge.kind === `server` || edge.kind === `link`));
