import { chmod, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { OrphanScan } from "@intentic/engine";
import type { DesiredStateGraph, ResourceNode } from "@intentic/graph";
import {
    type Baseline,
    checkFirstApply,
    loadBaseline,
    mergeRetiredHosts,
    nextBaseline,
    pruneBase,
    readBaseline,
    removedNodes,
    type RetiredHost,
} from "./baseline.js";

const node = (id: string, type = "deployment", dependsOn: string[] = [], inputs: Record<string, unknown> = {}): ResourceNode =>
    ({ id, type, inputs, dependsOn }) as ResourceNode;
const graphOf = (...nodes: ResourceNode[]): DesiredStateGraph => ({ version: 1, resources: Object.fromEntries(nodes.map((n) => [n.id, n])) });
const tmp = () => mkdtemp(join(tmpdir(), "intentic-baseline-"));
const scanOf = (overrides: Partial<OrphanScan> = {}): OrphanScan => ({ orphans: [], unowned: [], foreign: 0, owned: 0, skipped: [], ...overrides });

describe("readBaseline: a missing baseline is not an unreadable one", () => {
    it("reads undefined only when the file does not exist", async () => {
        expect(await readBaseline(join(await tmp(), "absent.json"))).toBeUndefined();
    });

    it("throws on invalid JSON, a wrong shape, and an unreadable file, never answering 'no baseline'", async () => {
        const dir = await tmp();
        await writeFile(join(dir, "torn.json"), '{"version":1,"resources":{');
        await expect(readBaseline(join(dir, "torn.json"))).rejects.toThrow(/not valid JSON/);
        await writeFile(join(dir, "other.json"), '{"version":2,"resources":{}}');
        await expect(readBaseline(join(dir, "other.json"))).rejects.toThrow(/is not a baseline/);
        if (process.getuid?.() !== 0) {
            await writeFile(join(dir, "locked.json"), "{}");
            await chmod(join(dir, "locked.json"), 0o000);
            await expect(readBaseline(join(dir, "locked.json"))).rejects.toThrow(/cannot read the prune baseline/);
        }
    });

    it("reads a plain artifact (a legacy baseline, the intentic-applied tag's) as a baseline with nothing pending", async () => {
        const dir = await tmp();
        await writeFile(join(dir, "legacy.json"), JSON.stringify(graphOf(node("app"))));
        expect(await readBaseline(join(dir, "legacy.json"))).toEqual(graphOf(node("app")));
    });
});

describe("loadBaseline", () => {
    it("stops the run on an unreadable baseline unless --first-apply says to start a new one", async () => {
        const dir = await tmp();
        const path = join(dir, ".last-applied.json");
        await writeFile(path, "not json");
        await expect(loadBaseline(path, { explicit: false, firstApply: false, note: () => {} })).rejects.toThrow(/Nothing was applied or pruned/);
        const notes: string[] = [];
        expect(await loadBaseline(path, { explicit: false, firstApply: true, note: (line) => notes.push(line) })).toBeUndefined();
        expect(notes[0]).toContain("--first-apply: ignoring the unreadable prune baseline");
    });

    it("treats a missing --previous file as an error, and a missing default file as the caller's question", async () => {
        const path = join(await tmp(), "previous.json");
        await expect(loadBaseline(path, { explicit: true, firstApply: false, note: () => {} })).rejects.toThrow(/given with --previous/);
        expect(await loadBaseline(path, { explicit: false, firstApply: false, note: () => {} })).toBeUndefined();
    });
});

describe("checkFirstApply: no baseline file, so ask what is live", () => {
    const path = "desired-state/.last-applied.json";

    it("allows a first apply, with a clear line, when nothing live carries this intent's owner", async () => {
        const line = await checkFirstApply({
            path,
            owner: "aaa",
            firstApply: false,
            scan: async () => scanOf({ unowned: [{ id: "x", type: "postgres" }] }),
        });
        expect(line).toMatch(/^first apply: no prune baseline at desired-state\/\.last-applied\.json/);
    });

    it("refuses when this intent's resources are live: the baseline was lost, and nothing is applied or pruned", async () => {
        await expect(checkFirstApply({ path, owner: "aaa", firstApply: false, scan: async () => scanOf({ owned: 3 }) })).rejects.toThrow(
            /3 live resource\(s\) carry this intent's owner stamp \(aaa\): it was applied before and its baseline is lost/,
        );
    });

    it("refuses when the scan could not look everywhere, since an unreached host may hold the evidence", async () => {
        await expect(
            checkFirstApply({
                path,
                owner: "aaa",
                firstApply: false,
                scan: async () => scanOf({ skipped: [{ source: "host", reason: "not reachable over SSH" }] }),
            }),
        ).rejects.toThrow(/cannot be told: the scan could not read host/);
    });

    it("lets --first-apply through without scanning, and says so", async () => {
        let scanned = false;
        const line = await checkFirstApply({
            path,
            owner: "aaa",
            firstApply: true,
            scan: async () => {
                scanned = true;
                return scanOf({ owned: 3 });
            },
        });
        expect(scanned).toBe(false);
        expect(line).toContain("first apply (--first-apply)");
    });

    it("cannot check without an owner, and says why", async () => {
        expect(await checkFirstApply({ path, owner: undefined, firstApply: false, scan: async () => scanOf({ owned: 3 }) })).toContain("no owner id");
    });
});

test("pruneBase joins the applied graph and its pending deletions, dropping edges to nodes neither holds", () => {
    const baseline: Baseline = {
        version: 1,
        owner: "aaa",
        resources: graphOf(node("host", "host"), node("app", "deployment", ["host"])).resources,
        pendingDeletion: { "old-repo": node("old-repo", "repo", ["gone-forge"]) },
    };
    const base = pruneBase(baseline);
    expect(Object.keys(base.resources).toSorted()).toEqual(["app", "host", "old-repo"]);
    expect(base.resources["old-repo"]?.dependsOn).toEqual([]);
    expect(base.resources["app"]?.dependsOn).toEqual(["host"]);
    expect(base.owner).toBe("aaa");
    // What the current graph dropped, pending ones included.
    expect(removedNodes(base, graphOf(node("host", "host"))).map((n) => n.id)).toEqual(["old-repo", "app"]);
});

test("nextBaseline writes only the sections that hold something", () => {
    expect(nextBaseline({ graph: graphOf(node("app")), owner: undefined, pending: [], retiredHosts: [] })).toEqual({
        version: 1,
        resources: graphOf(node("app")).resources,
    });
    const retired: RetiredHost = { id: "host", address: "10.0.0.1", node: node("host", "host"), since: "2026-10-05" };
    expect(nextBaseline({ graph: graphOf(node("app")), owner: "aaa", pending: [node("old")], retiredHosts: [retired] })).toEqual({
        version: 1,
        owner: "aaa",
        resources: graphOf(node("app")).resources,
        pendingDeletion: { old: node("old") },
        retiredHosts: [retired],
    });
});

test("mergeRetiredHosts keeps one entry per old machine and drops one a current host uses again", () => {
    const old = (address: string): RetiredHost => ({ id: "host", address, node: node("host", "host", [], { address }), since: "2026-10-05" });
    const current = graphOf(node("host", "host", [], { address: "10.0.0.9" }), node("edge", "host", [], { address: "10.0.0.2" }));
    expect(mergeRetiredHosts([old("10.0.0.1")], [old("10.0.0.1"), old("10.0.0.2")], current)).toEqual([old("10.0.0.1")]);
});
