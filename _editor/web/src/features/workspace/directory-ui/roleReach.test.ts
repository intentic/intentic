import type { AccessProfile } from "@intentic/sandbox-contract/schemas/access-profiles";
import { lensRoleId, lensRefuses, type RoleAccess, reachOf, reachTip } from "./roleReach";

/* The lens is arithmetic on paths, and every one of these is a way it could be wrong on a real workspace: a fence that greys out the road to its own folder. */

const card = { id: `test` };
// The card held to a profile fenced to these folders (one area each), with these tools.
const fenced = (folders: readonly string[] | undefined, tools?: AccessProfile[`tools`]): RoleAccess => ({
    profiles: [
        {
            roles: [card.id],
            ...(folders === undefined ? {} : { areas: folders.map((_, at) => `area-${at}`) }),
            ...(tools === undefined ? {} : { tools }),
        },
    ],
    areas: (folders ?? []).map((folder, at) => ({ id: `area-${at}`, folders: [folder] })),
});
const open: RoleAccess = { profiles: [], areas: [] };

it(`refuses nothing for a card no profile fences`, () => {
    const reach = reachOf(card, open);
    expect(reach.refuses(`anything/at/all`)).toBe(false);
    const tip = reachTip(`test`, reach);
    expect(tip.rows).toContainEqual({ label: `Role`, value: `test` });
    expect(tip).not.toEqual(reachTip(`test`, reachOf(card, fenced([`docs`]))));
});

it(`refuses everything outside the areas its profile names`, () => {
    const reach = reachOf(card, fenced([`docs`]));
    expect(reach.refuses(`docs`)).toBe(false);
    expect(reach.refuses(`docs/guide.md`)).toBe(false);
    expect(reach.refuses(`apps`)).toBe(true);
});

it(`reads a profile that lists another card as no fence on this one`, () => {
    const other: RoleAccess = { ...fenced([`docs`]), profiles: [{ roles: [`someone-else`], areas: [`area-0`] }] };
    expect(reachOf(card, other).refuses(`apps`)).toBe(false);
});

/* THE ONE THAT MAKES THE LENS USABLE. */
it(`keeps a folder on the way to a reachable one lit`, () => {
    const reach = reachOf(card, fenced([`intentic/_editor`]));
    expect(reach.refuses(`intentic`)).toBe(false);
    expect(reach.refuses(`intentic/_editor`)).toBe(false);
    expect(reach.refuses(`intentic/_sandbox`)).toBe(true);
});

// A sibling that merely starts with the same letters is NOT inside it: the bug a string prefix would ship.
it(`does not read a same-prefix sibling as being inside the fence`, () => {
    const reach = reachOf(card, fenced([`apps/web`]));
    expect(reach.refuses(`apps/web`)).toBe(false);
    expect(reach.refuses(`apps/web2`)).toBe(true);
    expect(reach.refuses(`apps/web2/src`)).toBe(true);
});

// File access `none` outranks the fence: a card that cannot read reaches nothing, however generous its folders.
it(`refuses everything for a card whose access gives it no file access`, () => {
    const reach = reachOf(card, fenced([`docs`], { files: `none` }));
    expect(reach.refuses(`docs`)).toBe(true);
    const blocked = reachTip(`test`, reach);
    expect(blocked.rows).toContainEqual({ label: `Role`, value: `test` });
    expect(blocked.tone).toBe(`warning`);
    expect(blocked).not.toEqual(reachTip(`test`, reachOf(card, fenced([`docs`]))));
});

it(`names the folders it is fenced to, as the card's figures`, () => {
    const name = `Docs bot`;
    const folders = [`docs`, `apps/web`] as const;
    const tip = reachTip(name, reachOf(card, fenced([...folders])));
    expect(tip.rows).toEqual([
        { label: `Role`, value: name },
        { label: `Folders`, value: folders.join(`, `) },
    ]);
});

it(`dims through the lens only while a role is read as, and only what its fence refuses`, () => {
    const roles = [{ id: `test` }];
    const access = fenced([`src`]);
    expect([lensRefuses(roles, `README.md`, access), lensRefuses(roles, `src/main.ts`, access)]).toEqual([false, false]);

    lensRoleId.value = `test`;
    expect([lensRefuses(roles, `README.md`, access), lensRefuses(roles, `src/main.ts`, access), lensRefuses(roles, `src`, access)]).toEqual([
        true,
        false,
        false,
    ]);
    lensRoleId.value = undefined;
});
