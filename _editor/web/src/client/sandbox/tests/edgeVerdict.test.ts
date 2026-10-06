import { EDGE_VERDICT_HEADER } from "@intentic/sandbox-contract";
import { forgetEdgeVerdict, lastEdgeVerdict, noteEdgeVerdict } from "../edgeVerdict";

// The edge's verdict reaches the connection machine through a module-level note, so what it forgets matters as much as
// what it keeps: a verdict read against the wrong sandbox, or an old one read as current, is a confident wrong sentence
// on the gate.

const answer = (verdict?: string): Response =>
    new Response(`nope`, { status: 502, headers: verdict === undefined ? {} : { [EDGE_VERDICT_HEADER]: verdict } });

describe(`the edge's last word`, () => {
    beforeEach(forgetEdgeVerdict);

    it(`keeps a verdict for the sandbox it was about`, () => {
        noteEdgeVerdict(`box-1`, answer(`no-tunnel`));
        expect(lastEdgeVerdict(`box-1`)).toBe(`no-tunnel`);
        expect(lastEdgeVerdict(`box-2`)).toBeUndefined();
    });

    // Every other box in the fleet is polled in the background through the same fetch, so the active box's verdict has
    // to survive their answers landing after it.
    it(`keeps each sandbox's verdict apart from what other sandboxes' responses carried`, () => {
        noteEdgeVerdict(`box-1`, answer(`no-tunnel`));
        noteEdgeVerdict(`box-2`, answer());
        expect(lastEdgeVerdict(`box-1`)).toBe(`no-tunnel`);
        expect(lastEdgeVerdict(`box-2`)).toBeUndefined();
    });

    it(`refuses a verdict it never wrote`, () => {
        // A 502 from a corporate proxy or a CDN says nothing about the sandbox, and must not be read as if it did.
        noteEdgeVerdict(`box-1`, new Response(`nope`, { status: 502, headers: { [EDGE_VERDICT_HEADER]: `whatever` } }));
        expect(lastEdgeVerdict(`box-1`)).toBeUndefined();
    });

    it(`forgets the verdict once a response comes from behind the edge`, () => {
        noteEdgeVerdict(`box-1`, answer(`no-tunnel`));
        noteEdgeVerdict(`box-1`, answer());
        expect(lastEdgeVerdict(`box-1`)).toBeUndefined();
    });

    it(`stops describing the present after half a minute`, () => {
        noteEdgeVerdict(`box-1`, answer(`no-tunnel`));
        expect(lastEdgeVerdict(`box-1`, Date.now() + 29_000)).toBe(`no-tunnel`);
        expect(lastEdgeVerdict(`box-1`, Date.now() + 31_000)).toBeUndefined();
    });
});
