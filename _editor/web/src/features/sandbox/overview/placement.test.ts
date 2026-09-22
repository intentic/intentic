import { describe, it, expect } from "bun:test";
import { placementKind, sandboxPlacement, slugFromDaemonUrl } from "./placement";

// Words come from the catalog, which a node suite has not loaded; what is worth asserting here is the rule — which
// kind, and therefore which glyph — since that is the part a reader has to trust at a glance.

describe(`placementKind`, () => {
    it(`calls a hosted machine the cloud even when it is somebody else's sandbox`, () => {
        expect(placementKind({ hosted: { region: `fra` }, owner: false })).toBe(`cloud`);
    });

    it(`names a self-hosted sandbox shared with this account as somebody else's machine`, () => {
        expect(placementKind({ hosted: null, owner: false })).toBe(`shared`);
    });

    it(`stays at the coarse answer while no refinement has landed`, () => {
        expect(placementKind({ hosted: null, owner: true })).toBe(`own`);
    });

    it(`never claims the cloud off a row that carries no hosted record at all`, () => {
        expect(placementKind({ hosted: undefined, owner: true })).toBe(`own`);
    });

    it(`sharpens to a named machine once the fleet or the loopback probe answers`, () => {
        expect(placementKind({ hosted: null, owner: true, device: `radarsu-rog` })).toBe(`device`);
        expect(placementKind({ hosted: null, owner: true, onThisComputer: true })).toBe(`device`);
        // A probe that came back negative proves nothing: an address on this very machine can be unreachable from
        // the browser (permission unasked, DNS down), and drawing "somewhere else" off that would be a lie.
        expect(placementKind({ hosted: null, owner: true, onThisComputer: false })).toBe(`own`);
    });
});

describe(`sandboxPlacement`, () => {
    it(`gives each kind its own glyph, so the mark alone separates the three places`, () => {
        expect(sandboxPlacement({ hosted: { region: `fra` }, owner: true }).icon).toBe(`cloud`);
        expect(sandboxPlacement({ hosted: null, owner: true, device: `omen` }).icon).toBe(`desktop`);
        expect(sandboxPlacement({ hosted: null, owner: true }).icon).toBe(`server`);
        expect(sandboxPlacement({ hosted: null, owner: false }).icon).toBe(`users`);
    });

    it(`labels a named device with its own name rather than a category`, () => {
        expect(sandboxPlacement({ hosted: null, owner: true, device: `radarsu-rog` }).label).toBe(`radarsu-rog`);
    });
});

describe(`slugFromDaemonUrl`, () => {
    it(`reads the container's slug off the daemon's own hostname`, () => {
        expect(slugFromDaemonUrl(`https://sunny-otter.intentic.dev`)).toBe(`sunny-otter`);
    });

    it(`answers nothing for a sandbox that has never reported an address`, () => {
        expect(slugFromDaemonUrl(null)).toBeUndefined();
        expect(slugFromDaemonUrl(`not a url`)).toBeUndefined();
    });
});
