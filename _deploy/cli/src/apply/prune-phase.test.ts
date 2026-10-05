import { createFakeProviders, type FakeWorld, type Provider, type Providers } from "@intentic/engine";
import type { DesiredStateGraph, ResourceNode } from "@intentic/graph";
import { type Baseline, pruneBase, type RetiredHost } from "./baseline.js";
import { runPrunePhase } from "./prune-phase.js";
import type { RetiredScan } from "./retired-hosts.js";

const node = (id: string, type: string, inputs: Record<string, unknown> = {}): ResourceNode => ({ id, type, inputs, dependsOn: [] }) as ResourceNode;
const graphOf = (...nodes: ResourceNode[]): DesiredStateGraph => ({
    version: 1,
    owner: "aaa",
    resources: Object.fromEntries(nodes.map((n) => [n.id, n])),
});
const host = node("host", "host");
const app = node("app", "deployment");
const silent = (): void => {};

// A kind with no `list` (a repo): only the baseline remembers it once it leaves the graph.
const unlisted = (world: FakeWorld, options: { readonly needs?: string } = {}): Provider => ({
    read: async (_inputs, ctx) => (world.has(ctx.id) ? { outputs: {} } : undefined),
    diff: () => ({ action: "noop" }),
    apply: async (inputs, _observed, ctx) => {
        world.set(ctx.id, { type: "repo", inputs });
        return {};
    },
    delete: async (inputs, ctx) => {
        if (options.needs !== undefined && inputs[options.needs] === "intentic-missing-secret") {
            throw new Error("HTTP 401");
        }
        world.delete(ctx.id);
    },
});

const setup = (): { world: FakeWorld; providers: Providers } => {
    const world: FakeWorld = new Map([
        ["host", { type: "host", inputs: {}, owner: "aaa" }],
        ["app", { type: "deployment", inputs: {}, owner: "aaa" }],
        ["old-repo", { type: "repo", inputs: {} }],
    ]);
    const { providers } = createFakeProviders(world);
    return { world, providers: { ...providers, repo: unlisted(world) } };
};

const run = (args: { graph: DesiredStateGraph; baseline: Baseline | undefined; providers: Providers; yes: boolean; retired?: RetiredScan[] }) =>
    runPrunePhase({
        graph: args.graph,
        base: args.baseline === undefined ? undefined : pruneBase(args.baseline),
        owner: "aaa",
        retired: args.retired ?? [],
        yes: args.yes,
        config: { providers: args.providers, env: {}, log: silent, owner: "aaa" },
    });

describe("deletions awaiting --yes", () => {
    it("leave the resource live, yet the baseline advances to the applied graph and keeps the removed node pending", async () => {
        const { world, providers } = setup();
        const previous: Baseline = { version: 1, owner: "aaa", resources: graphOf(host, app, node("old-repo", "repo")).resources };
        const next = graphOf(host, app, node("new-app", "deployment"));

        const phase = await run({ graph: next, baseline: previous, providers, yes: false });

        expect(phase.pending).toEqual([{ id: "old-repo", type: "repo" }]);
        expect(world.has("old-repo")).toBe(true);
        // Creations and updates advance: the applied graph is the new one...
        expect(Object.keys(phase.baseline.resources).toSorted()).toEqual(["app", "host", "new-app"]);
        // ...and the pending deletion is kept, not lost.
        expect(Object.keys(phase.baseline.pendingDeletion ?? {})).toEqual(["old-repo"]);
    });

    it("are pruned by a later --yes run from the baseline the waiting run left, which then forgets them", async () => {
        const { world, providers } = setup();
        const previous: Baseline = { version: 1, owner: "aaa", resources: graphOf(host, app, node("old-repo", "repo")).resources };
        const waited = await run({ graph: graphOf(host, app), baseline: previous, providers, yes: false });
        // Another change lands in between; the pending node must survive it too.
        const again = await run({ graph: graphOf(host, app), baseline: waited.baseline, providers, yes: false });
        expect(Object.keys(again.baseline.pendingDeletion ?? {})).toEqual(["old-repo"]);

        const confirmed = await run({ graph: graphOf(host, app), baseline: again.baseline, providers, yes: true });

        expect(confirmed.pruned.deleted).toEqual([{ id: "old-repo", type: "repo" }]);
        expect(world.has("old-repo")).toBe(false);
        expect(confirmed.baseline.pendingDeletion).toBeUndefined();
    });
});

