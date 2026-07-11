import type { DesiredStateGraph, Move } from "@intentic/graph";
import { describe, expect, it } from "vitest";
import type { Provider } from "../provider.js";
import type { EngineConfig } from "../types.js";
import { applyMoves, rewriteGraphForMoves } from "./moves.js";

// A node of an arbitrary stamp-keyed type, with no secret inputs so lenient resolution never throws.
const node = (id: string, dependsOn: string[] = []) => ({ id, type: "postgres", inputs: {}, dependsOn });

const graphOf = (resources: Record<string, ReturnType<typeof node>>, moved?: Move[]): DesiredStateGraph => ({
    version: 1,
    resources,
    ...(moved !== undefined ? { moved } : {}),
});

const stub: Pick<Provider, "read" | "diff" | "apply"> = {
    read: () => Promise.resolve(undefined),
    diff: () => ({ action: "noop" }),
    apply: () => Promise.resolve({}),
};

// A provider recording each restamp(oldId → ctx.id) it receives.
const restampingProvider = (): { provider: Provider; calls: Array<{ from: string; to: string }> } => {
    const calls: Array<{ from: string; to: string }> = [];
    return { calls, provider: { ...stub, restamp: (oldId, _inputs, ctx) => Promise.resolve(void calls.push({ from: oldId, to: ctx.id })) } };
};

const config = (providers: EngineConfig["providers"]): EngineConfig => ({ providers, env: {}, log: () => {} });

describe("applyMoves", () => {
    it("re-stamps a renamed resource in place (oldId → newId) via its provider", async () => {
        const { provider, calls } = restampingProvider();
        const graph = graphOf({ db2: node("db2") }, [{ from: "db", to: "db2" }]);
        const applied = await applyMoves(graph, config({ postgres: provider }));
        expect(calls).toEqual([{ from: "db", to: "db2" }]);
        expect(applied).toEqual([{ from: "db", to: "db2" }]);
    });

    it("skips (does not apply) a move whose type has no restamp, leaving it to recreate", async () => {
        const graph = graphOf({ db2: node("db2") }, [{ from: "db", to: "db2" }]);
        const applied = await applyMoves(graph, config({ postgres: stub as Provider }));
        expect(applied).toEqual([]);
    });

    it("throws when the move target is not in the desired state", async () => {
        const { provider } = restampingProvider();
        const graph = graphOf({ other: node("other") }, [{ from: "db", to: "db2" }]);
        await expect(applyMoves(graph, config({ postgres: provider }))).rejects.toThrow(/target "db2" is not in the desired state/);
    });

    it("throws when the source id still exists (a rename must remove the old id)", async () => {
        const { provider } = restampingProvider();
        const graph = graphOf({ db: node("db"), db2: node("db2") }, [{ from: "db", to: "db2" }]);
        await expect(applyMoves(graph, config({ postgres: provider }))).rejects.toThrow(/source "db" still exists/);
    });

    it("throws when from and to are identical", async () => {
        const { provider } = restampingProvider();
        const graph = graphOf({ db: node("db") }, [{ from: "db", to: "db" }]);
        await expect(applyMoves(graph, config({ postgres: provider }))).rejects.toThrow(/same id/);
    });

    it("is a no-op for a graph with no moves", async () => {
        const { provider, calls } = restampingProvider();
        expect(await applyMoves(graphOf({ db: node("db") }), config({ postgres: provider }))).toEqual([]);
        expect(calls).toHaveLength(0);
    });
});

describe("rewriteGraphForMoves", () => {
    it("renames a moved resource's key, id, and inbound dependsOn edges in the prune baseline", () => {
        const previous = graphOf({ db: node("db"), app: node("app", ["db"]) });
        const rewritten = rewriteGraphForMoves(previous, [{ from: "db", to: "db2" }]);
        expect(Object.keys(rewritten.resources).toSorted()).toEqual(["app", "db2"]);
        expect(rewritten.resources["db2"]?.id).toBe("db2");
        expect(rewritten.resources["app"]?.dependsOn).toEqual(["db2"]);
    });

    it("returns the graph unchanged when there are no moves", () => {
        const previous = graphOf({ db: node("db") });
        expect(rewriteGraphForMoves(previous, [])).toBe(previous);
    });

    it("makes prune see a moved id as kept: after rewrite, the renamed id matches the new graph", () => {
        // prune computes removed = previous \ current by key; rewriting promotes `db` → `db2` so it is no
        // longer in the removed set when the new graph declares `db2`.
        const previous = graphOf({ db: node("db") });
        const current = graphOf({ db2: node("db2") });
        const rewritten = rewriteGraphForMoves(previous, [{ from: "db", to: "db2" }]);
        const removed = Object.keys(rewritten.resources).filter((id) => current.resources[id] === undefined);
        expect(removed).toEqual([]);
    });
});
