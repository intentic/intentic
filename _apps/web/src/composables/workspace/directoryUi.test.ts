import { describe, expect, it } from "vitest";
import { resolveBridgeCall } from "./directoryUiVerbs";

// The bridge's allowlist IS the security boundary — these lock it down: only known verbs resolve, ids are
// encoded into paths (no traversal/injection), and missing ids fail loudly instead of hitting a malformed route.
describe(`resolveBridgeCall`, () => {
    it(`rejects any verb not on the allowlist`, () => {
        expect(() => resolveBridgeCall(`deleteEverything`, {})).toThrow(/not allowed/);
        // A daemon path smuggled in as a verb is still just an unknown verb.
        expect(() => resolveBridgeCall(`/workspace/entry`, {})).toThrow(/not allowed/);
    });

    it(`builds the daemon call for each allowed verb`, () => {
        expect(resolveBridgeCall(`listPanels`, {})).toEqual({ path: `/panels`, method: `GET`, stream: false });
        expect(resolveBridgeCall(`startPanel`, { repo: `app` })).toEqual({ path: `/panels/app/start`, method: `POST`, stream: false });
        expect(resolveBridgeCall(`panelTerminals`, { repo: `app` })).toMatchObject({ path: `/panels/app/terminals`, method: `GET` });
    });

    it(`encodes ids and paths into the URL so a crafted id can't escape its route`, () => {
        expect(resolveBridgeCall(`startPanel`, { repo: `../../etc` }).path).toBe(`/panels/..%2F..%2Fetc/start`);
        expect(resolveBridgeCall(`readFile`, { path: `a/b c.txt` }).path).toBe(`/workspace/file?path=a%2Fb%20c.txt`);
    });

    it(`fails loudly on a missing or empty required arg`, () => {
        expect(() => resolveBridgeCall(`startPanel`, {})).toThrow(/non-empty string/);
        expect(() => resolveBridgeCall(`readFile`, { path: `` })).toThrow(/non-empty string/);
    });
});
