import { compile, toNodeMap } from "@intentic/graph";
import { expect, test } from "vitest";
import type { Provider, Providers } from "../provider.js";
import { prune } from "./prune.js";

const config = (providers: Providers) => ({ providers, env: {}, log: () => {} });

// A host that always observes itself (so the current-graph read pass seeds its outputs), with no delete.
const keptHost: Provider = {
    read: async () => ({ outputs: { internalIp: "10.0.0.1", publicIp: "1.2.3.4" } }),
    diff: () => ({ action: "noop" }),
    apply: async () => ({}),
};

const deletable = (sink: string[]): Provider => ({
    read: async () => undefined,
    diff: () => ({ action: "noop" }),
    apply: async () => ({}),
    delete: async (_inputs, ctx) => {
        sink.push(ctx.id);
    },
});

const host = { id: "host", type: "host", inputs: { address: "1.2.3.4" }, explicitDependsOn: [] } as const;

test("deletes a resource removed from desired state, leaving the kept ones alone", async () => {
    const deleted: string[] = [];
    const previous = compile(toNodeMap([host, { id: "route", type: "cf-route", inputs: { hostname: "a" }, explicitDependsOn: ["host"] }]));
    const current = compile(toNodeMap([host]));

    const outcome = await prune(previous, current, config({ host: keptHost, "cf-route": deletable(deleted) }));

    expect(deleted).toEqual(["route"]);
    expect(outcome.deleted).toEqual([{ id: "route", type: "cf-route" }]);
    expect(outcome.skipped).toEqual([]);
});

test("deletes removed nodes in reverse dependency order (dependents before dependencies)", async () => {
    const order: string[] = [];
    const previous = compile(
        toNodeMap([
            host,
            { id: "route", type: "cf-route", inputs: { hostname: "a" }, explicitDependsOn: ["host"] },
            { id: "deploy", type: "deployment", inputs: {}, explicitDependsOn: ["route"] },
        ]),
    );
    const current = compile(toNodeMap([host]));

    await prune(previous, current, config({ host: keptHost, "cf-route": deletable(order), deployment: deletable(order) }));

    // deploy depends on route depends on host: dependents are torn down first.
    expect(order).toEqual(["deploy", "route"]);
});

test("a removed node whose provider has no delete is reported as skipped, never deleted", async () => {
    const noDelete: Provider = { read: async () => undefined, diff: () => ({ action: "noop" }), apply: async () => ({}) };
    const previous = compile(toNodeMap([host, { id: "route", type: "cf-route", inputs: { hostname: "a" }, explicitDependsOn: ["host"] }]));
    const current = compile(toNodeMap([host]));

    const outcome = await prune(previous, current, config({ host: keptHost, "cf-route": noDelete }));

    expect(outcome.deleted).toEqual([]);
    expect(outcome.skipped).toEqual([{ id: "route", type: "cf-route" }]);
});

test("a removed node with a protect:true input is skipped, even though its provider can delete", async () => {
    const deleted: string[] = [];
    const previous = compile(
        toNodeMap([host, { id: "db", type: "postgres", inputs: { protect: true, image: "postgres:17" }, explicitDependsOn: ["host"] }]),
    );
    const current = compile(toNodeMap([host]));

    const outcome = await prune(previous, current, config({ host: keptHost, postgres: deletable(deleted) }));

    expect(deleted).toEqual([]);
    expect(outcome.skipped).toEqual([{ id: "db", type: "postgres" }]);
});

test("is a no-op when nothing was removed", async () => {
    const graph = compile(toNodeMap([host]));
    const outcome = await prune(graph, graph, config({ host: keptHost }));
    expect(outcome).toEqual({ deleted: [], skipped: [] });
});

test("pruning to an empty graph (destroy) resolves a removed node's refs from other removed nodes' live outputs", async () => {
    // repo's delete needs forgejo's url: forgejo is ALSO being removed, so its outputs must be seeded by
    // reading it live before any deletion (reverse order then deletes repo while forgejo is still up).
    const order: Array<{ id: string; url?: unknown }> = [];
    const forgejo: Provider = {
        read: async () => ({ outputs: { url: "http://git.local" } }),
        diff: () => ({ action: "noop" }),
        apply: async () => ({}),
        delete: async (_inputs, ctx) => {
            order.push({ id: ctx.id });
        },
    };
    const repo: Provider = {
        read: async () => undefined,
        diff: () => ({ action: "noop" }),
        apply: async () => ({}),
        delete: async (inputs, ctx) => {
            order.push({ id: ctx.id, url: inputs["url"] });
        },
    };
    const previous = compile(
        toNodeMap([
            { id: "git", type: "forgejo", inputs: {}, explicitDependsOn: [] },
            { id: "repo", type: "repo", inputs: { url: { kind: "ref", resourceId: "git", output: "url" } }, explicitDependsOn: [] },
        ]),
    );

    const outcome = await prune(previous, compile(toNodeMap([])), config({ forgejo, repo }));

    expect(order).toEqual([{ id: "repo", url: "http://git.local" }, { id: "git" }]);
    expect(outcome.deleted).toEqual([
        { id: "repo", type: "repo" },
        { id: "git", type: "forgejo" },
    ]);
});
