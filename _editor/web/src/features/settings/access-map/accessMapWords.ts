import type { MemberTier } from "@intentic/sandbox-contract/schemas/shared";
import { timeAgo } from "@intentic/ui/format";
import { t } from "@intentic/ui/i18n";
import type { AccountGraph, Exposure, GraphEdge, GraphMachine, GraphSandbox, ReadState } from "./accountGraph";
import type { Tie } from "./ties";
import type { StripGroupKey, StripName } from "./tieStrip";

// THE ACCESS MAP IN THE READER'S WORDS. Every function reads the language when it is called, so a label follows a change
// of language (docs/architecture/languages.md); none is evaluated at import.

/** A tier in the words the Access page uses for it; a tier this build does not know reads as itself. */
export const tierWord = (tier: MemberTier | undefined): string => {
    switch (tier) {
        case `owner`:
            return t(`sandbox.sandboxAccess.wordOwner`);
        case `maintainer`:
            return t(`sandbox.sandboxAccess.accessFull`);
        case `writer`:
            return t(`sandbox.sandboxAccess.writer`);
        case `collaborator`:
            return t(`sandbox.sandboxAccess.collaborator`);
        case `viewer`:
            return t(`sandbox.sandboxAccess.viewer`);
        case `guest`:
            return t(`sandbox.sandboxAccess.guest`);
        default:
            return tier ?? ``;
    }
};

const ago = (at: number, now: number): string => timeAgo(at, { now, days: true });

/** Under a minute, a read is "just now": "Read now" would read as a press. */
const JUST_NOW_MS = 60_000;

/** When the newest reading was taken, as the line under the title says it. */
export const readWhen = (at: number, now: number): string =>
    now - at < JUST_NOW_MS ? t(`settings.accessMap.readJustNow`) : t(`settings.accessMap.readAgo`, { ago: ago(at, now) });

/** How one sandbox's read stands, as its card says it; undefined while it is freshly read and nothing needs saying. */
export const readWords = (state: ReadState | undefined, readAt: number | undefined, now: number): string | undefined => {
    switch (state) {
        case `asleep`:
            return readAt === undefined ? t(`settings.accessMap.state.asleep`) : t(`settings.accessMap.state.asleepAsOf`, { ago: ago(readAt, now) });
        case `unreachable`:
            return readAt === undefined ? t(`settings.accessMap.state.unreachable`) : t(`settings.accessMap.state.unreachableAsOf`, { ago: ago(readAt, now) });
        case `signin`:
            return t(`settings.accessMap.state.signin`);
        case `old`:
            return t(`settings.accessMap.state.old`);
        case `locked`:
            return t(`settings.accessMap.state.locked`);
        case `reading`:
            return t(`settings.accessMap.reading`);
        case `fresh`:
            return readAt === undefined || now - readAt < JUST_NOW_MS ? undefined : t(`settings.accessMap.state.fresh`, { ago: ago(readAt, now) });
        default:
            return undefined;
    }
};

/** A sandbox's second line on its card: the reader's tier where it is not theirs, and the organisation it is held to. */
export const sandboxLine = (sandbox: GraphSandbox): string =>
    [sandbox.standing === `shared` ? tierWord(sandbox.tier) : undefined, sandbox.org?.name].filter((part) => part !== undefined && part !== ``).join(` · `);

// Each switch's words, as a call so the language is read when it is said and the key stays where the checks can find it.
const GRANT_WORDS = {
    shell: () => t(`settings.accessMap.grant.shell`),
    write: () => t(`settings.accessMap.grant.write`),
    screen: () => t(`settings.accessMap.grant.screen`),
    control: () => t(`settings.accessMap.grant.control`),
    sandboxes: () => t(`settings.accessMap.grant.sandboxes`),
    destructive: () => t(`settings.accessMap.grant.destructive`),
    programs: () => t(`settings.accessMap.grant.programs`),
    remoteView: () => t(`settings.accessMap.grant.remoteView`),
    remoteControl: () => t(`settings.accessMap.grant.remoteControl`),
    remoteTerminal: () => t(`settings.accessMap.grant.remoteTerminal`),
} as const;

