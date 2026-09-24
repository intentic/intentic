import { mkdtempSync, renameSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createShellEditTracker, type ShellEdit } from "./agent-shell-edits.js";

/* Attribution by inode change across a command, against real files: the one thing worth a disk here is that a stat is what the tracker reads. */

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

// Longer than the kernel's timestamp tick, so a write lands clearly before or after the command's start.
const tick = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 25));

test(`a file changed during the command is the command's, by the agent's name; one left alone is not`, async () => {
    const root = tree();
    writeFileSync(join(root, "a.ts"), "a");
    writeFileSync(join(root, "b.ts"), "b");
    const tracker = createShellEditTracker(async () => [edit(root, "a.ts"), edit(root, "b.ts")]);
    await tick();
    tracker.before();
    await tick();
    writeFileSync(join(root, "b.ts"), "b2");
    expect(await tracker.changed()).toEqual([edit(root, "b.ts")]);
});

test(`a file that became dirty during the command is the command's; one dirty before it is not`, async () => {
    const root = tree();
    writeFileSync(join(root, "old.ts"), "old");
    let dirty = [edit(root, "old.ts")];
    const tracker = createShellEditTracker(async () => dirty);
    await tick();
    tracker.before();
    await tick();
    writeFileSync(join(root, "new.ts"), "new");
    dirty = [edit(root, "old.ts"), edit(root, "new.ts")];
    expect(await tracker.changed()).toEqual([edit(root, "new.ts")]);
});

test(`a file the command only renamed is the command's, though its mtime never moved`, async () => {
    const root = tree();
    writeFileSync(join(root, "x.ts"), "x");
    utimesSync(join(root, "x.ts"), 1_000, 1_000);
    const tracker = createShellEditTracker(async () => [edit(root, "y.ts")]);
    await tick();
    tracker.before();
    await tick();
    renameSync(join(root, "x.ts"), join(root, "y.ts"));
    expect(await tracker.changed()).toEqual([edit(root, "y.ts")]);
});

test(`without a start before it, nothing is attributed to a command`, async () => {
    const root = tree();
    writeFileSync(join(root, "a.ts"), "a");
    const tracker = createShellEditTracker(async () => [edit(root, "a.ts")]);
    expect(await tracker.changed()).toEqual([]);
    // And a start is spent by the read that follows it: the next command starts from nothing.
    tracker.before();
    await tracker.changed();
    expect(await tracker.changed()).toEqual([]);
});

test(`a deleted or unreadable file, and a dirty list that cannot be read, attribute nothing`, async () => {
    const root = tree();
    writeFileSync(join(root, "gone.ts"), "x");
    const tracker = createShellEditTracker(async () => [edit(root, "gone.ts")]);
    tracker.before();
    rmSync(join(root, "gone.ts"));
    expect(await tracker.changed()).toEqual([]);
    const failing = createShellEditTracker(async () => {
        throw new Error("git is not here");
    });
    failing.before();
    expect(await failing.changed()).toEqual([]);
});
