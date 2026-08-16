import type { Persona } from "@intentic/sandbox-contract";
import { expect, it } from "vitest";
import { reachOf, reachSentence } from "./personaReach";

/* The lens is arithmetic on paths, and every one of these is a way it could be wrong on a real workspace — a
 * fence that greys out the road to its own folder, a prefix that isn't a folder, a card with no fence at all.
 * The daemon enforces the same rule in persona-scope.ts; these are the cases where a string-prefix version of
 * it and a segment-aware one disagree. */

const card = (workspace?: Persona[`workspace`], powers?: Persona[`powers`]): Persona => ({
    id: `test`,
    capabilities: [],
    ...(workspace !== undefined ? { workspace } : {}),
    ...(powers !== undefined ? { powers } : {}),
});

it(`refuses nothing for a card with no fence`, () => {
    const reach = reachOf(card());
    expect(reach.refuses(`anything/at/all`)).toBe(false);
    expect(reachSentence(`test`, reach)).toContain(`works anywhere in the workspace`);
});

it(`refuses everything outside the folders it names`, () => {
    const reach = reachOf(card({ folders: [`docs`] }));
    expect(reach.refuses(`docs`)).toBe(false);
    expect(reach.refuses(`docs/guide.md`)).toBe(false);
    expect(reach.refuses(`apps`)).toBe(true);
});

/* THE ONE THAT MAKES THE LENS USABLE. A card fenced to `intentic/_editor` must not grey out `intentic` — that
 * is the only road to the one folder it CAN use, and a dimmed road reads as "nothing for you down there". */
it(`keeps a folder on the way to a reachable one lit`, () => {
    const reach = reachOf(card({ folders: [`intentic/_editor`] }));
    expect(reach.refuses(`intentic`)).toBe(false);
    expect(reach.refuses(`intentic/_editor`)).toBe(false);
    expect(reach.refuses(`intentic/_sandbox`)).toBe(true);
});

// A sibling that merely starts with the same letters is NOT inside it — the bug a string prefix would ship.
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
    expect(reachSentence(`test`, reach)).toContain(`no file access`);
});

it(`names the folders it is fenced to, in a sentence`, () => {
    expect(reachSentence(`Docs bot`, reachOf(card({ folders: [`docs`, `apps/web`] })))).toBe(
        `Viewing as Docs bot — it works in docs, apps/web. Dimmed folders are refused to its file tools; you can still open them.`,
    );
});
