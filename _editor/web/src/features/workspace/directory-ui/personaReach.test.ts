import type { Persona } from "@intentic/sandbox-contract";
import { lensPersonaId, lensRefuses, reachOf, reachTip } from "./personaReach";

/* The lens is arithmetic on paths, and every one of these is a way it could be wrong on a real workspace: a fence that greys out the road to its own folder. */

const card = (workspace?: Persona[`workspace`], powers?: Persona[`powers`]): Persona => ({
    id: `test`,
    capabilities: [],
    ...(workspace !== undefined ? { workspace } : {}),
    ...(powers !== undefined ? { powers } : {}),
});

it(`refuses nothing for a card with no fence`, () => {
    const reach = reachOf(card());
    expect(reach.refuses(`anything/at/all`)).toBe(false);
    const open = reachTip(`test`, reach);
    expect(open.rows).toContainEqual({ label: `Persona`, value: `test` });
    expect(open).not.toEqual(reachTip(`test`, reachOf(card({ folders: [`docs`] }))));
});

it(`refuses everything outside the folders it names`, () => {
    const reach = reachOf(card({ folders: [`docs`] }));
    expect(reach.refuses(`docs`)).toBe(false);
    expect(reach.refuses(`docs/guide.md`)).toBe(false);
    expect(reach.refuses(`apps`)).toBe(true);
});

/* THE ONE THAT MAKES THE LENS USABLE. */
it(`keeps a folder on the way to a reachable one lit`, () => {
    const reach = reachOf(card({ folders: [`intentic/_editor`] }));
    expect(reach.refuses(`intentic`)).toBe(false);
    expect(reach.refuses(`intentic/_editor`)).toBe(false);
    expect(reach.refuses(`intentic/_sandbox`)).toBe(true);
});

// A sibling that merely starts with the same letters is NOT inside it: the bug a string prefix would ship.
it(`does not read a same-prefix sibling as being inside the fence`, () => {
    const reach = reachOf(card({ folders: [`apps/web`] }));
    expect(reach.refuses(`apps/web`)).toBe(false);
    expect(reach.refuses(`apps/web2`)).toBe(true);
    expect(reach.refuses(`apps/web2/src`)).toBe(true);
});

// File access `none` outranks the fence: a card that cannot read reaches nothing, however generous its folders.
it(`refuses everything for a card with no file access`, () => {
    const reach = reachOf(
        card({ folders: [`docs`] }, { files: `none`, shell: true, code: true, web: true, browser: true, delegate: true, sandbox: true }),
    );
    expect(reach.refuses(`docs`)).toBe(true);
    const blocked = reachTip(`test`, reach);
    expect(blocked.rows).toContainEqual({ label: `Persona`, value: `test` });
    expect(blocked.tone).toBe(`warning`);
    expect(blocked).not.toEqual(reachTip(`test`, reachOf(card({ folders: [`docs`] }))));
});

it(`names the folders it is fenced to, as the card's figures`, () => {
    const name = `Docs bot`;
    const folders = [`docs`, `apps/web`] as const;
    const tip = reachTip(name, reachOf(card({ folders: [...folders] })));
    expect(tip.rows).toEqual([
        { label: `Persona`, value: name },
        { label: `Folders`, value: folders.join(`, `) },
    ]);
});

it(`dims through the lens only while a persona is read as, and only what its fence refuses`, () => {
    const personas = [{ ...card({ folders: [`src`] }), id: `web` }];
    expect([lensRefuses(personas, `README.md`), lensRefuses(personas, `src/main.ts`)]).toEqual([false, false]);

    lensPersonaId.value = `web`;
    expect([lensRefuses(personas, `README.md`), lensRefuses(personas, `src/main.ts`), lensRefuses(personas, `src`)]).toEqual([true, false, false]);
    lensPersonaId.value = undefined;
});
