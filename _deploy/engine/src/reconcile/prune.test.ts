import { compile, toNodeMap } from "@intentic/graph";
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
    expect(outcome.skipped).toEqual([{ id: "route", type: "cf-route", reason: "no-delete" }]);
});

test("a removed node with a protect:true input is skipped, even though its provider can delete", async () => {
    const deleted: string[] = [];
    const previous = compile(
        toNodeMap([host, { id: "db", type: "postgres", inputs: { protect: true, image: "postgres:17" }, explicitDependsOn: ["host"] }]),
    );
    const current = compile(toNodeMap([host]));

    const outcome = await prune(previous, current, config({ host: keptHost, postgres: deletable(deleted) }));

    expect(deleted).toEqual([]);
    expect(outcome.skipped).toEqual([{ id: "db", type: "postgres", reason: "protected" }]);
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

// The audit's "pruned node with a generated secret" failure: a removed node's own generated secret is no longer in the
// env (only the current graph's secrets are loaded), and resolving it used to throw "missing secret env var", failing
// every later apply. Deleting needs what identifies the resource, not the password its creation set.
test("a removed node whose creation-only secret is gone from the env is still deleted", async () => {
    const deleted: Array<{ id: string; username: unknown }> = [];
    const users: Provider = {
        read: async () => undefined,
        diff: () => ({ action: "noop" }),
        apply: async () => ({}),
        delete: async (inputs, ctx) => {
            deleted.push({ id: ctx.id, username: inputs["username"] });
        },
    };
    const previous = compile(
        toNodeMap([
            host,
            {
                id: "user-ann",
                type: "komodo-user",
                inputs: { username: "ann", password: { kind: "secret", source: "generated", key: "ANN_PASSWORD" } },
                explicitDependsOn: ["host"],
            },
        ]),
    );
    const current = compile(toNodeMap([host]));

    const outcome = await prune(previous, current, config({ host: keptHost, "komodo-user": users }));

    expect(deleted).toEqual([{ id: "user-ann", username: "ann" }]);
    expect(outcome.deleted).toEqual([{ id: "user-ann", type: "komodo-user" }]);
});

test("a removed node whose delete fails for want of a secret is skipped as missing-secret, naming it, and the rest still prune", async () => {
    const deleted: string[] = [];
    const needsToken: Provider = {
        read: async () => undefined,
        diff: () => ({ action: "noop" }),
        apply: async () => ({}),
        delete: async (inputs) => {
            if (inputs["apiToken"] !== "real") {
                throw new Error("HTTP 401");
            }
        },
    };
    const previous = compile(
        toNodeMap([
            host,
            {
                id: "route",
                type: "cf-route",
                inputs: { hostname: "a", apiToken: { kind: "secret", source: "env", key: "OLD_TOKEN" } },
                explicitDependsOn: ["host"],
            },
            { id: "deploy", type: "deployment", inputs: {}, explicitDependsOn: ["host"] },
        ]),
    );
    const current = compile(toNodeMap([host]));

    const outcome = await prune(previous, current, config({ host: keptHost, "cf-route": needsToken, deployment: deletable(deleted) }));

    expect(deleted).toEqual(["deploy"]);
    expect(outcome.skipped).toEqual([{ id: "route", type: "cf-route", reason: "missing-secret", missing: ["OLD_TOKEN"] }]);
});

test("a delete failure with every secret set still fails the prune", async () => {
    const failing: Provider = {
        read: async () => undefined,
        diff: () => ({ action: "noop" }),
        apply: async () => ({}),
        delete: async () => {
            throw new Error("HTTP 500");
        },
    };
    const previous = compile(toNodeMap([host, { id: "route", type: "cf-route", inputs: { hostname: "a" }, explicitDependsOn: ["host"] }]));
    await expect(prune(previous, compile(toNodeMap([host])), config({ host: keptHost, "cf-route": failing }))).rejects.toThrow("HTTP 500");
});

test("an aborted signal stops prune before its next delete", async () => {
    const deleted: string[] = [];
    const controller = new AbortController();
    controller.abort(new Error("apply lock lost"));
    const previous = compile(toNodeMap([host, { id: "route", type: "cf-route", inputs: { hostname: "a" }, explicitDependsOn: ["host"] }]));
    await expect(
        prune(previous, compile(toNodeMap([host])), { ...config({ host: keptHost, "cf-route": deletable(deleted) }), signal: controller.signal }),
    ).rejects.toThrow("apply lock lost");
    expect(deleted).toEqual([]);
});
