import { env } from "@intentic/graph";
import type { IntentSet } from "@intentic/need-resolver";
import { expect, test } from "vitest";
import type { Catalog } from "./lib/catalog.js";
import { forgejoCatalog } from "./lib/catalog.js";
import { resolveState } from "./state.js";

const intent: IntentSet = {
    hosts: [{ id: "host", input: { address: "203.0.113.10", user: "deploy", sshKey: env("HOST_SSH_KEY") } }],
    cloudflare: { id: "cf", input: { apiToken: env("CLOUDFLARE_API_TOKEN") } },
    users: [],
    teams: [],
    apps: [{ id: "app", on: "host", expose: "cf", environments: { prod: { domain: "app.example.com", branch: "main" } } }],
    services: [],
    workspaces: [],
    backings: [],
};

test("the default catalog resolves intent to one desired-state graph built from the fixed stack", () => {
    const graph = resolveState(intent, "example.com");
    expect(graph.version).toBe(1);
    // Forgejo fills both source-control and docker-registry, so the shared option appears once.
    expect(Object.keys(graph.resources)).toContain("host-git");
    expect(Object.keys(graph.resources)).toContain("host-deploy");
});

test("no apps resolve to an empty desired state", () => {
    expect(resolveState({ hosts: [], users: [], teams: [], apps: [], services: [], workspaces: [], backings: [] })).toEqual({
        version: 1,
        resources: {},
    });
});

test("a need with no option throws", () => {
    const empty: Catalog = { optionsFor: (capability) => (capability === "infra-control" ? [] : forgejoCatalog.optionsFor(capability)) };
    expect(() => resolveState(intent, "example.com", empty)).toThrow('no option satisfies "infra-control"');
});

test("an ambiguous capability throws — the state resolver makes no choice", () => {
    const ambiguous: Catalog = {
        optionsFor: (capability) =>
            capability === "infra-control"
                ? [...forgejoCatalog.optionsFor(capability), { id: "nomad", provides: ["infra-control"] }]
                : forgejoCatalog.optionsFor(capability),
    };
    expect(() => resolveState(intent, "example.com", ambiguous)).toThrow(/ambiguous: "infra-control"/);
});
