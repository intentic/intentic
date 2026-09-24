import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { WorkspaceTreeDelta } from "@intentic/sandbox-contract";
import { waitFor } from "@intentic/testing/bun";
import pino from "pino";
import { walkWorkspaceTree } from "../files/workspace-tree.js";
import { residentWorkspaceTree, startWorkspaceWatch, subscribeTreeChanges } from "./workspace-watch.js";

// The watcher's thread holding the shared tree, end to end: a real write reaches the thread as a batch, the thread
// re-lists what it touched, a delta comes out, and the view it answers is still the one a fresh walk would give.

const root = mkdtempSync(join(tmpdir(), "resident-watch-"));

// Whether a delta lists this path among some folder's entries now.
const lists = (delta: WorkspaceTreeDelta, path: string): boolean => delta.dirs.some((dir) => dir.entries.some((entry) => entry.path === path));

afterAll(() => rmSync(root, { recursive: true, force: true }));

test("a write becomes a delta, and the tree it leaves is the walk's", async () => {
    writeFileSync(join(root, "a.md"), "a");
    startWorkspaceWatch(root, pino({ level: "silent" }));
    const deltas: WorkspaceTreeDelta[] = [];
    subscribeTreeChanges((delta) => deltas.push(delta));
    const first = await residentWorkspaceTree(root)!;
    const { generation, ...listed } = first;
    expect(listed).toEqual(await walkWorkspaceTree(root));

    writeFileSync(join(root, "b.md"), "bb");
    await waitFor(() => expect(deltas.some((delta) => lists(delta, "b.md"))).toBe(true), { timeout: 10_000 });
    expect(deltas[0]?.from).toBe(generation);
    const { generation: after, ...relisted } = await residentWorkspaceTree(root)!;
    expect(after).toBe(deltas.at(-1)?.generation);
    expect(relisted).toEqual(await walkWorkspaceTree(root));
    // Any other root, a conversation's own checkout, is walked: the thread holds only the one it watches.
    expect(residentWorkspaceTree(join(root, "elsewhere"))).toBeUndefined();
});
