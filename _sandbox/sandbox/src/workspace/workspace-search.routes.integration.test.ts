import { mkdir, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import type { WorkspaceSearchFrame } from "@intentic/sandbox-contract/schemas/workspace/workspace-search";
import { unstubbed } from "@intentic/testing";
import { createApp } from "../app.js";
import type { Services } from "../composition.js";
import { clientFor, errorCode } from "../harness/route-client.testing.js";
import { tempWorkspace } from "../harness/route-fakes.testing.js";
import { services } from "../harness/route-services.testing.js";

// The search box's text search over the daemon's HTTP surface, against a real temp workspace and a real rg: answered
// without the iq engine, paged out of one kept answer, and streamed.

// An engine that fails any ask: a text search that reached it would be a text search still waiting on its child.
const noEngine = (): Services["iq"] =>
    unstubbed<Services["iq"]>("iq", {
        run: async () => {
            throw new Error("a text search asked the iq engine");
        },
    });

const workspaceWith = async (files: Readonly<Record<string, string>>) => {
    const workspace = tempWorkspace([]);
    for (const [path, content] of Object.entries(files)) {
        await mkdir(dirname(join(workspace.root, path)), { recursive: true });
        await writeFile(join(workspace.root, path), content);
    }
    return workspace;
};

const FILES = {
    ".gitignore": "out/\n",
    "a/one.ts": "const needle = 1;\n",
    "b/two.ts": "needle();\nneedle();\n",
    "c/three.md": "a needle in prose\n",
    "out/built.js": "needle built\n",
    "node_modules/pkg/index.js": "needle installed\n",
};

test("a text search reads the tree with rg and never asks the engine; ignored files stay out unless asked for", async () => {
    const workspace = await workspaceWith(FILES);
    const client = clientFor(createApp(services({ workspace, iq: noEngine() })));
    const result = await client.workspace.search({ query: "needle", mode: "find", literal: "true" });
    expect(result.groups.map((group) => group.path)).toEqual(["a/one.ts", "b/two.ts", "c/three.md"]);
    expect(result).toMatchObject({ mode: "find", total: 4, files: 3, shown: 4, truncated: false, freshness: { state: "fresh" } });
    expect(result.groups[1]?.hits[0]).toEqual({ line: 1, text: "needle();", spans: [{ start: 0, end: 6 }], tags: [{ kind: "text" }] });

    const wide = await client.workspace.search({ query: "needle", mode: "find", literal: "true", includeIgnored: "true" });
    expect(wide.groups.map((group) => group.path)).toEqual(["a/one.ts", "b/two.ts", "c/three.md", "node_modules/pkg/index.js", "out/built.js"]);
});

test("the folder and the include box narrow a text search", async () => {
    const workspace = await workspaceWith(FILES);
    const client = clientFor(createApp(services({ workspace, iq: noEngine() })));
    const inB = await client.workspace.search({ query: "needle", mode: "find", dir: "./b/" });
    expect(inB.groups.map((group) => group.path)).toEqual(["b/two.ts"]);
    const typed = await client.workspace.search({ query: "needle", mode: "find", include: "*.ts, !b" });
    expect(typed.groups.map((group) => group.path)).toEqual(["a/one.ts"]);
});

test("Load more is a slice of the answer the first page came from, not a second scan", async () => {
    const workspace = await workspaceWith(FILES);
    const client = clientFor(createApp(services({ workspace, iq: noEngine() })));
    const first = await client.workspace.search({ query: "needle", mode: "find", limit: 2 });
    expect(first.groups.map((group) => group.path)).toEqual(["a/one.ts", "b/two.ts"]);
    expect(first.truncated).toBe(true);
    expect(first.cursor).toEqual(expect.any(String));
    // A match written after the first page is not in the answer the cursor names.
    await writeFile(join(workspace.root, "a/zero.ts"), "needle again\n");
    const next = await client.workspace.search({ query: "needle", mode: "find", limit: 2, after: first.cursor });
    expect(next.groups.map((group) => group.path)).toEqual(["c/three.md"]);
    expect(next).toMatchObject({ total: 4, files: 3, truncated: false });
    // A cursor whose answer is not kept (another daemon, a restart) scans again, the new file in, and slices at the
    // offset it names.
    const stale = await client.workspace.search({ query: "needle", mode: "find", limit: 2, after: "gone.2" });
    expect(stale.groups.map((group) => group.path)).toEqual(["b/two.ts", "c/three.md"]);
    expect(stale.files).toBe(4);
});

test("a pattern rg cannot read runs as plain text and says so", async () => {
    const workspace = await workspaceWith({ "a/x.ts": "call(needle\n" });
    const client = clientFor(createApp(services({ workspace, iq: noEngine() })));
    const result = await client.workspace.search({ query: "call(needle", mode: "find" });
    expect(result.groups.map((group) => group.path)).toEqual(["a/x.ts"]);
    expect(result.note).toContain("ran as literal text");
});

const framesOf = async (iterator: AsyncIterable<WorkspaceSearchFrame>): Promise<WorkspaceSearchFrame[]> => {
    const frames: WorkspaceSearchFrame[] = [];
    for await (const frame of iterator) {
        frames.push(frame);
    }
    return frames;
};

test("the stream sends files as they are found, then the same first page the search route answers", async () => {
    const workspace = await workspaceWith(FILES);
    const client = clientFor(createApp(services({ workspace, iq: noEngine() })));
    const frames = await framesOf(await client.workspace.searchStream({ query: "needle", mode: "find", limit: 2 }));
    const done = frames.at(-1);
    expect(done?.kind).toBe("done");
    const page = await client.workspace.search({ query: "needle", mode: "find", limit: 2 });
    expect(done?.kind === "done" ? { ...done.result, cursor: undefined } : undefined).toEqual({ ...page, cursor: undefined });
    // Provisional files never run past a page.
    const provisional = frames.flatMap((frame) => (frame.kind === "groups" ? frame.groups : []));
    expect(provisional.length).toBeLessThanOrEqual(2);
    // Its cursor pages on through the answer the stream kept.
    const next = await client.workspace.search({
        query: "needle",
        mode: "find",
        limit: 2,
        after: done?.kind === "done" ? done.result.cursor : undefined,
    });
    expect(next.groups.map((group) => group.path)).toEqual(["c/three.md"]);
});

test("only a text search streams", async () => {
    const workspace = await workspaceWith(FILES);
    const client = clientFor(createApp(services({ workspace, iq: noEngine() })));
    expect(await errorCode(framesOf(await client.workspace.searchStream({ query: "needle", mode: "q" })))).toBe("BAD_REQUEST");
});
