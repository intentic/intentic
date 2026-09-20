import { describe, expect, it } from "vitest";
import { grantBody, grantSendable } from "./accessGrant";

describe(`grantBody`, () => {
    it(`carries desks on a desk grant and drops them on every other tier`, () => {
        expect(grantBody(`dee@example.com`, `desk`, [`support`])).toEqual({ email: `dee@example.com`, role: `desk`, desks: [`support`] });
        // A tier picked after cards were toggled must not carry them: a viewer with desks is a row the daemon refuses.
        expect(grantBody(`vic@example.com`, `viewer`, [`support`])).toEqual({ email: `vic@example.com`, role: `viewer` });
    });
});

describe(`grantSendable`, () => {
    it(`holds a desk grant until it names a card, and nothing else`, () => {
        expect(grantSendable(`desk`, [])).toBe(false);
        expect(grantSendable(`desk`, [`support`])).toBe(true);
        expect(grantSendable(`collaborator`, [])).toBe(true);
    });
});