const isGrant = (grant: string): grant is keyof typeof GRANT_WORDS => Object.hasOwn(GRANT_WORDS, grant);

/** A device's switches in words; one a newer daemon added reads as its own name. */
const grantWords = (grants: readonly string[]): string[] => grants.map((grant) => (isGrant(grant) ? GRANT_WORDS[grant]() : grant));

// What a link lets its holder do over there, then how: waiting for a yes, the role it wears, whose authority it uses.
const termWords = (edge: GraphEdge): string[] => {
    const terms = edge.terms;
    if (terms === undefined) {
        return [];
    }
    const words = [
        terms.tasks ? t(`settings.accessMap.term.tasks`) : undefined,
        terms.records ? t(`settings.accessMap.term.records`) : undefined,
        terms.operate ? t(`settings.accessMap.term.operate`) : undefined,
    ].filter((word) => word !== undefined);
    return [
        ...(words.length === 0 ? [t(`settings.accessMap.term.none`)] : words),
        ...(terms.approve ? [t(`settings.accessMap.term.approve`)] : []),
        ...(terms.role === undefined ? [] : [t(`settings.accessMap.term.role`, { role: terms.role })]),
        ...(terms.runAs === undefined ? [] : [t(`settings.accessMap.term.runAs`, { service: terms.runAs })]),
    ];
};

/** What one tie lets its holder do, in a few words, most important first. */
const tieDetails = (edge: GraphEdge): string[] => {
    switch (edge.kind) {
        case `link`: {
            const answer = edge.answer === `revoked` ? t(`settings.accessMap.answer.revoked`) : edge.answer === `silent` ? t(`settings.accessMap.answer.silent`) : undefined;
            return [...termWords(edge), ...(answer === undefined ? [] : [answer])];
        }
        case `device`: {
            const grants = grantWords(edge.grants ?? []);
            return grants.length === 0 ? [t(`settings.accessMap.term.none`)] : grants;
        }
        case `server`:
            return [
                ...(edge.user === undefined ? [] : [t(`settings.accessMap.server.as`, { user: edge.user })]),
                ...(edge.admin === true ? [t(`settings.accessMap.server.admin`)] : []),
            ];
        case `member`:
            return [tierWord(edge.tier)];
        default:
            return [];
    }
};

/**
 * Whose tie it is beside the reader: others who can use it too, or that the reader's own conversations cannot. Said of
 * a tie a sandbox drives; work handed in from elsewhere is driven over there, so nothing about the reader is said of it.
 */
const tieWho = (edge: GraphEdge, verb: Tie[`verb`]): string[] => [
    ...(edge.kind !== `member` && edge.kind !== `runs` && verb !== `takesFrom` && !edge.yours ? [t(`settings.accessMap.notYours`)] : []),
    ...((edge.others ?? 0) > 0 ? [t(`settings.accessMap.others`, { count: edge.others }, edge.others ?? 0)] : []),
];

/** What a thing on the map is called. */
export const nodeName = (graph: AccountGraph, id: string): string => {
    if (id === graph.you.id) {
        return t(`settings.accessMap.you`);
    }
    const node = graph.nodes.get(id);
    if (node === undefined) {
        return id;
    }
    return `standing` in node ? node.name : machineName(node);
};

export const machineName = (machine: GraphMachine): string => (machine.kind === `cloud` ? t(`settings.accessMap.cloud`) : machine.label);

const TIE_WORDS = {
    in: (name: string) => name,
    handsTo: (name: string) => t(`settings.accessMap.tie.handsTo`, { name }),
    takesFrom: (name: string) => t(`settings.accessMap.tie.takesFrom`, { name }),
    reaches: (name: string) => t(`settings.accessMap.tie.reaches`, { name }),
    signsIn: (name: string) => t(`settings.accessMap.tie.signsIn`, { name }),
    runsOn: (name: string) => t(`settings.accessMap.tie.runsOn`, { name }),
    reachedFrom: (name: string) => t(`settings.accessMap.tie.reachedFrom`, { name }),
    signedInFrom: (name: string) => t(`settings.accessMap.tie.signedInFrom`, { name }),
    hosts: (name: string) => t(`settings.accessMap.tie.hosts`, { name }),
} as const satisfies Record<Tie[`verb`], (name: string) => string>;

