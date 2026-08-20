import type { Persona, PersonaPowers } from "@intentic/sandbox-contract";

/* WHAT EVERY SURFACE THAT WRITES A PERSONA CARD HAS TO AGREE ABOUT, the id a name becomes, what "everything is
 * on" looks like as a form, which of those answers is worth committing, and which cards belong to a folder.
 *
 * There are two such surfaces now: the full editor on the Personas page, and the quick panel behind a directory
 * row's persona icon in the Workspace tree. They ask different numbers of questions on purpose, the point of the
 * second one is that it asks for a name and nothing else, and that is exactly the shape that drifts. A second
 * copy of the slug rule renames nobody until someone types a capital letter; a second copy of "what is worth
 * storing" writes ten fields meaning "yes" into a tracked file the other surface deliberately leaves empty.
 *
 * Its own module rather than a corner of usePersonas: everything here is a pure function of a card, so a suite
 * driving either surface can use the real thing instead of stubbing the query composable to reach it. */

/** One connected thing a persona can be granted or denied, in the words the Capabilities page uses. */
export interface PersonaGrantable {
    id: string;
    kind: `cli` | `host` | `mcp`;
    label: string;
}

/* WHICH OF THIS SANDBOX'S CAPABILITIES A CARD MAY GRANT BY ID, the connectors whose credentials reach the shell,
 * the computers the agent can drive, and the MCP connections it can call.
 *
 * Kinds the card has no opinion about (the agent runtimes, the platform entries) are deliberately absent: a
 * persona that could switch off the runtime serving its own turn is a card that can only confuse. Read from the
 * same capability list the accounts come from, so a card can never offer a grant for something this sandbox does
 * not have. */
const GRANTABLE_KINDS = new Set([`cli`, `host`, `mcp`]);
export const grantablesFrom = (capabilities: readonly { id: string; kind: string }[]): PersonaGrantable[] =>
    capabilities
        .filter((capability) => GRANTABLE_KINDS.has(capability.kind))
        .map((capability) => ({ id: capability.id, kind: capability.kind as PersonaGrantable[`kind`], label: capability.id }));

/* The powers half of a draft, held flat and always fully populated, a form with tri-state fields is a form with
 * three ways to render every row. `storedPowers` folds it back into the shape the card commits. */
export interface PersonaPowersDraft {
    files: `none` | `read` | `write`;
    shell: boolean;
    code: boolean;
    web: boolean;
    browser: boolean;
    delegate: boolean;
    sandbox: boolean;
    /* Per-id grants. `undefined` means every one of them, including any connected tomorrow, which is a real
     * answer and the default, and the reason these are not just arrays. */
    connectors: string[] | undefined;
    computers: string[] | undefined;
    mcp: string[] | undefined;
}

/* A card with no `powers` means the full toolbox, so a NEW draft opens with every shelf on, the form is then the
 * same shape whether it was opened on a card that has never thought about powers or one that has, and
 * "everything, until you turn something off" is a sentence the form can state rather than imply. */
export const FULL_POWERS: PersonaPowersDraft = {
    files: `write`,
    shell: true,
    code: true,
    web: true,
    browser: true,
    delegate: true,
    sandbox: true,
    connectors: undefined,
    computers: undefined,
    mcp: undefined,
};

/* The id comes from the name so nobody types one, and once a card exists it is FROZEN: automations pin to the id,
 * and a rename that silently re-keyed the card would unpin them without saying so. Renaming the label is therefore
 * free, and the id it was created under is what it keeps. */
export const personaSlug = (name: string): string =>
    name
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, `-`)
        .replace(/^-+|-+$/g, ``)
        .slice(0, 60);

/* An existing card's powers as a draft, field by field rather than a spread, so a card written by a newer build
 * cannot put a shape the form does not understand into a draft it is about to save back. */
export const powersDraftOf = (persona: Persona): PersonaPowersDraft => ({
    files: persona.powers?.files ?? FULL_POWERS.files,
    shell: persona.powers?.shell ?? FULL_POWERS.shell,
    code: persona.powers?.code ?? FULL_POWERS.code,
    web: persona.powers?.web ?? FULL_POWERS.web,
    browser: persona.powers?.browser ?? FULL_POWERS.browser,
    delegate: persona.powers?.delegate ?? FULL_POWERS.delegate,
    sandbox: persona.powers?.sandbox ?? FULL_POWERS.sandbox,
    connectors: persona.powers?.connectors === undefined ? undefined : [...persona.powers.connectors],
    computers: persona.powers?.computers === undefined ? undefined : [...persona.powers.computers],
    mcp: persona.powers?.mcp === undefined ? undefined : [...persona.powers.mcp],
});

/* WHAT IS WORTH STORING. A card that grants everything stores no `powers` at all, so the committed file stays a
 * description of the DECISIONS somebody made rather than a dump of every default, and a diff on it reads as the
 * change it was. `undefined` here means "leave the block off the card". */
export const storedPowers = (draft: PersonaPowersDraft): PersonaPowers | undefined => {
    const bounded =
        draft.files !== `write` ||
        !draft.shell ||
        !draft.code ||
        !draft.web ||
        !draft.browser ||
        !draft.delegate ||
        !draft.sandbox ||
        draft.connectors !== undefined ||
        draft.computers !== undefined ||
        draft.mcp !== undefined;
    if (!bounded) {
        return undefined;
    }
    return {
        files: draft.files,
        shell: draft.shell,
        code: draft.code,
        web: draft.web,
        browser: draft.browser,
        delegate: draft.delegate,
        sandbox: draft.sandbox,
        ...(draft.connectors !== undefined ? { connectors: draft.connectors } : {}),
        ...(draft.computers !== undefined ? { computers: draft.computers } : {}),
        ...(draft.mcp !== undefined ? { mcp: draft.mcp } : {}),
    };
};

/* WHICH CARDS BELONG TO A FOLDER, the ones that START there, and pointedly not the ones that merely prefer it
 * (`repos`, a chat-default preference). A folder can hold several: "Docs bot" and "Refactor crew" can both begin
 * in the same repo with different bounds, which is why the tree's icon opens a list rather than one card.
 *
 * Matched exactly rather than by prefix. A persona starting in `intentic/_editor` is not a persona of
 * `intentic`, putting it on the parent's row too would make every ancestor claim work it does not do. */
export const personasStartingIn = (personas: readonly Persona[], dir: string): Persona[] =>
    personas.filter((persona) => persona.workspace?.startIn === dir);

/* How many cards start in each folder, for the tree, one pass, because the row actions ask per visible row and a
 * filter across every persona on each of them is the same answer computed fifty times. */
export const personaStartDirs = (personas: readonly Persona[]): Map<string, number> => {
    const counts = new Map<string, number>();
    for (const persona of personas) {
        const dir = persona.workspace?.startIn;
        if (dir !== undefined && dir !== ``) {
            counts.set(dir, (counts.get(dir) ?? 0) + 1);
        }
    }
    return counts;
};
