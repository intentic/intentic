import { describe, expect, it } from "vitest";
import { derivedDiffSource, diffRawUrls } from "./diffRaw";

// The URLs a review surface hands its diff viewer, and the source read back out of them: the derived-text route takes
// the same query, so the two must round-trip for every source.
describe(`derivedDiffSource`, () => {
    it(`reads each source back out of the side URLs built for it, without the side selector`, () => {
        const working = { source: `working`, repo: `root`, side: `unstaged` } as const;
        expect(derivedDiffSource(diffRawUrls(working, `Brief.docx`, `modified`))).toEqual({ ...working, path: `Brief.docx` });
        const agent = { source: `agent`, agent: `abc123`, repo: `web` } as const;
        expect(derivedDiffSource(diffRawUrls(agent, `docs/spec.pdf`, `added`))).toEqual({ ...agent, path: `docs/spec.pdf` });
        const checkpoint = { source: `checkpoint`, snapshot: `s-9`, scope: `root` } as const;
        expect(derivedDiffSource(diffRawUrls(checkpoint, `deck.pptx`, `deleted`))).toEqual({ ...checkpoint, path: `deck.pptx` });
    });

    it(`survives a path with characters the query string has to escape`, () => {
        const source = { source: `working`, repo: `root`, side: `staged` } as const;
        expect(derivedDiffSource(diffRawUrls(source, `Specyfikacja Warunków & Zamówienia.docx`, `modified`))?.path).toBe(`Specyfikacja Warunków & Zamówienia.docx`);
    });

    it(`answers nothing for a diff with no sides, or one built by something else`, () => {
        expect(derivedDiffSource({})).toBeUndefined();
        expect(derivedDiffSource({ afterRaw: `/somewhere/else?x=1` })).toBeUndefined();
    });
});
