import type { Persona } from "@intentic/sandbox-contract";
import { describe, expect, it } from "vitest";
import { FULL_POWERS, personaSlug, personaStartDirs, personasStartingIn, powersDraftOf, storedPowers } from "./personaCard";

/* The rules two surfaces now share. Each of these is a thing that silently does the WRONG thing when the copies
 * drift rather than failing loudly: an id that differs by a hyphen upserts a different card, and a powers block
 * written where none was needed puts ten fields meaning "yes" into a tracked file. */

describe(`personaSlug`, () => {
    it(`turns a typed name into the id it will be committed under`, () => {
        expect(personaSlug(`Refactor Crew`)).toBe(`refactor-crew`);
        expect(personaSlug(`  Docs & notes  `)).toBe(`docs-notes`);
    });

    // A name made only of punctuation has no id, which is what makes the form's "use letters or digits" the
    // check that stops a save rather than a warning beside one.
    it(`has no id for a name with nothing to slug`, () => {
        expect(personaSlug(`!!!`)).toBe(``);
    });
});

describe(`storedPowers`, () => {
    /* THE COMMITTED FILE IS A RECORD OF DECISIONS. A card nobody has bounded must store no powers at all:
     * otherwise the diff on a card someone DID bound is buried in noise on every other card. */
    it(`stores nothing for a card that grants everything`, () => {
        expect(storedPowers(FULL_POWERS)).toBeUndefined();
    });

    it(`stores the whole block once any one shelf is off`, () => {
        expect(storedPowers({ ...FULL_POWERS, shell: false })).toMatchObject({ files: `write`, shell: false, web: true });
    });

    /* The tri-state is the reason these are optional rather than defaulted arrays: "all of them, including new
     * ones" and "none of them" are both real answers, and only the second is a list. */
    it(`treats a materialised grant list as a bound, and keeps an empty one`, () => {
        expect(storedPowers({ ...FULL_POWERS, computers: [] })).toMatchObject({ computers: [] });
        expect(storedPowers({ ...FULL_POWERS, connectors: [`github`] })).toMatchObject({ connectors: [`github`] });
    });

    // An untouched group must not appear at all: a written-out list of today's ids would silently drop whatever
    // is connected tomorrow.
    it(`leaves an all-granted group off the stored block`, () => {
        const stored = storedPowers({ ...FULL_POWERS, web: false });
        expect(stored).not.toHaveProperty(`connectors`);
        expect(stored).not.toHaveProperty(`mcp`);
    });
});

describe(`powersDraftOf`, () => {
    // A card written before powers existed opens as the full toolbox, so the form reads the same either way.
    it(`opens a card with no powers as everything on`, () => {
        expect(powersDraftOf({ id: `work`, capabilities: [] })).toEqual(FULL_POWERS);
    });

    it(`round-trips a bounded card through the form unchanged`, () => {
        const card: Persona = {
            id: `visitor`,
            capabilities: [],
            powers: { files: `read`, shell: false, code: false, web: true, browser: true, delegate: false, sandbox: false, computers: [] },
        };
        expect(storedPowers(powersDraftOf(card))).toEqual(card.powers);
    });
});

describe(`personasStartingIn`, () => {
    const cards: Persona[] = [
        { id: `docs`, capabilities: [], workspace: { startIn: `intentic/_editor` } },
        { id: `refactor`, capabilities: [], workspace: { startIn: `intentic/_editor` } },
        { id: `deep`, capabilities: [], workspace: { startIn: `intentic/_editor/web` } },
        { id: `prefers`, capabilities: [], repos: [`intentic/_editor`] },
        { id: `anywhere`, capabilities: [] },
    ];

    // The whole reason the icon opens a list: one folder, several cards with different bounds.
    it(`finds every card that starts in the folder`, () => {
        expect(personasStartingIn(cards, `intentic/_editor`).map((persona) => persona.id)).toEqual([`docs`, `refactor`]);
    });

    /* Matched exactly. A card starting in a subfolder is not this folder's, and a card that merely PREFERS this
     * repo (a chat default) has not been told to start here: claiming either would make the row assert work the
     * card does not do. */
    it(`claims neither a subfolder's card nor one that only prefers the repo`, () => {
        const found = personasStartingIn(cards, `intentic/_editor`).map((persona) => persona.id);
        expect(found).not.toContain(`deep`);
        expect(found).not.toContain(`prefers`);
    });

    it(`counts the cards per folder in one pass, ignoring the rootless ones`, () => {
        expect(personaStartDirs(cards)).toEqual(
            new Map([
                [`intentic/_editor`, 2],
                [`intentic/_editor/web`, 1],
            ]),
        );
    });
});
