import type { WorkspaceTreeEntry } from "@intentic/api-contract";
import { describe, expect, it } from "vitest";
import { type ExplorerFilters, explorerShows, isTechnicalEntry, technicalHidden } from "./explorerFilter";

const file = (name: string): WorkspaceTreeEntry => ({ name, path: name, type: `file` });
const dir = (name: string): WorkspaceTreeEntry => ({ name, path: name, type: `dir`, children: [] });

// Every switch off is the developer's default reading, and it is the one every other case is measured against.
const OFF: ExplorerFilters = { showIgnored: false, hideTests: false, hideTechnical: false };
const shows = (entry: WorkspaceTreeEntry, over: Partial<ExplorerFilters> = {}): boolean => explorerShows(entry, { ...OFF, ...over });

describe(`the explorer's ignored-entry filter`, () => {
    it(`drops an ignored entry and keeps the rest`, () => {
        expect(shows({ ...file(`main.js`), ignored: true })).toBe(false);
        expect(shows(file(`main.ts`))).toBe(true);
    });

    it(`lists ignored entries once the switch is on`, () => {
        expect(shows({ ...file(`main.js`), ignored: true }, { showIgnored: true })).toBe(true);
    });
});

// The half that decides what "a test" is. A filter that eats a source file is worse than one that leaves a test
// in, so the near-misses matter at least as much as the hits.
describe(`the explorer's hide-tests filter`, () => {
    it(`leaves tests in until the switch is on`, () => {
        expect(shows(file(`useLayout.test.ts`))).toBe(true);
        expect(shows(file(`useLayout.test.ts`), { hideTests: true })).toBe(false);
    });

    it(`takes out the naming conventions each language spells differently`, () => {
        for (const name of [`useLayout.test.ts`, `Button.spec.tsx`, `land_test.go`, `test_scan.py`]) {
            expect(shows(file(name), { hideTests: true }), name).toBe(false);
        }
    });

    it(`takes out a test folder, which is what carries the files inside it`, () => {
        for (const name of [`__tests__`, `tests`, `test`, `spec`, `e2e`]) {
            expect(shows(dir(name), { hideTests: true }), name).toBe(false);
        }
    });

    it(`keeps source whose name merely reads like a test`, () => {
        for (const name of [`test-utils.ts`, `latest.ts`, `testing.ts`, `contest.ts`, `manifest.json`, `test.ts`]) {
            expect(shows(file(name), { hideTests: true }), name).toBe(true);
        }
        expect(shows(dir(`testing`), { hideTests: true })).toBe(true);
    });

    it(`still drops an ignored test folder when only the ignored switch is on`, () => {
        expect(shows({ ...dir(`__tests__`), ignored: true })).toBe(false);
        expect(shows({ ...dir(`__tests__`), ignored: true }, { showIgnored: true })).toBe(true);
    });
});

// The maker's default: tooling out, content and source in. The misses matter here too, since a maker's project is
// mostly the files this must keep.
describe(`the explorer's technical-files filter`, () => {
    it(`leaves tooling in until the switch is on`, () => {
        expect(shows(file(`package.json`))).toBe(true);
        expect(shows(file(`package.json`), { hideTechnical: true })).toBe(false);
    });

    it(`takes out dot entries, lockfiles, manifests, compiler output and dependency folders`, () => {
        for (const name of [`.gitignore`, `.intentic`, `.github`, `pnpm-lock.yaml`, `tsconfig.json`, `tsconfig.app.json`, `vite.config.ts`, `index.d.ts`, `main.js.map`, `Dockerfile`, `LICENSE`]) {
            expect(isTechnicalEntry(name, `file`), name).toBe(true);
        }
        for (const name of [`.git`, `node_modules`, `dist`, `coverage`, `__pycache__`]) {
            expect(isTechnicalEntry(name, `dir`), name).toBe(true);
        }
    });

    it(`keeps what a maker came for: documents, media, pages, and the source that makes them`, () => {
        for (const name of [`README.md`, `notes.md`, `hero.png`, `index.html`, `styles.css`, `main.ts`, `App.vue`, `AGENTS.md`, `config.ts`, `budget.xlsx`]) {
            expect(isTechnicalEntry(name, `file`), name).toBe(false);
        }
        for (const name of [`docs`, `src`, `public`, `images`, `configs`]) {
            expect(isTechnicalEntry(name, `dir`), name).toBe(false);
        }
    });

    it(`counts what the switch alone removed, so the chip never claims an ignored entry`, () => {
        const level = [file(`README.md`), file(`package.json`), { ...file(`pnpm-lock.yaml`), ignored: true }, dir(`.github`)];
        expect(technicalHidden(level, OFF)).toBe(0);
        expect(technicalHidden(level, { ...OFF, hideTechnical: true })).toBe(2);
        expect(technicalHidden(level, { ...OFF, hideTechnical: true, showIgnored: true })).toBe(3);
    });
});
