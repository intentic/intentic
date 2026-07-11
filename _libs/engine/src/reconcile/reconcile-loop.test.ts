import { compile, toNodeMap } from "@intentic/graph";
import { expect, test } from "vitest";

import type { Provider, Providers } from "../provider.js";
import { createFakeProviders } from "../providers/fake.js";
import { reconcile } from "./reconcile-loop.js";

const graph = compile(toNodeMap([{ id: "host", type: "host", inputs: { address: "1.2.3.4" }, explicitDependsOn: [] }]));
const config = (providers: Providers) => ({ providers, env: {}, log: () => {} });

test("reconcile converges in one iteration when apply settles and plan reads all-noop", async () => {
    const { providers } = createFakeProviders();
    const result = await reconcile(graph, config(providers), { maxIterations: 3 });
    expect(result.converged).toBe(true);
    expect(result.iterations).toBe(1);
    expect(result.outcome.steps).toEqual([{ id: "host", type: "host", action: "create" }]);
});

test("reconcile throws when state never reads true within the bound", async () => {
    // A provider that never observes its resource: every plan reports a create, so the graph never settles.
    const neverObserved: Provider = { read: async () => undefined, diff: () => ({ action: "noop" }), apply: async () => ({}) };
    await expect(reconcile(graph, config({ host: neverObserved }), { maxIterations: 2 })).rejects.toThrow("did not converge within 2");
});

test("reconcile rejects a non-positive bound", async () => {
    const { providers } = createFakeProviders();
    await expect(reconcile(graph, config(providers), { maxIterations: 0 })).rejects.toThrow("maxIterations >= 1");
});
