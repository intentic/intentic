import { describe, expect, it } from "vitest";
import { grantBody, grantSendable } from "./accessGrant";

describe(`grantBody`, () => {
    it(`carries desks on a desk grant and drops them on every other tier`, () => {
        expect(grantBody(`dee@example.com`, `desk`, [`support`], undefined)).toEqual({ email: `dee@example.com`, role: `desk`, desks: [`support`] });
        // A tier picked after cards were toggled must not carry them: a viewer with desks is a row the daemon refuses.
        expect(grantBody(`vic@example.com`, `viewer`, [`support`], undefined)).toEqual({ email: `vic@example.com`, role: `viewer` });
    });

    // Absent and empty are different grants: no field is the whole workspace, an empty list is a fence admitting
    // nothing. Sending one for the other is the difference between a colleague seeing everything and seeing nothing.
    it(`omits the fence entirely when no area is picked, and sends it when one is`, () => {
        expect(grantBody(`vic@example.com`, `viewer`, [], undefined)).toEqual({ email: `vic@example.com`, role: `viewer` });
        expect(grantBody(`vic@example.com`, `viewer`, [], [`support`])).toEqual({ email: `vic@example.com`, role: `viewer`, areas: [`support`] });
    });

    // The tier carries the owner's operating authority and reads every credential; a folder fence over it would be a
    // line on a screen, and the daemon refuses one, so the body never carries it either.
    it(`drops the fence on a maintainer, whatever the picker held`, () => {
        expect(grantBody(`mai@example.com`, `maintainer`, [], [`support`])).toEqual({ email: `mai@example.com`, role: `maintainer` });
    });
});

describe(`grantSendable`, () => {
    it(`holds a desk grant until it names a card, and nothing else`, () => {
        expect(grantSendable(`desk`, [])).toBe(false);
        expect(grantSendable(`desk`, [`support`])).toBe(true);
        expect(grantSendable(`collaborator`, [])).toBe(true);
    });
});
