import { hubDrills, hubSectionParam } from "./hubDrill";

// The two decisions that turn a hub's wrapping strip into a phone's index and pages: whether it drills at all, and
// what address each row then names.

describe(`hubDrills`, () => {
    it(`drills on a phone with more than one section to index`, () => {
        expect(hubDrills(true, false, 2)).toBe(true);
    });

    it(`keeps the desktop's rail and strip everywhere else`, () => {
        expect(hubDrills(false, false, 12)).toBe(false);
    });

    // A guest's hub root is a path the shell fence sends it home from, so an index there would be a page it is bounced off.
    it(`does not drill for a reader who may not stand on the root`, () => {
        expect(hubDrills(true, true, 12)).toBe(false);
    });

    it(`does not drill a hub of one section, which has no index worth a page`, () => {
        expect(hubDrills(true, false, 1)).toBe(false);
    });
});

describe(`hubSectionParam`, () => {
    it(`leaves the default section on the param-less address where that address shows it`, () => {
        expect(hubSectionParam(`overview`, `overview`, false)).toBeUndefined();
    });

    // Drilled, the param-less address is the index: a default row without its own name would link back to the list.
    it(`names the default section where the param-less address is something else`, () => {
        expect(hubSectionParam(`overview`, `overview`, true)).toBe(`overview`);
    });

    it(`names every other section either way`, () => {
        expect(hubSectionParam(`access`, `overview`, false)).toBe(`access`);
        expect(hubSectionParam(`access`, `overview`, true)).toBe(`access`);
    });
});
