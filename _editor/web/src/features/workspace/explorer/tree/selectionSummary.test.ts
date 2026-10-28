import type { WorkspaceTreeEntry } from "@intentic/sandbox-contract/schemas/workspace/workspace-tree";
import { countSelection, selectionLine } from "./selectionSummary";

const LISTED: readonly WorkspaceTreeEntry[] = [
    { name: `a.png`, path: `a.png`, type: `file`, size: 1024 },
    { name: `b.png`, path: `b.png`, type: `file`, size: 2048 },
    { name: `c.bin`, path: `c.bin`, type: `file` },
    { name: `src`, path: `src`, type: `dir` },
];
const ENTRIES = new Map(LISTED.map((entry) => [entry.path, entry]));
const lineFor = (paths: readonly string[]): string | undefined => selectionLine(countSelection(paths, (path) => ENTRIES.get(path)));

describe(`the selection line`, () => {
    it(`says nothing for one row or none`, () => {
        expect([lineFor([]), lineFor([`a.png`]), lineFor([`a.png`, `gone.txt`])]).toEqual([undefined, undefined, undefined]);
    });

    it(`totals files whose sizes are all known`, () => {
        expect(lineFor([`a.png`, `b.png`])).toBe(`2 files selected · 3.0 KB`);
    });

    it(`gives no total once a folder or an unsized file is among them`, () => {
        expect(lineFor([`src`, `a.png`, `b.png`])).toBe(`1 folder, 2 files selected`);
        expect(lineFor([`a.png`, `c.bin`])).toBe(`2 files selected`);
    });

    it(`counts by kind, leaving out what is no longer listed`, () => {
        expect(countSelection([`src`, `a.png`, `gone.txt`], (path) => ENTRIES.get(path))).toEqual({ folders: 1, files: 1, bytes: undefined });
    });
});
