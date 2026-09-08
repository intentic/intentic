import type { Persona, PersonaPowers } from "@intentic/sandbox-contract";

// Rules shared by both persona-card surfaces (the full editor and the workspace tree's quick panel): the id a name
// becomes, the default "everything on" powers, what is worth committing, and folder membership. Pure functions,
// independent of usePersonas.

/** One connected thing a persona can be granted or denied, in the words the Capabilities page uses. */
export interface PersonaGrantable {
    id: string;
    kind: `cli` | `host` | `mcp`;
    label: string;
}

// Grantable kinds: cli, host, mcp. Agent-runtime and platform kinds are excluded so a persona cannot disable the
// runtime serving its own turn.
const GRANTABLE_KINDS = new Set([`cli`, `host`, `mcp`]);
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
}

// Default draft when a card has no `powers`: every shelf on.
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
};

// The id is derived from the name once, at creation, then frozen: automations pin to it, and renaming the label
// later does not change it.
export const personaSlug = (name: string): string =>
    name
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, `-`)
        .replace(/^-+|-+$/g, ``)
        .slice(0, 60);

// Copies field by field, not via spread, so an unknown field from a newer card shape cannot leak into the draft.
export const powersDraftOf = (persona: Persona): PersonaPowersDraft => ({
    files: persona.powers?.files ?? FULL_POWERS.files,
    shell: persona.powers?.shell ?? FULL_POWERS.shell,
    code: persona.powers?.code ?? FULL_POWERS.code,
    web: persona.powers?.web ?? FULL_POWERS.web,
    browser: persona.powers?.browser ?? FULL_POWERS.browser,
    delegate: persona.powers?.delegate ?? FULL_POWERS.delegate,
    sandbox: persona.powers?.sandbox ?? FULL_POWERS.sandbox,
    connectors: persona.powers?.connectors === undefined ? undefined : [...persona.powers.connectors],
    devices: persona.powers?.devices === undefined ? undefined : [...persona.powers.devices],
    mcp: persona.powers?.mcp === undefined ? undefined : [...persona.powers.mcp],
});

// A fully-granted card stores no `powers` block at all; `undefined` here means omit it from the card.
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
        ...(draft.devices !== undefined ? { devices: draft.devices } : {}),
        ...(draft.mcp !== undefined ? { mcp: draft.mcp } : {}),
    };
};

// Cards whose `workspace.startIn` matches `dir` exactly; a card that only carries the repo via `context.repos`
// does not count, nor does a subfolder's card.
export const personasStartingIn = (personas: readonly Persona[], dir: string): Persona[] =>
    personas.filter((persona) => persona.workspace?.startIn === dir);

// Counts cards per `startIn` folder in one pass, for the tree to query per row without refiltering every persona.
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
