import type { WorkspaceTreeEntry } from "@intentic-app/api-contract";
import { describe, expect, it } from "vitest";
import { explorerShows } from "./explorerFilter";

const file = (name: string): WorkspaceTreeEntry => ({ name, path: name, type: `file` });
const dir = (name: string): WorkspaceTreeEntry => ({ name, path: name, type: `dir`, children: [] });

// Both switches off is the explorer's default reading, and it is the one every other case is measured against.
const shows = (entry: WorkspaceTreeEntry, hideTests = false): boolean => explorerShows(entry, false, hideTests);

describe(`the explorer's ignored-entry filter`, () => {
    it(`drops an ignored entry and keeps the rest`, () => {
        expect(shows({ ...file(`main.js`), ignored: true })).toBe(false);
        expect(shows(file(`main.ts`))).toBe(true);
    });

    it(`lists ignored entries once the switch is on`, () => {
        expect(explorerShows({ ...file(`main.js`), ignored: true }, true, false)).toBe(true);
    });
});

// The half that decides what "a test" is. A filter that eats a source file is worse than one that leaves a test
// in, so the near-misses matter at least as much as the hits.
describe(`the explorer's hide-tests filter`, () => {
    it(`leaves tests in until the switch is on`, () => {
        expect(shows(file(`useLayout.test.ts`))).toBe(true);
        expect(shows(file(`useLayout.test.ts`), true)).toBe(false);
    });

    it(`takes out the naming conventions each language spells differently`, () => {
        for (const name of [`useLayout.test.ts`, `Button.spec.tsx`, `land_test.go`, `test_scan.py`]) {
            expect(shows(file(name), true), name).toBe(false);
        }
    });

    it(`takes out a test folder, which is what carries the files inside it`, () => {
        for (const name of [`__tests__`, `tests`, `test`, `spec`, `e2e`]) {
            expect(shows(dir(name), true), name).toBe(false);
        }
    });

    it(`keeps source whose name merely reads like a test`, () => {
        for (const name of [`test-utils.ts`, `latest.ts`, `testing.ts`, `contest.ts`, `manifest.json`, `test.ts`]) {
            expect(shows(file(name), true), name).toBe(true);
        }
        expect(shows(dir(`testing`), true)).toBe(true);
    });

    it(`still drops an ignored test folder when only the ignored switch is on`, () => {
        expect(explorerShows({ ...dir(`__tests__`), ignored: true }, false, false)).toBe(false);
        expect(explorerShows({ ...dir(`__tests__`), ignored: true }, true, false)).toBe(true);
    });
});
