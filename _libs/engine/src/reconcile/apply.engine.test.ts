import { env, linearize } from "@intentic/graph";
import { defineStack } from "@intentic/sdk";
import { expect, test } from "vitest";
import { createFakeProviders } from "../providers/fake.js";
import { apply } from "./apply.js";
import { collectOrphans } from "./orphans.js";
import { plan } from "./plan.js";
import { pruneOrphans } from "./prune.js";

// The full secret set the example declaration references. The host SSH key and Cloudflare API token are
// secrets; the host address/user are authored literals and the Cloudflare zone/account are discovered, so
// they are not here. RESTIC_PASSWORD is the generated encryption password for the on-by-default backup.
const fullEnv = {
    HOST_SSH_KEY: "k",
    CLOUDFLARE_API_TOKEN: "k",
    FORGEJO_ADMIN_PASSWORD: "k",
    KOMODO_ADMIN_PASSWORD: "k",
    RESTIC_PASSWORD: "k",
    STAGING_DATABASE_URL: "k",
    PRODUCTION_DATABASE_URL: "k",
};

// Source the real graph from the authoring stack (build -> resolve -> compile), not a hand copy.
const buildGraph = () =>
    defineStack((i) => {
        const host = i.have.host("host", { address: "203.0.113.10", user: "deploy", sshKey: env("HOST_SSH_KEY") });
        const cf = i.have.cloudflare("cf", { apiToken: env("CLOUDFLARE_API_TOKEN") });
        i.want.app("my-app", {
            on: host,
            expose: cf,
            environments: {
                staging: { domain: "staging.example.com", branch: "develop", env: { DATABASE_URL: env("STAGING_DATABASE_URL") } },
                production: { domain: "app.example.com", branch: "main", env: { DATABASE_URL: env("PRODUCTION_DATABASE_URL") } },
            },
        });
    }, "example.com");

const trueProbe = async () => true;
const silent = () => {};

test("apply creates every resource in dependency order, then is idempotent", async () => {
    const graph = buildGraph();
    const { providers } = createFakeProviders();

    const first = await apply(graph, { providers, env: fullEnv, probe: trueProbe, log: silent });
    expect(first.steps).toHaveLength(16);
    expect(first.steps.every((step) => step.action === "create")).toBe(true);
    expect(first.steps.map((step) => step.id)).toEqual(linearize(graph));
    expect(Object.keys(first.outputs).toSorted()).toEqual(Object.keys(graph.resources).toSorted());
    expect(await collectOrphans(graph, { providers, env: fullEnv, log: silent })).toEqual([]);

    // Same providers (same world) => everything is found => all noop.
    const second = await apply(graph, { providers, env: fullEnv, probe: trueProbe, log: silent });
    expect(second.steps.every((step) => step.action === "noop")).toBe(true);
});

test("a re-apply does not health-gate unchanged (noop) resources", async () => {
    const graph = buildGraph();
    const { providers } = createFakeProviders();

    // First apply creates everything with a passing probe.
    await apply(graph, { providers, env: fullEnv, probe: trueProbe, log: silent });

    // Second apply finds the same world (all noop). A never-passing probe would make any readyWhen gate
    // time out — so the only way this succeeds is if noop resources are not health-gated at all.
    const second = await apply(graph, { providers, env: fullEnv, probe: async () => false, log: silent });
    expect(second.steps.every((step) => step.action === "noop")).toBe(true);
});

test("plan reports all create on an empty world and all noop after apply", async () => {
    const graph = buildGraph();

    const empty = createFakeProviders();
    const planned = await plan(graph, { providers: empty.providers, env: fullEnv, probe: trueProbe, log: silent });
    expect(planned.steps.every((step) => step.action === "create")).toBe(true);

    const live = createFakeProviders();
    await apply(graph, { providers: live.providers, env: fullEnv, probe: trueProbe, log: silent });
    const replanned = await plan(graph, { providers: live.providers, env: fullEnv, probe: trueProbe, log: silent });
    expect(replanned.steps.every((step) => step.action === "noop")).toBe(true);
});

