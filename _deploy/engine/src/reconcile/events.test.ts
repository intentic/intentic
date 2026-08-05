import { compile, toNodeMap } from "@intentic/graph";
import { expect, test } from "vitest";
import type { Provider, Providers } from "../provider.js";
import { createFakeProviders, type FakeWorld } from "../providers/fake.js";
import type { EngineEvent } from "../types.js";
import { apply } from "./apply.js";
import { collectOrphans } from "./orphans.js";
import { prune } from "./prune.js";
import { reconcile } from "./reconcile-loop.js";

const host = { id: "host", type: "host" as const, inputs: { address: "1.2.3.4" }, explicitDependsOn: [] };
const graph = compile(toNodeMap([host]));
const config = (providers: Providers, onEvent: (event: EngineEvent) => void) => ({ providers, env: {}, log: () => {}, onEvent });
const collect = () => {
    const events: EngineEvent[] = [];
    return { events, onEvent: (event: EngineEvent) => events.push(event) };
};

test("apply emits node start and done (with the action) for each resource", async () => {
    const { events, onEvent } = collect();
    const { providers } = createFakeProviders();
    await apply(graph, config(providers, onEvent));
    expect(events).toContainEqual({ kind: "node", phase: "apply", state: "start", id: "host", type: "host" });
    expect(events).toContainEqual({ kind: "node", phase: "apply", state: "done", id: "host", type: "host", action: "create" });
});

test("reconcile emits one iteration event marking convergence", async () => {
    const { events, onEvent } = collect();
    const { providers } = createFakeProviders();
    await reconcile(graph, config(providers, onEvent), { maxIterations: 3 });
    expect(events.filter((event) => event.kind === "iteration")).toEqual([{ kind: "iteration", n: 1, converged: true }]);
});

test("collectOrphans emits an orphan event for a stamped resource absent from the graph", async () => {
    const { events, onEvent } = collect();
    const world: FakeWorld = new Map([["stray", { type: "host", inputs: {} }]]);
    const { providers } = createFakeProviders(world);
    await collectOrphans(graph, config(providers, onEvent));
    expect(events).toContainEqual({ kind: "orphan", id: "stray", type: "host" });
});

test("prune emits a skipped event when the removed resource's provider has no delete", async () => {
    const { events, onEvent } = collect();
    const previous = compile(toNodeMap([host, { id: "gone", type: "host", inputs: { address: "5.6.7.8" }, explicitDependsOn: [] }]));
    const noDelete: Provider = { read: async () => undefined, diff: () => ({ action: "noop" }), apply: async () => ({}) };
    await prune(previous, graph, config({ host: noDelete }, onEvent));
    expect(events).toContainEqual({ kind: "prune", state: "skipped", id: "gone", type: "host", reason: "no-delete" });
});

test("prune emits a deleted event when the provider can delete", async () => {
    const { events, onEvent } = collect();
    const deletable: Provider = { read: async () => undefined, diff: () => ({ action: "noop" }), apply: async () => ({}), delete: async () => {} };
    const previous = compile(toNodeMap([host, { id: "gone", type: "host", inputs: { address: "5.6.7.8" }, explicitDependsOn: [] }]));
    await prune(previous, graph, { providers: { host: deletable }, env: {}, log: () => {}, onEvent });
    expect(events).toContainEqual({ kind: "prune", state: "deleted", id: "gone", type: "host" });
});
