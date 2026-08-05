import type { SerializedValue } from "@intentic/graph";

import { env, isRef } from "@intentic/graph";
import type { ResourceType } from "@intentic/resources";
import { OUTPUTS } from "@intentic/resources";
import { expect, test } from "vitest";
import { graph } from "./__fixtures__/deploy.config.js";
import { defineStack } from "./index.js";

// The Ref<string> output props on a handle are the author-facing source of truth; OUTPUTS is the runtime
// mirror the engine reads. Walk one real handle of every author-facing type and assert the two agree.
// Output props carry an `output` (id.output refs); bare resource refs nested on a handle (app.repo, the
// deployments under app.environments) point at a resource, not an output, so they are excluded.
const outputPropsOf = (handle: object): string[] =>
    Object.entries(handle)
        .filter(([, value]) => isRef(value) && value.output !== undefined)
        .map(([key]) => key)
        .sort();

test("public handles' output refs match OUTPUTS exactly", () => {
    const handles: Partial<Record<ResourceType, object>> = {};

    defineStack((i) => {
        const host = i.have.host("host", { address: "203.0.113.10", user: "deploy", sshKey: env("HOST_SSH_KEY") });
        const cf = i.have.cloudflare("cf", { apiToken: env("CLOUDFLARE_API_TOKEN") });
        const app = i.want.app("app", { on: host, expose: cf, environments: { prod: { domain: "app.example.com", branch: "main" } } });
        handles["host"] = host;
        handles["cloudflare"] = cf;
        handles["repo"] = app.repo;
        handles["deployment"] = app.environments["prod"];
        handles["postgres"] = i.want.database("db", { on: host });
        handles["valkey"] = i.want.cache("cache", { on: host });
        handles["workspace"] = i.want.workspace("workspace", { on: host, expose: cf });
    }, "example.com");

    // The App handle is the author's composite (repo + environments), not a resource type, so it is not walked
    // here. host/cloudflare are author-facing handles (i.have.*); repo/deployment are nested on the app handle;
    // postgres/valkey are the backing-instance handles (i.want.database / cache).
    for (const type of ["host", "cloudflare", "deployment", "repo", "postgres", "valkey", "workspace"] as const) {
        const handle = handles[type];
        expect(handle, `no handle captured for type "${type}"`).toBeDefined();
        expect(outputPropsOf(handle as object)).toEqual([...OUTPUTS[type]].toSorted());
    }
});

// Every {$ref} the compiled graph carries must point at an output OUTPUTS declares for the target node's
// type. This covers the derived node types (forgejo/komodo/repo/deployment) as actually wired by the
// resolver, and guarantees the engine can resolve every reference.
const refKeysOf = (value: SerializedValue): string[] => {
    if (typeof value !== "object" || value === null) {
        return [];
    }
    if (Array.isArray(value)) {
        return value.flatMap(refKeysOf);
    }
    const record = value as Record<string, SerializedValue>;
    const dollarRef = record["$ref"];
    if (typeof dollarRef === "string") {
        return [dollarRef];
    }
    if ("$secret" in record) {
        return [];
    }
    return Object.values(record).flatMap(refKeysOf);
};

test("every graph ref resolves to an output declared in OUTPUTS", () => {
    const known = new Set(Object.keys(graph.resources));

    for (const node of Object.values(graph.resources)) {
        const refs = [
            ...Object.values(node.inputs).flatMap(refKeysOf),
            ...(node.readyWhen !== undefined && typeof node.readyWhen.url !== "string" ? [node.readyWhen.url.$ref] : []),
        ];
        for (const key of refs) {
            if (known.has(key)) {
                continue; // bare ref to a resource — no output to validate
            }
            const lastDot = key.lastIndexOf(".");
            const id = key.slice(0, lastDot);
            const output = key.slice(lastDot + 1);
            const target = graph.resources[id];
            expect(target, `ref "${key}" points at unknown resource "${id}"`).toBeDefined();
            if (target === undefined) {
                continue;
            }
            expect(OUTPUTS[target.type as ResourceType], `output "${output}" is not declared for type "${target.type}"`).toContain(output);
        }
    }
});
