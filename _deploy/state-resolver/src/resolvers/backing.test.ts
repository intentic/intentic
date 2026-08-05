import { env } from "@intentic/graph";
import type { CloudflareIntent, HostIntent, IntentSet } from "@intentic/need-resolver";
import { needKey, resolveNeeds } from "@intentic/need-resolver";
import { expect, test } from "vitest";
import type { Assignment } from "../emit/emit.js";
import { emit } from "../emit/emit.js";
import { forgejoCatalog } from "../lib/catalog.js";

const host: HostIntent = { id: "host", input: { address: "203.0.113.10", user: "deploy", sshKey: env("HOST_SSH_KEY") } };
const cloudflare: CloudflareIntent = { id: "cf", input: { apiToken: env("CLOUDFLARE_API_TOKEN") } };

const assign = (intent: IntentSet): Assignment => {
    const byNeed = new Map<string, string>();
    for (const need of resolveNeeds(intent)) {
        byNeed.set(needKey(need), forgejoCatalog.optionsFor(need.capability)[0]!.id);
    }
    return { byNeed };
};

// An app that uses a database + a cache, with both instances declared on the host.
const intentWithBindings: IntentSet = {
    hosts: [host],
    cloudflare,
    users: [],
    teams: [],
    services: [],
    workspaces: [],
    backings: [
        { id: "db", capability: "database", on: "host" },
        { id: "cache", capability: "cache", on: "host" },
    ],
    apps: [
        {
            id: "app",
            on: "host",
            expose: "cf",
            use: [
                { capability: "database", target: "db" },
                { capability: "cache", target: "cache" },
            ],
            environments: { prod: { domain: "app.example.com", branch: "main" } },
        },
    ],
};

const nodesById = (intent: IntentSet) => new Map(emit(intent, assign(intent), "example.com").map((node) => [node.id, node]));

test("a backing instance is emitted as an internal-only node with no Cloudflare route", () => {
    const nodes = nodesById(intentWithBindings);
    const db = nodes.get("db");
    expect(db?.type).toBe("postgres");
    // Internal-only: the database/cache instances add NO cf-route. Only the platform's git/deploy routes and
    // the app's own route exist — none reference the backing instances.
    const routeIds = [...nodes.values()].filter((node) => node.type === "cf-route").map((node) => node.id);
    expect(routeIds).toEqual(["cf-git-example-com", "cf-deploy-example-com", "cf-app-example-com"]);
});

test("a per-app binding node is emitted per (app, instance) and depends on the instance", () => {
    const nodes = nodesById(intentWithBindings);
    const dbBinding = nodes.get("app-uses-db");
    const cacheBinding = nodes.get("app-uses-cache");
    expect(dbBinding?.type).toBe("postgres-database");
    expect(cacheBinding?.type).toBe("valkey-namespace");
    expect(dbBinding?.explicitDependsOn).toContain("db");
    expect(cacheBinding?.explicitDependsOn).toContain("cache");
    // The binding deploys onto the instance's host (SSH block present) and targets the instance by id.
    expect(dbBinding?.inputs["instance"]).toBe("db");
    expect(dbBinding?.inputs["address"]).toBe("203.0.113.10");
});

test("the deployment receives the binding connection env vars (DATABASE_URL, VALKEY_URL + REDIS_URL alias) and depends on each binding", () => {
    const nodes = nodesById(intentWithBindings);
    const deployment = nodes.get("app.prod");
    const envVars = deployment?.inputs["env"] as Record<string, unknown>;
    expect(envVars["DATABASE_URL"]).toEqual({ kind: "ref", resourceId: "app-uses-db", output: "url" });
    expect(envVars["VALKEY_URL"]).toEqual({ kind: "ref", resourceId: "app-uses-cache", output: "url" });
    expect(envVars["REDIS_URL"]).toEqual({ kind: "ref", resourceId: "app-uses-cache", output: "url" });
    expect(deployment?.explicitDependsOn).toEqual(expect.arrayContaining(["app-uses-db", "app-uses-cache"]));
});

test("an author env var overrides an injected binding var (binding spread before author env)", () => {
    const intent: IntentSet = {
        ...intentWithBindings,
        apps: [
            {
                ...intentWithBindings.apps[0]!,
                environments: { prod: { domain: "app.example.com", branch: "main", env: { DATABASE_URL: "postgres://custom" } } },
            },
        ],
    };
    const deployment = nodesById(intent).get("app.prod");
    expect(deployment).toBeDefined();
    expect((deployment!.inputs["env"] as Record<string, unknown>)["DATABASE_URL"]).toBe("postgres://custom");
});

