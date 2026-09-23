import { describe, it, expect } from "bun:test";
import { resolveBridgeCall } from "./directoryUiVerbs";

// The bridge's allowlist IS the security boundary, these lock it down: only known verbs resolve, each to exactly one
// procedure and input (the typed client encodes those into the route), the one raw route encodes its own id, and
// missing ids fail loudly instead of hitting a malformed route.
describe(`resolveBridgeCall`, () => {
    it(`rejects any verb not on the allowlist`, () => {
        expect(() => resolveBridgeCall(`deleteEverything`, {})).toThrow(/not allowed/);
        // A daemon path smuggled in as a verb is still just an unknown verb.
        expect(() => resolveBridgeCall(`/workspace/entry`, {})).toThrow(/not allowed/);
        // So is a procedure name: the verbs are the allowlist, not the contract.
        expect(() => resolveBridgeCall(`workspace.delete`, { path: `a.txt` })).toThrow(/not allowed/);
    });

    // Every object inherits these; resolving one would hand the frame's own args back as the call to send.
    it(`rejects a name every object inherits`, () => {
        expect(() => resolveBridgeCall(`constructor`, { path: `/workspace/entry` })).toThrow(/not allowed/);
        expect(() => resolveBridgeCall(`toString`, {})).toThrow(/not allowed/);
        expect(() => resolveBridgeCall(`__proto__`, {})).toThrow(/not allowed/);
    });

    it(`resolves each allowed verb to exactly one procedure and its input`, () => {
        expect(resolveBridgeCall(`listPanels`, {})).toEqual({ procedure: `panels.list` });
        expect(resolveBridgeCall(`startPanel`, { repo: `app` })).toEqual({ procedure: `panels.start`, input: { repo: `app` } });
        expect(resolveBridgeCall(`stopPanel`, { repo: `app` })).toEqual({ procedure: `panels.stop`, input: { repo: `app` } });
        expect(resolveBridgeCall(`readFile`, { path: `a/b c.txt` })).toEqual({ procedure: `workspace.file`, input: { path: `a/b c.txt` } });
    });

    // A crafted id reaches the typed client as the input's value, never spliced into a route here.
    it(`passes a crafted id through as input, for the typed client to encode`, () => {
        expect(resolveBridgeCall(`startPanel`, { repo: `../../etc` })).toEqual({ procedure: `panels.start`, input: { repo: `../../etc` } });
    });

    // Anything else the frame sends is dropped, so it cannot widen a call (a limit, another conversation's checkout).
    it(`carries only the args a verb names`, () => {
        expect(resolveBridgeCall(`readFile`, { path: `notes.md`, agent: `c-1`, limit: 1 })).toEqual({
            procedure: `workspace.file`,
            input: { path: `notes.md` },
        });
    });

    it(`sends the route the contract lacks as a GET, its id encoded so a crafted id can't escape the route`, () => {
        expect(resolveBridgeCall(`panelTerminals`, { repo: `app` })).toEqual({ path: `/panels/app/terminals` });
        expect(resolveBridgeCall(`panelTerminals`, { repo: `../../etc` })).toEqual({ path: `/panels/..%2F..%2Fetc/terminals` });
    });

    it(`fails loudly on a missing or empty required arg`, () => {
        expect(() => resolveBridgeCall(`startPanel`, {})).toThrow(/non-empty string/);
        expect(() => resolveBridgeCall(`readFile`, { path: `` })).toThrow(/non-empty string/);
        expect(() => resolveBridgeCall(`panelTerminals`, { repo: 7 })).toThrow(/non-empty string/);
    });
});
