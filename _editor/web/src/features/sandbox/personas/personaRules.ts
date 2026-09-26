import type { Persona, PersonaPowers, TurnBriefingNoteId } from "@intentic/sandbox-contract";

// Rules shared by both persona-card surfaces (the full editor and the workspace tree's quick panel): the id a name
// becomes, the default "everything on" powers, what is worth committing, and folder membership. Pure functions,
// independent of usePersonas.

/** One connected thing a persona can be granted or denied, in the words the Capabilities page uses. */
export interface PersonaGrantable {
    id: string;
    kind: `cli` | `device` | `mcp`;
    label: string;
}

// Grantable kinds: cli, host, mcp. Agent-runtime and platform kinds are excluded so a persona cannot disable the
// runtime serving its own turn.
const GRANTABLE_KINDS = new Set([`cli`, `device`, `mcp`]);
export const grantablesFrom = (capabilities: readonly { id: string; kind: string }[]): PersonaGrantable[] =>
    capabilities
        .filter((capability) => GRANTABLE_KINDS.has(capability.kind))
        .map((capability) => ({ id: capability.id, kind: capability.kind as PersonaGrantable[`kind`], label: capability.id }));

// Flat, always-populated draft of a persona's powers; `storedPowers` folds this back into the committed shape.
export interface PersonaPowersDraft {
    files: `none` | `read` | `write`;
    shell: boolean;
    code: boolean;
    web: boolean;
    browser: boolean;
    delegate: boolean;
    sandbox: boolean;
    // `undefined` means every id, including ones connected later; a bounding array is a deliberate subset.
    connectors: string[] | undefined;
    devices: string[] | undefined;
    mcp: string[] | undefined;
    // Extension ids whose own tools and agent plugin the persona gets. Not drawn by the form yet; carried so a save
    // keeps a bound set through the API rather than widening it back to every extension.
    extensions: string[] | undefined;
}

// Default draft when a persona has no `powers`: every shelf on.
export const FULL_POWERS: PersonaPowersDraft = {
    files: `write`,
    shell: true,
    code: true,
    web: true,
    browser: true,
    delegate: true,
    sandbox: true,
    connectors: undefined,
    devices: undefined,
    mcp: undefined,
    extensions: undefined,
};

// The id is derived from the name once, at creation, then frozen: automations pin to it, and renaming the label
// later does not change it.
export const personaSlug = (name: string): string =>
    name
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, `-`)
        .replace(/^-+|-+$/g, ``)
        .slice(0, 60);

// A bounding list copied so the form's edits never reach the persona; `undefined` (every id) stays undefined.
const copiedIds = (ids: readonly string[] | undefined): string[] | undefined => (ids === undefined ? undefined : [...ids]);

// Copies field by field, not via spread, so an unknown field from a newer persona shape cannot leak into the draft.
export const powersDraftOf = (persona: Persona): PersonaPowersDraft => {
    const powers = persona.powers;
    if (powers === undefined) {
        return { ...FULL_POWERS };
    }
    return {
        files: powers.files ?? FULL_POWERS.files,
        shell: powers.shell ?? FULL_POWERS.shell,
        code: powers.code ?? FULL_POWERS.code,
        web: powers.web ?? FULL_POWERS.web,
        browser: powers.browser ?? FULL_POWERS.browser,
        delegate: powers.delegate ?? FULL_POWERS.delegate,
        sandbox: powers.sandbox ?? FULL_POWERS.sandbox,
        connectors: copiedIds(powers.connectors),
        devices: copiedIds(powers.devices),
        mcp: copiedIds(powers.mcp),
        extensions: copiedIds(powers.extensions),
    };
};

// Which preamble notes a persona drops, as a list the form can splice; empty covers both "drops none" and a persona written
// before the question existed.
export const omittedNotesOf = (persona: Persona): TurnBriefingNoteId[] => [...(persona.briefing?.omit ?? [])];

// A fully-granted persona stores no `powers` block at all; `undefined` here means omit it from the persona.
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
        draft.devices !== undefined ||
        draft.mcp !== undefined ||
        draft.extensions !== undefined;
    if (!bounded) {
        return undefined;
    }
    const stored: PersonaPowers = {
        files: draft.files,
        shell: draft.shell,
        code: draft.code,
        web: draft.web,
        browser: draft.browser,
        delegate: draft.delegate,
        sandbox: draft.sandbox,
    };
    // Each list only when bounding: an absent key is "every id", which an explicit `undefined` would not round-trip as.
    if (draft.connectors !== undefined) {
        stored.connectors = draft.connectors;
    }
    if (draft.devices !== undefined) {
        stored.devices = draft.devices;
    }
    if (draft.mcp !== undefined) {
        stored.mcp = draft.mcp;
    }
    if (draft.extensions !== undefined) {
        stored.extensions = draft.extensions;
    }
    return stored;
};

// Personas whose `workspace.startIn` matches `dir` exactly; a persona that only carries the repo via `context.repos`
// does not count, nor does a subfolder's persona.
export const personasStartingIn = (personas: readonly Persona[], dir: string): Persona[] =>
    personas.filter((persona) => persona.workspace?.startIn === dir);

// Counts personas per `startIn` folder in one pass, for the tree to query per row without refiltering every persona.
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