test("using an undeclared backing is a descriptive error", () => {
    const intent: IntentSet = {
        ...intentWithBindings,
        workspaces: [],
        backings: [],
        apps: [{ ...intentWithBindings.apps[0]!, use: [{ capability: "database", target: "ghost" }] }],
    };
    expect(() => emit(intent, assign(intent), "example.com")).toThrow(/uses unknown backing "ghost"/);
});

test("using a backing at the wrong capability is a descriptive error", () => {
    const intent: IntentSet = {
        ...intentWithBindings,
        apps: [{ ...intentWithBindings.apps[0]!, use: [{ capability: "cache", target: "db" }] }],
    };
    expect(() => emit(intent, assign(intent), "example.com")).toThrow(/uses "db" as cache but it is a database/);
});

test("a backing on an undeclared host is rejected (caught at need resolution)", () => {
    const intent: IntentSet = { ...intentWithBindings, backings: [{ id: "db", capability: "database", on: "ghost" }], apps: [] };
    expect(() => assign(intent)).toThrow(/targets undeclared host "ghost"/);
});

// An app using an auth (Authentik) + object-storage (Garage) backing; auth is always routed, storage is given
// a domain so it routes too.
const intentWithAuthAndStorage: IntentSet = {
    hosts: [host],
    cloudflare,
    users: [],
    teams: [],
    services: [],
    workspaces: [],
    backings: [
        { id: "auth", capability: "auth", on: "host", expose: "cf", domain: "auth.example.com" },
        { id: "store", capability: "object-storage", on: "host", expose: "cf", domain: "s3.example.com" },
    ],
    apps: [
        {
            id: "app",
            on: "host",
            expose: "cf",
            use: [
                { capability: "auth", target: "auth" },
                { capability: "object-storage", target: "store" },
            ],
            environments: { prod: { domain: "app.example.com", branch: "main" } },
        },
    ],
};

test("an auth instance is emitted as an authentik node that always routes (the OIDC issuer is public)", () => {
    const nodes = nodesById(intentWithAuthAndStorage);
    expect(nodes.get("auth")?.type).toBe("authentik");
    expect(nodes.has("cf-auth-example-com")).toBe(true);
});

test("an object-storage instance routes only when given a domain", () => {
    const nodes = nodesById(intentWithAuthAndStorage);
    expect(nodes.get("store")?.type).toBe("garage");
    expect(nodes.has("cf-s3-example-com")).toBe(true);
    // Without a domain it is internal-only — no route.
    const internal: IntentSet = {
        ...intentWithAuthAndStorage,
        workspaces: [],
        backings: [{ id: "store", capability: "object-storage", on: "host" }],
        apps: [{ ...intentWithAuthAndStorage.apps[0]!, use: [{ capability: "object-storage", target: "store" }] }],
    };
    expect(nodesById(internal).has("cf-s3-example-com")).toBe(false);
});

test("the auth binding injects OIDC_* env, depends on the instance + its route, and whitelists the app domains", () => {
    const nodes = nodesById(intentWithAuthAndStorage);
    const binding = nodes.get("app-uses-auth");
    expect(binding?.type).toBe("authentik-client");
    expect(binding?.inputs["redirectDomains"]).toEqual(["app.example.com"]);
    expect(binding?.explicitDependsOn).toEqual(expect.arrayContaining(["auth", "cf-auth-example-com"]));
    const envVars = nodes.get("app.prod")?.inputs["env"] as Record<string, unknown>;
    expect(envVars["OIDC_ISSUER"]).toEqual({ kind: "ref", resourceId: "app-uses-auth", output: "issuer" });
    expect(envVars["OIDC_CLIENT_ID"]).toEqual({ kind: "ref", resourceId: "app-uses-auth", output: "clientId" });
    expect(envVars["OIDC_CLIENT_SECRET"]).toEqual({ kind: "ref", resourceId: "app-uses-auth", output: "clientSecret" });
});

test("the object-storage binding injects S3_* env and depends on the instance", () => {
    const nodes = nodesById(intentWithAuthAndStorage);
    const binding = nodes.get("app-uses-store");
    expect(binding?.type).toBe("garage-bucket");
    expect(binding?.inputs["bucket"]).toBe("app");
    expect(binding?.explicitDependsOn).toContain("store");
    const envVars = nodes.get("app.prod")?.inputs["env"] as Record<string, unknown>;
    expect(envVars["S3_ENDPOINT"]).toEqual({ kind: "ref", resourceId: "app-uses-store", output: "endpoint" });
    expect(envVars["S3_ACCESS_KEY"]).toEqual({ kind: "ref", resourceId: "app-uses-store", output: "accessKey" });
    expect(envVars["S3_SECRET_KEY"]).toEqual({ kind: "ref", resourceId: "app-uses-store", output: "secretKey" });
    expect(envVars["S3_BUCKET"]).toEqual({ kind: "ref", resourceId: "app-uses-store", output: "bucket" });
});
