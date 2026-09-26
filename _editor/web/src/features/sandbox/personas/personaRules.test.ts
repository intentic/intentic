import type { Persona } from "@intentic/sandbox-contract";
import { extensionGrantablesFrom, FULL_POWERS, personaSlug, personaStartDirs, personasStartingIn, powersDraftOf, storedPowers } from "./personaRules";

// Rules shared by both persona-card surfaces: an id differing by a hyphen upserts a different persona, and a powers
// block should only be written once some shelf is off.

describe(`personaSlug`, () => {
    it(`turns a typed name into the id it will be committed under`, () => {
        expect(personaSlug(`Refactor Crew`)).toBe(`refactor-crew`);
        expect(personaSlug(`  Docs & notes  `)).toBe(`docs-notes`);
    });

    it(`has no id for a name with nothing to slug`, () => {
        expect(personaSlug(`!!!`)).toBe(``);
    });
});

describe(`storedPowers`, () => {
    it(`stores nothing for a persona that grants everything`, () => {
        expect(storedPowers(FULL_POWERS)).toBeUndefined();
    });

    it(`stores the whole block once any one shelf is off`, () => {
        expect(storedPowers({ ...FULL_POWERS, shell: false })).toMatchObject({ files: `write`, shell: false, web: true });
    });

    // An empty array grants none; a present list bounds it; only an absent field means "all, including new ones".
    it(`treats a materialised grant list as a bound, and keeps an empty one`, () => {
        expect(storedPowers({ ...FULL_POWERS, devices: [] })).toMatchObject({ devices: [] });
        expect(storedPowers({ ...FULL_POWERS, connectors: [`github`] })).toMatchObject({ connectors: [`github`] });
    });

    // Omit an all-granted group rather than listing today's ids; a written-out list would exclude anything added later.
    it(`leaves an all-granted group off the stored block`, () => {
        const stored = storedPowers({ ...FULL_POWERS, web: false });
        expect(stored).not.toHaveProperty(`connectors`);
        expect(stored).not.toHaveProperty(`mcp`);
    });
});

describe(`powersDraftOf`, () => {
    it(`opens a persona with no powers as everything on`, () => {
        expect(powersDraftOf({ id: `work`, capabilities: [] })).toEqual(FULL_POWERS);
    });

    it(`round-trips a bounded persona through the form unchanged`, () => {
        const persona: Persona = {
            id: `visitor`,
            capabilities: [],
            powers: { files: `read`, shell: false, code: false, web: true, browser: true, delegate: false, sandbox: false, devices: [] },
        };
        expect(storedPowers(powersDraftOf(persona))).toEqual(persona.powers);
    });

    // A save must carry the bound list through rather than widen it back to every extension.
    it(`keeps an extensions bound through a save`, () => {
        const persona: Persona = {
            id: `narrow`,
            capabilities: [],
            powers: { files: `write`, shell: true, code: true, web: true, browser: true, delegate: true, sandbox: true, extensions: [`acme.notes`] },
        };
        expect(storedPowers(powersDraftOf(persona))).toEqual(persona.powers);
        expect(storedPowers({ ...FULL_POWERS, extensions: [] })).toMatchObject({ extensions: [] });
    });
});

describe(`personasStartingIn`, () => {
    const personas: Persona[] = [
        { id: `docs`, capabilities: [], workspace: { startIn: `intentic/_editor` } },
        { id: `refactor`, capabilities: [], workspace: { startIn: `intentic/_editor` } },
        { id: `deep`, capabilities: [], workspace: { startIn: `intentic/_editor/web` } },
        { id: `carries`, capabilities: [], context: { repos: [`intentic/_editor`] } },
        { id: `anywhere`, capabilities: [] },
    ];

    it(`finds every persona that starts in the folder`, () => {
        expect(personasStartingIn(personas, `intentic/_editor`).map((persona) => persona.id)).toEqual([`docs`, `refactor`]);
    });

    // Exact match only: a subfolder's persona, or one that only carries this repo via `context.repos`, is not this
    // folder's.
    it(`claims neither a subfolder's persona nor one that only carries the repo`, () => {
        const found = personasStartingIn(personas, `intentic/_editor`).map((persona) => persona.id);
        expect(found).not.toContain(`deep`);
        expect(found).not.toContain(`carries`);
    });

    it(`counts the personas per folder in one pass, ignoring the rootless ones`, () => {
        expect(personaStartDirs(personas)).toEqual(
            new Map([
                [`intentic/_editor`, 2],
                [`intentic/_editor/web`, 1],
            ]),
        );
    });
});

describe(`extensionGrantablesFrom`, () => {
    // What an absent list grants is every switched-on extension, so a switched-off one is nothing to pick.
    it(`offers each switched-on extension by its stable id, named as the Extensions tab names it`, () => {
        const extension = (id: string, name: string, enabled: boolean) => ({ id, enabled, manifest: { name } });
        expect(extensionGrantablesFrom([extension(`acme.notes`, `notes`, true), extension(`acme.off`, `off`, false)])).toEqual([
            { id: `acme.notes`, kind: `extension`, label: `notes`, detail: `acme.notes` },
        ]);
    });
});
