import { describe, expect, it } from "vitest";
import { mayAssign, ownedBy, ownerLook, starterLook } from "./ownership";

describe("ownership on the board", () => {
    const owner = { email: `Ania@Example.com`, since: 1 };

    it("draws the owner by recorded name, then presence, then address, and knows the reader's own", () => {
        expect(ownerLook({ ...owner, name: `Ania` }, `bob@example.com`, [])).toEqual({ email: `Ania@Example.com`, name: `Ania`, mine: false });
        expect(ownerLook(owner, undefined, [{ email: `ania@example.com`, name: `Ania K.`, picture: `p.png` }])).toEqual({
            email: `Ania@Example.com`,
            name: `Ania K.`,
            picture: `p.png`,
            mine: false,
        });
        expect(ownerLook(owner, `ania@example.com`, [])).toEqual({ email: `Ania@Example.com`, name: `Ania@Example.com`, mine: true });
    });

    it("reads a program's or a parent's starter, and nothing for a person's or a wake's", () => {
        expect(starterLook(`token:nightly CI`)).toEqual({ kind: `token`, label: `nightly CI` });
        expect(starterLook(`agent:fair-sage-ey2r`)).toEqual({ kind: `child`, parent: `fair-sage-ey2r` });
        expect(starterLook(`ania@example.com`)).toBeUndefined();
        expect(starterLook(undefined)).toBeUndefined();
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