test("a removed node whose delete needs a secret no longer set stays pending until the secret is back", async () => {
    const world: FakeWorld = new Map([["old-repo", { type: "repo", inputs: {} }]]);
    const { providers } = createFakeProviders(world);
    const withRepo = { ...providers, repo: unlisted(world, { needs: "token" }) };
    const gone = node("old-repo", "repo", { token: { $secret: { source: "env", key: "OLD_TOKEN" } } });
    const previous: Baseline = { version: 1, owner: "aaa", resources: { "old-repo": gone } };

    const phase = await run({ graph: graphOf(), baseline: previous, providers: withRepo, yes: true });

    expect(phase.pruned.skipped).toEqual([{ id: "old-repo", type: "repo", reason: "missing-secret", missing: ["OLD_TOKEN"] }]);
    expect(phase.baseline.pendingDeletion).toEqual({ "old-repo": gone });
    expect(world.has("old-repo")).toBe(true);
});

test("a protected removed node is left in place and dropped from tracking, as before", async () => {
    const { world, providers } = setup();
    const previous: Baseline = { version: 1, owner: "aaa", resources: { db: node("db", "postgres", { protect: true }) } };
    world.set("db", { type: "postgres", inputs: {}, owner: "aaa" });
    const phase = await run({ graph: graphOf(host, app), baseline: previous, providers, yes: true });
    expect(phase.pruned.skipped).toEqual([{ id: "db", type: "postgres", reason: "protected" }]);
    expect(phase.baseline.pendingDeletion).toBeUndefined();
});

test("the orphan scan prunes only this intent's own orphans; unowned and other intents' resources stay", async () => {
    const { world, providers } = setup();
    world.set("stray-mine", { type: "postgres", inputs: {}, owner: "aaa" });
    world.set("stray-theirs", { type: "postgres", inputs: {}, owner: "bbb" });
    world.set("stray-legacy", { type: "postgres", inputs: {} });

    const phase = await run({ graph: graphOf(host, app), baseline: { version: 1, resources: graphOf(host, app).resources }, providers, yes: true });

    expect(phase.pruned.deleted).toEqual([{ id: "stray-mine", type: "postgres" }]);
    expect(phase.scan.unowned).toEqual([{ id: "stray-legacy", type: "postgres" }]);
    expect(phase.scan.foreign).toBe(1);
    expect([...world.keys()].toSorted()).toEqual(["app", "host", "old-repo", "stray-legacy", "stray-theirs"]);
});

describe("a retired host", () => {
    const retiredHost: RetiredHost = { id: "host", address: "10.0.0.1", node: host, since: "2026-10-05" };

    it("has this intent's leftovers deleted with --yes, and is then dropped from the baseline as clean", async () => {
        // The fake world has no hosts, so the old machine's copy stays out of it (the current scan would find it there).
        const { providers } = setup();
        const retired: RetiredScan[] = [{ host: retiredHost, leftovers: [{ id: "forgejo", type: "forgejo", inputs: {} }], unowned: [] }];

        const waiting = await run({ graph: graphOf(host, app), baseline: undefined, providers, yes: false, retired });
        expect(waiting.pending).toEqual([{ id: "forgejo", type: "forgejo" }]);
        expect(waiting.baseline.retiredHosts).toEqual([retiredHost]);

        const pruned = await run({ graph: graphOf(host, app), baseline: undefined, providers, yes: true, retired });
        expect(pruned.pruned.deleted).toEqual([{ id: "forgejo", type: "forgejo" }]);
        expect(pruned.baseline.retiredHosts).toBeUndefined();
    });

    it("stays retired while it cannot be scanned, still runs something protected, or holds an unowned container", async () => {
        const { providers } = setup();
        const retired: RetiredScan[] = [
            { host: retiredHost, error: "connect ECONNREFUSED", leftovers: [], unowned: [] },
            { host: { ...retiredHost, address: "10.0.0.2" }, leftovers: [{ id: "db", type: "postgres", inputs: {}, protected: true }], unowned: [] },
            { host: { ...retiredHost, address: "10.0.0.3" }, leftovers: [], unowned: [{ id: "legacy", type: "outline" }] },
            { host: { ...retiredHost, address: "10.0.0.4" }, leftovers: [], unowned: [] },
        ];
        const phase = await run({ graph: graphOf(host, app), baseline: undefined, providers, yes: true, retired });
        expect(phase.baseline.retiredHosts?.map((retiredHost) => retiredHost.address)).toEqual(["10.0.0.1", "10.0.0.2", "10.0.0.3"]);
    });
});
