import { compile, toNodeMap } from "@intentic/graph";
import type { ListedResource, Provider } from "../provider.js";
import { createFakeProviders, type FakeWorld } from "../providers/fake.js";
import { apply } from "./apply.js";
import { classifyListed, collectOrphans } from "./orphans.js";
import { plan } from "./plan.js";
import { reconcile } from "./reconcile-loop.js";

const silent = (): void => {};
const listed = (id: string, owner?: string): ListedResource => ({ id, inputs: {}, ...(owner !== undefined ? { owner } : {}) });

describe("classifyListed: a stamped resource found on a shared host or zone", () => {
    const declared = new Set(["app"]);

    it("is this intent's orphan only when stamped with its owner and absent from the graph", () => {
        expect(classifyListed(listed("old-app", "aaa"), declared, "aaa")).toBe("orphan");
    });

    it("belongs to another intent when stamped with a different owner, declared id or not", () => {
        expect(classifyListed(listed("old-app", "bbb"), declared, "aaa")).toBe("theirs");
        expect(classifyListed(listed("app", "bbb"), declared, "aaa")).toBe("theirs");
    });

    it("is unowned when it carries no owner stamp (stamped before owners existed)", () => {
        expect(classifyListed(listed("old-app"), declared, "aaa")).toBe("unowned");
        expect(classifyListed(listed("old-app", ""), declared, "aaa")).toBe("unowned");
    });

    it("is declared when the graph has it, whether stamped by us or not yet adopted", () => {
        expect(classifyListed(listed("app", "aaa"), declared, "aaa")).toBe("declared");
        expect(classifyListed(listed("app"), declared, "aaa")).toBe("declared");
    });

    it("claims nothing for an intent with no owner of its own", () => {
        expect(classifyListed(listed("old-app", "aaa"), declared, undefined)).toBe("theirs");
        expect(classifyListed(listed("old-app"), declared, undefined)).toBe("unowned");
    });
});

const host = { id: "host", type: "host" as const, inputs: { address: "1.2.3.4" }, explicitDependsOn: [] };
const graph = compile(toNodeMap([host]));

test("collectOrphans splits what it finds by owner: only this intent's own orphans are prunable", async () => {
    const world: FakeWorld = new Map([
        ["host", { type: "host", inputs: {}, owner: "aaa" }],
        ["mine-gone", { type: "postgres", inputs: {}, owner: "aaa" }],
        ["theirs", { type: "postgres", inputs: {}, owner: "bbb" }],
        ["legacy", { type: "postgres", inputs: {} }],
    ]);
    const { providers } = createFakeProviders(world);

    const scan = await collectOrphans(graph, { providers, env: {}, log: silent, owner: "aaa" });

    expect(scan.orphans).toEqual([{ id: "mine-gone", type: "postgres", inputs: {} }]);
    expect(scan.unowned).toEqual([{ id: "legacy", type: "postgres" }]);
    expect(scan.foreign).toBe(1);
    // The declared host and the orphan both carry our owner: evidence this intent was applied before.
    expect(scan.owned).toBe(2);
    expect(scan.skipped).toEqual([]);
});

test("collectOrphans reports a source its provider could not read, once", async () => {
    const blind: Provider = {
        read: async () => undefined,
        diff: () => ({ action: "noop" }),
        apply: async () => ({}),
        list: async (_sources, ctx) => {
            ctx.skipped?.("host", "not reachable over SSH");
            ctx.skipped?.("host", "not reachable over SSH");
            return [];
        },
    };
    const scan = await collectOrphans(graph, { providers: { host: blind }, env: {}, log: silent, owner: "aaa" });
    expect(scan.skipped).toEqual([{ source: "host", reason: "not reachable over SSH" }]);
});

test("an unowned resource of the graph is adopted: plan reads update, apply re-stamps it, and the next plan is noop", async () => {
    // Created by a CLI from before owners: stamped, but with no owner.
    const world: FakeWorld = new Map([["host", { type: "host", inputs: {} }]]);
    const { providers } = createFakeProviders(world);
    const config = { providers, env: {}, log: silent, owner: "aaa" };

    const before = await plan(graph, config);
    expect(before.steps).toEqual([{ id: "host", type: "host", action: "update", reason: "adopting: stamp it as owned by intent aaa" }]);

    const result = await reconcile(graph, config, { maxIterations: 3 });
    expect(result.converged).toBe(true);
    expect(world.get("host")?.owner).toBe("aaa");
    expect((await plan(graph, config)).steps).toEqual([{ id: "host", type: "host", action: "noop" }]);
});

test("a resource of the graph stamped by another intent is refused, never taken over", async () => {
    const world: FakeWorld = new Map([["host", { type: "host", inputs: {}, owner: "bbb" }]]);
    const { providers } = createFakeProviders(world);
    const config = { providers, env: {}, log: silent, owner: "aaa" };

    await expect(apply(graph, config)).rejects.toThrow(/stamped as owned by intent "bbb", not this one \("aaa"\)/);
    expect(world.get("host")?.owner).toBe("bbb");
});

test("without an owner of its own, a run checks no ownership and stamps none", async () => {
    const world: FakeWorld = new Map([["host", { type: "host", inputs: {}, owner: "bbb" }]]);
    const { providers } = createFakeProviders(world);
    expect((await plan(graph, { providers, env: {}, log: silent })).steps).toEqual([{ id: "host", type: "host", action: "noop" }]);
});

test("an aborted signal stops apply before its next node", async () => {
    const { providers, world } = createFakeProviders();
    const controller = new AbortController();
    controller.abort(new Error("apply lock lost"));
    await expect(apply(graph, { providers, env: {}, log: silent, signal: controller.signal })).rejects.toThrow("apply lock lost");
    expect(world.size).toBe(0);
});
