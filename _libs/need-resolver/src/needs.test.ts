import { env } from "@intentic/graph";
import { expect, test } from "vitest";

import type { CloudflareIntent, HostIntent, IntentSet } from "./intent.js";
import { resolveNeeds } from "./needs.js";

const host: HostIntent = { id: "host", input: { address: "203.0.113.10", user: "deploy", sshKey: env("HOST_SSH_KEY") } };
const cloudflare: CloudflareIntent = { id: "cf", input: { apiToken: env("CLOUDFLARE_API_TOKEN") } };

test("an app derives the four host capabilities plus a domain", () => {
    const intent: IntentSet = {
        hosts: [host],
        cloudflare,
        users: [],
        teams: [],
        services: [],
        workspaces: [],
        backings: [],
        apps: [{ id: "app", on: "host", expose: "cf", environments: { prod: { domain: "app.example.com", branch: "main" } } }],
    };

    expect(resolveNeeds(intent)).toEqual([
        { capability: "source-control", scope: "host", plane: "control" },
        { capability: "docker-registry", scope: "host", plane: "control" },
        { capability: "infra-control", scope: "host", plane: "control" },
        { capability: "deployment-target", scope: "host", plane: "application" },
        { capability: "domain", scope: "cf", plane: "application" },
    ]);
});

test("multiple apps collapse to one set of needs on the shared host and cloud", () => {
    const intent: IntentSet = {
        hosts: [host],
        cloudflare,
        users: [],
        teams: [],
        services: [],
        workspaces: [],
        backings: [],
        apps: [
            { id: "one", on: "host", expose: "cf", environments: { prod: { domain: "one.example.com", branch: "main" } } },
            { id: "two", on: "host", expose: "cf", environments: { prod: { domain: "two.example.com", branch: "main" } } },
        ],
    };

    expect(resolveNeeds(intent)).toHaveLength(5);
});

test("no apps derive no needs", () => {
    expect(resolveNeeds({ hosts: [], users: [], teams: [], apps: [], services: [], workspaces: [], backings: [] })).toEqual([]);
});

test("a workspace tool must reference a declared service", () => {
    const intent: IntentSet = {
        hosts: [host],
        cloudflare,
        users: [],
        teams: [],
        services: [],
        workspaces: [{ id: "workspace", on: "host", expose: "cf", tools: ["ghost"] }],
        backings: [],
        apps: [],
    };
    expect(() => resolveNeeds(intent)).toThrow('workspace "workspace" exposes tool "ghost" that is not a declared service');
});

test("a workspace tool that names a declared service resolves cleanly", () => {
    const intent: IntentSet = {
        hosts: [host],
        cloudflare,
        users: [],
        teams: [],
        services: [{ id: "obs", kind: "signoz", on: "host", expose: "cf", domain: "signoz.example.com" }],
        workspaces: [{ id: "workspace", on: "host", expose: "cf", tools: ["obs"] }],
        backings: [],
        apps: [],
    };
    expect(() => resolveNeeds(intent)).not.toThrow();
});
