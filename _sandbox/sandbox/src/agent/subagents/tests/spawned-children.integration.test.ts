import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { WORKSPACE_ROOT } from "@intentic/constants";
import {
    KEPT_REPORT_CHARS,
    restoredFate,
    type RestoredFacts,
    SETTLED_KEPT_MS,
    type SpawnedChild,
    spawnedChildren,
    spawnedChildrenDocument,
    specFromFile,
    specOnFile,
} from "../spawned-children.js";

// What a parent supervises its spawned children by, on file across a restart: the boot's decision for each child, and
// the files themselves.

const NOW = 50 * 24 * 3_600_000;
const child = (over: Partial<SpawnedChild> = {}): SpawnedChild => ({
    parent: "conv-parent",
    spec: { prompt: "Port the parser", provider: "claude", model: "claude-sonnet-4-6" },
    depth: 1,
    cwd: WORKSPACE_ROOT,
    startedAt: NOW - 1_000,
    state: "settled",
    ending: { status: "completed", at: NOW - 500 },
    turns: 1,
    at: NOW - 500,
    ...over,
});
const facts = (over: { child?: RestoredFacts["child"] | null; parent?: RestoredFacts["parent"] | null } = {}): RestoredFacts => ({
    child: over.child === null ? undefined : (over.child ?? { parent: "conv-parent" }),
    parent: over.parent === null ? undefined : (over.parent ?? { archived: false }),
});
const quiet = { warn: () => {} };

describe("what the boot does with a child on file", () => {
    it("brings back a child its parent still supervises", () => {
        expect(restoredFate(child(), facts(), NOW)).toEqual({ kind: "restore" });
    });

    it("strikes off one whose parent is gone or archived, naming which", () => {
        expect(restoredFate(child(), facts({ parent: null }), NOW)).toEqual({ kind: "drop", why: "the parent's conversation is gone" });
        expect(restoredFate(child(), facts({ parent: { archived: true } }), NOW)).toEqual({ kind: "drop", why: "the parent is archived" });
    });

    it("strikes off one whose own conversation is gone, or that the registry says another conversation started", () => {
        expect(restoredFate(child(), facts({ child: null }), NOW)).toEqual({ kind: "drop", why: "the child's conversation is gone" });
        expect(restoredFate(child(), facts({ child: { parent: "conv-other" } }), NOW)).toEqual({ kind: "drop", why: "the registry names another parent" });
    });

    it("lets a settled one go a fortnight after its ending, and never a running one", () => {
        const old = NOW - SETTLED_KEPT_MS - 1;
        expect(restoredFate(child({ ending: { status: "completed", at: old } }), facts(), NOW)).toEqual({ kind: "drop", why: "it settled long ago" });
        expect(restoredFate(child({ ending: { status: "completed", at: old + 2 } }), facts(), NOW)).toEqual({ kind: "restore" });
        expect(restoredFate(child({ state: "running", ending: undefined, at: old }), facts(), NOW)).toEqual({ kind: "restore" });
    });
});

describe("a child's file", () => {
    it("is one file per child under the history volume, read back as written", async () => {
        const root = await mkdtemp(join(tmpdir(), "spawned-children-"));
        const ledger = spawnedChildren(root, quiet);
        ledger.write("sub-a", child({ result: { value: { tests: 12 } } }));
        ledger.write("sub-b", child({ state: "running", ending: undefined }));
        expect((await ledger.list()).toSorted((left, right) => left.id.localeCompare(right.id))).toEqual([
            { id: "sub-a", ...child({ result: { value: { tests: 12 } } }) },
            { id: "sub-b", ...child({ state: "running", ending: undefined }) },
        ]);
        expect(JSON.parse(await readFile(join(root, spawnedChildrenDocument.path, "sub-b.json"), "utf8"))).toMatchObject({ state: "running" });
    });

    it("keeps its writes in order, and is struck off whole", async () => {
        const root = await mkdtemp(join(tmpdir(), "spawned-children-"));
        const ledger = spawnedChildren(root, quiet);
        ledger.write("sub-a", child({ state: "running", ending: undefined }));
        ledger.write("sub-a", child());
        expect(await ledger.list()).toEqual([{ id: "sub-a", ...child() }]);
        ledger.forget("sub-a");
        expect(await ledger.list()).toEqual([]);
    });

    it("cuts a report where a wait cuts it", async () => {
        const root = await mkdtemp(join(tmpdir(), "spawned-children-"));
        const ledger = spawnedChildren(root, quiet);
        ledger.write("sub-a", child({ report: "x".repeat(KEPT_REPORT_CHARS + 50) }));
        const [onFile] = await ledger.list();
        expect(onFile?.report?.length).toBe(KEPT_REPORT_CHARS);
    });
});

describe("a spawn on file", () => {
    it("comes back as the spawn it was, every knob only where it was named", () => {
        const spawn = {
            prompt: "go",
            provider: "cursor",
            model: "composer-2.5",
            effort: "high",
            fallbacks: [{ provider: "claude", model: "claude-sonnet-4-6" }],
            result: { schema: { type: "string" } },
        };
        expect(specFromFile(specOnFile(spawn))).toEqual(spawn);
        expect(Object.keys(specOnFile({ prompt: "go", provider: "claude", model: "claude-sonnet-4-6" }))).toEqual(["prompt", "provider", "model"]);
    });
});
