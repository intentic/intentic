import { describe, it, expect } from "bun:test";
import { identityHue } from "../../../lib/identityHue";
import { boardOwners, mayAssign, ownedBy, ownerLook, sessionMark, starterLook } from "./ownership";

describe("ownership on the board", () => {
    const owner = { email: `Ania@Example.com`, since: 1 };
    const hue = identityHue(`ania@example.com`);

    it("draws the owner by recorded name, then presence, then address, and knows the reader's own", () => {
        expect(ownerLook({ ...owner, name: `Ania Nowak` }, `bob@example.com`, [])).toEqual({
            email: `Ania@Example.com`,
            name: `Ania Nowak`,
            short: `Ania`,
            hue,
            mine: false,
        });
        expect(ownerLook(owner, undefined, [{ email: `ania@example.com`, name: `Ania K.` }])).toEqual({
            email: `Ania@Example.com`,
            name: `Ania K.`,
            short: `Ania`,
            hue,
            mine: false,
        });
        // No name anywhere: the address stands in, shortened to its local part for the card's line.
        expect(ownerLook(owner, `ania@example.com`, [])).toEqual({
            email: `Ania@Example.com`,
            name: `Ania@Example.com`,
            short: `Ania`,
            hue,
            mine: true,
        });
    });

    it("gives one person one hue however their address is cased, so a card's dot matches their chip", () => {
        expect(ownerLook({ email: `ania@EXAMPLE.com` }, undefined, []).hue).toBe(hue);
    });

    it("reads a program's or a parent's starter, and nothing for a person's or a wake's", () => {
        expect(starterLook(`token:nightly CI`)).toEqual({ kind: `token`, label: `nightly CI` });
        expect(starterLook(`agent:fair-sage-ey2r`)).toEqual({ kind: `child`, parent: `fair-sage-ey2r` });
        expect(starterLook(`ania@example.com`)).toBeUndefined();
        expect(starterLook(undefined)).toBeUndefined();
    });

    it("marks a card only when whose it is says something: never the reader's own", () => {
        expect(sessionMark({ owner }, `ania@example.com`, [])).toBeUndefined();
        expect(sessionMark({ owner }, `bob@example.com`, [])).toEqual({
            kind: `person`,
            look: { email: `Ania@Example.com`, name: `Ania@Example.com`, short: `Ania`, hue, mine: false },
        });
        // An owner on record answers the question, so what started it is no longer drawn.
        expect(sessionMark({ owner, startedBy: `token:nightly CI` }, `ania@example.com`, [])).toBeUndefined();
        expect(sessionMark({ startedBy: `token:nightly CI` }, `ania@example.com`, [])).toEqual({ kind: `token`, label: `nightly CI` });
        expect(sessionMark({ startedBy: `bob@example.com` }, `ania@example.com`, [])).toBeUndefined();
        expect(sessionMark({}, `ania@example.com`, [])).toBeUndefined();
    });

    it("offers a chip per other owner holding something, once each and in name order", () => {
        const bob = { email: `bob@example.com`, name: `Bob Stone`, since: 2 };
        const board = [{ owner }, { owner: bob }, { owner: { ...bob, email: `BOB@example.com` } }, { owner: undefined }];
        expect(boardOwners(board, `carol@example.com`, []).map((look) => look.short)).toEqual([`Ania`, `Bob`]);
        // The reader is never a chip: Mine already is one.
        expect(boardOwners(board, `ania@example.com`, []).map((look) => look.short)).toEqual([`Bob`]);
    });

    it("keeps the chip the filter names after that person's last card has left the board", () => {
        expect(boardOwners([], `ania@example.com`, [], `bob@example.com`).map((look) => look.short)).toEqual([`bob`]);
        // Presence is asked for the name of somebody the board can no longer answer for.
        expect(boardOwners([], `ania@example.com`, [{ email: `bob@example.com`, name: `Bob Stone` }], `bob@example.com`)).toEqual([
            { email: `bob@example.com`, name: `Bob Stone`, short: `Bob`, hue: identityHue(`bob@example.com`), mine: false },
        ]);
        // Mine is its own chip, so the reader never doubles as one.
        expect(boardOwners([], `ania@example.com`, [], `ANIA@example.com`)).toEqual([]);
    });

    it("Mine matches the reader's address only, folded", () => {
        expect(ownedBy({ owner }, `ania@example.com`)).toBe(true);
        expect(ownedBy({ owner }, `bob@example.com`)).toBe(false);
        expect(ownedBy({}, `ania@example.com`)).toBe(false);
        expect(ownedBy({ owner }, undefined)).toBe(false);
    });

    it("offers to assign what the daemon would allow: unowned, one's own, or anything for a maintainer", () => {
        expect(mayAssign(undefined, `bob@example.com`, false)).toBe(true);
        expect(mayAssign(owner, `ania@example.com`, false)).toBe(true);
        expect(mayAssign(owner, `bob@example.com`, false)).toBe(false);
        expect(mayAssign(owner, `bob@example.com`, true)).toBe(true);
    });
});
