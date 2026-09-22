import { type DeviceFolderRow, folderConflicts } from "@intentic/ui/device";
import { describe, it, expect } from "bun:test";

// The sentence over the conflict list is the whole of what a reader is told, and it used to say one thing about two
// unlike situations — describing the common one (build output blocking a deletion) as the rare one (two people's
// copies of the same file). Somebody following it went looking for a difference in content that does not exist.

const folder = (conflictedPaths: DeviceFolderRow[`conflictedPaths`], conflicts?: number): DeviceFolderRow => ({
    sandboxId: `sandbox-82789f4106b4`,
    mode: `sync`,
    localDir: `/home/radarsu/intentic/workspace-82789f4106b4`,
    conflicts: conflicts ?? conflictedPaths?.length ?? 0,
    conflictedPaths,
});

// The six that wedged a dogfooding machine: an agent moved these in the sandbox, each stood on a `node_modules`.
const DERIVED = [`acceptance`, `deployments`, `documentation`, `issues`, `knowledge`, `maintenance`].map((name) => ({
    path: `intentic/_extensions/${name}`,
    local: `untracked` as const,
    sandbox: `deleted` as const,
    nature: `derived-leftover` as const,
}));

describe(`folderConflicts`, () => {
    it(`says nothing at all when the folder has no conflicts`, () => {
        expect(folderConflicts(folder([]))).toBeUndefined();
        expect(folderConflicts(undefined)).toBeUndefined();
    });

    it(`describes build output as build output, and does not ask for two copies to be reconciled`, () => {
        const read = folderConflicts(folder(DERIVED));
        expect(read?.clearable).toBe(6);
        expect(read?.disputed).toBe(0);
        expect(read?.lead).toContain(`6 directories the sandbox deleted`);
        expect(read?.lead).toContain(`Nothing of yours is in them`);
        // The sentence for a real collision must not be reached by this one.
        expect(read?.lead).not.toContain(`Make the two copies match`);
    });

    it(`keeps the old sentence for a real disagreement, which is what it was always true of`, () => {
        const read = folderConflicts(folder([{ path: `src/app.ts`, local: `modified`, sandbox: `modified`, nature: `both-edited` }]));
        expect(read?.clearable).toBe(0);
        expect(read?.disputed).toBe(1);
        expect(read?.lead).toContain(`Make the two copies match`);
    });

    it(`says both when a folder holds both, so neither count goes unmentioned`, () => {
        const read = folderConflicts(folder([...DERIVED, { path: `src/app.ts`, local: `modified`, sandbox: `modified`, nature: `both-edited` }]));
        expect(read?.clearable).toBe(6);
        expect(read?.disputed).toBe(1);
        expect(read?.lead).toContain(`6 directories the sandbox deleted`);
        expect(read?.lead).toContain(`one is a real disagreement`);
    });

    it(`falls to the sentence asking for a person when an older agent reported no nature`, () => {
        // Nothing may be called clearable on the strength of a field that agent never sent.
        const read = folderConflicts(folder([{ path: `src/app.ts`, local: `created`, sandbox: `created` }]));
        expect(read?.clearable).toBe(0);
        expect(read?.lead).toContain(`Make the two copies match`);
    });

    it(`names each path in the words of what happened to it`, () => {
        const read = folderConflicts(folder(DERIVED.slice(0, 1)));
        expect(read?.rows).toEqual([{ path: `intentic/_extensions/acceptance`, note: `build output left on this device · deleted in the sandbox` }]);
    });

    it(`counts what it could not show against Mutagen's own total, not against the rows`, () => {
        // Both the machine and Mutagen cap what they carry; the count is the only uncapped number here.
        const read = folderConflicts(folder(DERIVED, 40));
        expect(read?.more).toBe(40 - (read?.rows.length ?? 0));
    });
});
