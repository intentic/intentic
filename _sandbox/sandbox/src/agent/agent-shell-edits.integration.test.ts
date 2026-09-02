import { mkdtempSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, expect, test } from "vitest";
import { createShellEditTracker, type ShellEdit } from "./agent-shell-edits.js";

/* Attribution by mtime across a command, against real files: the one thing worth a disk here is that a stat is
 * what the tracker reads, so a fake of it would assert the seam works by assuming it. */

const roots: string[] = [];
afterAll(() => {
    for (const root of roots) {
        rmSync(root, { recursive: true, force: true });
    }
});

const tree = (): string => {
    const root = mkdtempSync(join(tmpdir(), "shell-edits-"));
    roots.push(root);
    return root;
};

// The agent names the file one way and the daemon stats it another; the tracker must report the agent's name.
const edit = (root: string, name: string): ShellEdit => ({ onDisk: join(root, name), path: `/work/${name}` });

test(`a file whose mtime moved across the command is the command's, by the agent's name`, async () => {
    const root = tree();
    writeFileSync(join(root, "a.ts"), "a");
    writeFileSync(join(root, "b.ts"), "b");
    utimesSync(join(root, "a.ts"), 1_000, 1_000);
    utimesSync(join(root, "b.ts"), 1_000, 1_000);
    const tracker = createShellEditTracker(async () => [edit(root, "a.ts"), edit(root, "b.ts")]);
    await tracker.before();
    utimesSync(join(root, "b.ts"), 2_000, 2_000);
    expect(await tracker.changed()).toEqual([edit(root, "b.ts")]);
});

test(`a file that became dirty during the command is the command's; one dirty before it is not`, async () => {
    const root = tree();
    writeFileSync(join(root, "old.ts"), "old");
    utimesSync(join(root, "old.ts"), 1_000, 1_000);
    let dirty = [edit(root, "old.ts")];
    const tracker = createShellEditTracker(async () => dirty);
    await tracker.before();
    writeFileSync(join(root, "new.ts"), "new");
    dirty = [edit(root, "old.ts"), edit(root, "new.ts")];
    expect(await tracker.changed()).toEqual([edit(root, "new.ts")]);
});

test(`without a snapshot before it, nothing is attributed to a command`, async () => {
    const root = tree();
    writeFileSync(join(root, "a.ts"), "a");
    const tracker = createShellEditTracker(async () => [edit(root, "a.ts")]);
    expect(await tracker.changed()).toEqual([]);
    // And a snapshot is spent by the read that follows it: the next command starts from nothing.
    await tracker.before();
    await tracker.changed();
    expect(await tracker.changed()).toEqual([]);
});

test(`a deleted or unreadable file, and a dirty list that cannot be read, attribute nothing`, async () => {
    const root = tree();
    writeFileSync(join(root, "gone.ts"), "x");
    const tracker = createShellEditTracker(async () => [edit(root, "gone.ts")]);
    await tracker.before();
    rmSync(join(root, "gone.ts"));
    expect(await tracker.changed()).toEqual([]);
    const failing = createShellEditTracker(async () => {
        throw new Error("git is not here");
    });
    await failing.before();
    expect(await failing.changed()).toEqual([]);
});