test("a missing secret throws", async () => {
    const graph = buildGraph();
    const { providers } = createFakeProviders();
    const withoutHostKey = { ...fullEnv, HOST_SSH_KEY: undefined };
    await expect(apply(graph, { providers, env: withoutHostKey, probe: trueProbe, log: silent })).rejects.toThrow(
        'missing secret env var "HOST_SSH_KEY"',
    );
});

test("a node whose type has no provider throws", async () => {
    const graph = buildGraph();
    const { providers } = createFakeProviders();
    const { komodo: _komodo, ...withoutKomodo } = providers;
    await expect(apply(graph, { providers: withoutKomodo, env: fullEnv, probe: trueProbe, log: silent })).rejects.toThrow(
        'no provider registered for type "komodo"',
    );
});

test("an orphan (stamped, not in the graph) is detected and left intact by collectOrphans", async () => {
    const graph = buildGraph();
    const { providers, world } = createFakeProviders();
    world.set("ghost-host", { type: "host", inputs: {} });

    const orphans = await collectOrphans(graph, { providers, env: fullEnv, log: silent });
    expect(orphans).toContainEqual({ id: "ghost-host", type: "host", inputs: {} });
    expect(world.has("ghost-host")).toBe(true);
});

test("pruneOrphans tears down a stamped resource absent from the graph, leaving declared and protected ones alone", async () => {
    const graph = buildGraph();
    const { providers, world } = createFakeProviders();
    await apply(graph, { providers, env: fullEnv, probe: trueProbe, log: silent });
    world.set("ghost-host", { type: "host", inputs: {} });

    const config = { providers, env: fullEnv, log: silent };
    const orphans = await collectOrphans(graph, config);
    const outcome = await pruneOrphans([...orphans, { id: "guarded-db", type: "postgres", inputs: {}, protected: true }], config);
    expect(outcome.deleted).toEqual([{ id: "ghost-host", type: "host" }]);
    expect(outcome.skipped).toEqual([{ id: "guarded-db", type: "postgres" }]);
    expect(world.has("ghost-host")).toBe(false);
    expect(world.has("host")).toBe(true);
});

test("a stamped inputs-hash mismatch reads as update without consulting the provider's diff", async () => {
    const { compile, hashInputs, toNodeMap } = await import("@intentic/graph");
    const node = { id: "db", type: "postgres" as const, inputs: { image: "postgres:17" }, explicitDependsOn: [] };
    const graph = compile(toNodeMap([node]));
    const provider = (stampHash: string) => ({
        read: async () => ({ outputs: {}, stampHash }),
        diff: () => ({ action: "noop" }) as const,
        apply: async () => ({}),
    });

    const stale = await plan(graph, { providers: { postgres: provider("0000000000000000") }, env: {}, log: silent });
    expect(stale.steps).toEqual([{ id: "db", type: "postgres", action: "update", reason: "authored inputs changed since last stamped apply" }]);

    const fresh = await plan(graph, {
        providers: { postgres: provider(hashInputs(graph.resources["db"]?.inputs ?? {})) },
        env: {},
        log: silent,
    });
    expect(fresh.steps).toEqual([{ id: "db", type: "postgres", action: "noop" }]);
});

test("a referenced output that a provider failed to produce throws", async () => {
    const graph = buildGraph();
    const { providers } = createFakeProviders();
    const forgejo = providers["forgejo"];
    if (forgejo === undefined) {
        throw new Error("expected a forgejo provider");
    }
    const broken = { ...providers, forgejo: { ...forgejo, apply: async () => ({}) } };
    // host-git's own readyWhen gate now references its internal url, so that is the first ref to fail.
    await expect(apply(graph, { providers: broken, env: fullEnv, probe: trueProbe, log: silent })).rejects.toThrow(/host-git\.internalUrl/);
});