/** A tie's head: "Reaches rog", "Takes work from ops"; the account's own tie is the sandbox's name alone. */
export const tieHead = (graph: AccountGraph, tie: Tie): string => TIE_WORDS[tie.verb](nodeName(graph, tie.other));

/** One exposure as a sentence. */
export const exposureWords = (graph: AccountGraph, exposure: Exposure): string => {
    const sandbox = nodeName(graph, exposure.from);
    const target = nodeName(graph, exposure.to);
    const count = exposure.others ?? 0;
    switch (exposure.kind) {
        case `machine`: {
            const edge = graph.edges.find((candidate) => candidate.id === exposure.edge);
            const what = grantWords(edge?.grants ?? []).join(`, `);
            return t(`settings.accessMap.exposure.machine`, { count, sandbox, target, what }, count);
        }
        case `server`:
            return t(`settings.accessMap.exposure.server`, { count, sandbox, target }, count);
        case `operate`:
            return t(`settings.accessMap.exposure.operate`, { count, sandbox, target }, count);
        case `inbound`:
            return t(`settings.accessMap.exposure.inbound`, { sandbox, target });
        case `fleet`:
            return t(`settings.accessMap.exposure.fleet`, { count, sandbox }, count);
        default:
            return ``;
    }
};

// The glyphs a tie's row draws (tieStrip.ts), each named in a word or two for its tooltip.
const SLOT_WORDS = {
    shell: () => t(`settings.accessMap.glyph.shell`),
    write: () => t(`settings.accessMap.glyph.write`),
    screen: () => t(`settings.accessMap.glyph.screen`),
    control: () => t(`settings.accessMap.glyph.control`),
    sandboxes: () => t(`settings.accessMap.glyph.sandboxes`),
    destructive: () => t(`settings.accessMap.glyph.destructive`),
    programs: () => t(`settings.accessMap.glyph.programs`),
    remoteView: () => t(`settings.accessMap.glyph.remoteView`),
    remoteControl: () => t(`settings.accessMap.glyph.remoteControl`),
    remoteTerminal: () => t(`settings.accessMap.glyph.remoteTerminal`),
    tasks: () => t(`settings.accessMap.glyph.tasks`),
    records: () => t(`settings.accessMap.glyph.records`),
    operate: () => t(`settings.accessMap.glyph.shell`),
    approve: () => t(`settings.accessMap.glyph.approve`),
} as const;

const isSlot = (key: string): key is keyof typeof SLOT_WORDS => Object.hasOwn(SLOT_WORDS, key);

/** One glyph's name; a switch a newer daemon added reads as its own name. */
export const slotLabel = (key: string): string => (isSlot(key) ? SLOT_WORDS[key]() : key);

/** Who a group of glyphs speaks for, said by the mark before it. */
export const groupLabel = (key: StripGroupKey): string | undefined => {
    switch (key) {
        case `agents`:
            return t(`settings.accessMap.glyph.agents`);
        case `people`:
            return t(`settings.accessMap.glyph.people`);
        default:
            return undefined;
    }
};

/** What a name on a row is: the role a link's tasks wear, the service they act as, the account a server signs in as. */
export const stripNameLabel = (key: StripName[`key`]): string => {
    switch (key) {
        case `role`:
            return t(`settings.accessMap.glyph.role`);
        case `runAs`:
            return t(`settings.accessMap.glyph.runAs`);
        default:
            return t(`settings.accessMap.glyph.user`);
    }
};

/** A tie in words, for a screen reader and for the reader who reads rather than points: what it allows, then whose it is. */
export const tieSaid = (edge: GraphEdge, verb: Tie[`verb`]): string => [...tieDetails(edge), ...tieWho(edge, verb)].join(`, `);
