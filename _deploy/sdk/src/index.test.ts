import type { RawNode } from "@intentic/graph";

import { compile, env, httpOk, linearize, subgraph } from "@intentic/graph";
import { expect, test } from "vitest";
import { defineStack, type Stack } from "./index.js";

// The authored inventory the stack tests wire their apps to (on: host, expose: cf).
const inventory = (i: Stack) => ({
    host: i.have.host("host", { address: "203.0.113.10", user: "deploy", sshKey: env("HOST_SSH_KEY") }),
    cf: i.have.cloudflare("cf", { apiToken: env("CLOUDFLARE_API_TOKEN") }),
});

test("env builds an env-sourced secret ref", () => {
    expect(env("TOKEN")).toEqual({ kind: "secret", source: "env", key: "TOKEN" });
});

test("httpOk omits timeout unless provided", () => {
    expect(httpOk("https://x/health")).toEqual({ kind: "readiness", check: "httpOk", url: "https://x/health" });
    expect(httpOk("https://x/health", { timeout: "30s" })).toEqual({ kind: "readiness", check: "httpOk", url: "https://x/health", timeout: "30s" });
});

test("want.app derives its support stack: the host carries the authored connection and the resolver supplies a default readyWhen", () => {
    const graph = defineStack((i) => {
        const { host, cf } = inventory(i);
        i.want.app("app", { on: host, expose: cf, environments: { prod: { domain: "app.example.com", branch: "main" } } });
    }, "example.com");

    // The forgejo node is derived from want.app, wired to the host, with a zone-derived domain + default health gate.
    expect(graph.resources["host-git"]?.inputs["server"]).toEqual({ $ref: "host" });
    expect(graph.resources["host"]?.inputs["sshKey"]).toEqual({ $secret: { source: "env", key: "HOST_SSH_KEY" } });
    expect(graph.resources["host"]?.inputs["address"]).toBe("203.0.113.10");
    expect(graph.resources["host-git"]?.dependsOn).toEqual(["host"]);
    expect(graph.resources["host-git"]?.readyWhen).toEqual({ check: "httpOk", url: { $ref: "host-git.internalUrl" }, timeout: "120s" });
});

test("duplicate resource id throws", () => {
    expect(() =>
        defineStack((i) => {
            const { host, cf } = inventory(i);
            i.want.app("dup", { on: host, expose: cf, environments: { prod: { domain: "a.example.com", branch: "main" } } });
            i.want.app("dup", { on: host, expose: cf, environments: { prod: { domain: "b.example.com", branch: "main" } } });
        }, "example.com"),
    ).toThrow('duplicate resource id: "dup"');
});

test("a dependency cycle throws", () => {
    // Auto-derived ids cannot form an authored cycle, so exercise the compile-layer guard directly.
    const nodes = new Map<string, RawNode>([
        ["a", { id: "a", type: "host", inputs: { peer: { kind: "ref", resourceId: "b" } }, explicitDependsOn: [] }],
        ["b", { id: "b", type: "host", inputs: { peer: { kind: "ref", resourceId: "a" } }, explicitDependsOn: [] }],
    ]);
    expect(() => compile(nodes)).toThrow(/dependency cycle/);
});

test("linearize derives a topological order (dependency before dependent)", () => {
    const graph = defineStack((i) => {
        const { host, cf } = inventory(i);
        i.want.app("app", { on: host, expose: cf, environments: { prod: { domain: "app.example.com", branch: "main" } } });
    }, "example.com");

    const order = linearize(graph);
    expect(order[0]).toBe("host");
    expect([...order].toSorted()).toEqual(Object.keys(graph.resources).toSorted());
});

test("want.service derives a signoz node + route, and want.app's observe wires the app's deployment to its OTLP endpoint", () => {
    const graph = defineStack((i) => {
        const { host, cf } = inventory(i);
        const obs = i.want.service("obs", { kind: "signoz", on: host, expose: cf, domain: "signoz.example.com" });
        i.want.app("app", { on: host, expose: cf, observe: obs, environments: { prod: { domain: "app.example.com", branch: "main" } } });
    }, "example.com");

    // The service is deployed onto the host and routed, but not built through the app platform.
    expect(graph.resources["obs"]?.type).toBe("signoz");
    expect(graph.resources["obs"]?.inputs["server"]).toEqual({ $ref: "host" });
    expect(graph.resources["cf-signoz-example-com"]?.type).toBe("cf-route");
    // observe injects the service's OTLP endpoint and a dependency on it.
    expect(graph.resources["app.prod"]?.inputs["env"]).toEqual({
        OTEL_EXPORTER_OTLP_ENDPOINT: { $ref: "obs.otlpEndpoint" },
        OTEL_EXPORTER_OTLP_PROTOCOL: "http/protobuf",
    });
    expect(graph.resources["app.prod"]?.dependsOn).toContain("obs");
});

test("want.workspace derives the sandbox node + its wildcard *.<zone> route", () => {
    const graph = defineStack((i) => {
        const { host, cf } = inventory(i);
        i.want.workspace("workspace", { on: host, expose: cf });
    }, "example.com");

    expect(graph.resources["workspace"]?.type).toBe("workspace");
    expect(graph.resources["workspace"]?.inputs["domain"]).toBe("*.example.com");
    expect(graph.resources["workspace"]?.inputs["server"]).toEqual({ $ref: "host" });
    // The wildcard hostname becomes the cf-route (id slugged) routing through the host tunnel.
    expect(graph.resources["cf-example-com"]?.type).toBe("cf-route");
    expect(graph.resources["cf-example-com"]?.inputs["hostname"]).toBe("*.example.com");
});

test("the derived platform trio slices to a cloudflare-free subgraph", () => {
    const graph = defineStack((i) => {
        const { host, cf } = inventory(i);
        i.want.app("app", { on: host, expose: cf, environments: { prod: { domain: "app.example.com", branch: "main" } } });
    }, "example.com");

    // The hermetic e2e applies exactly this slice with no Cloudflare credentials. It only holds while the
    // trio's inputs reference nothing but the host (zone lands as string literals): a cloudflare/cf-route/
    // tunnel ref added to any of them must fail here, in the unit tier, not minutes into the e2e.
    const sliced = subgraph(graph, ["host-git", "host-git-runner", "host-deploy"]);
    expect(Object.keys(sliced.resources).toSorted()).toEqual(["host", "host-deploy", "host-git", "host-git-runner"]);
});

test("apps share one derived platform", () => {
    const graph = defineStack((i) => {
        const { host, cf } = inventory(i);
        i.want.app("app-one", { on: host, expose: cf, environments: { prod: { domain: "one.example.com", branch: "main" } } });
        i.want.app("app-two", { on: host, expose: cf, environments: { prod: { domain: "two.example.com", branch: "main" } } });
    }, "example.com");

    // One shared Forgejo + Komodo for the host, not one per app.
    const types = Object.values(graph.resources).map((node) => node.type);
    expect(types.filter((type) => type === "forgejo")).toHaveLength(1);
    expect(types.filter((type) => type === "komodo")).toHaveLength(1);
    // Both apps' deployments target the same orchestrator (registered over the CP host's SSH).
    expect(graph.resources["app-one.prod"]?.dependsOn).toContain("host-deploy");
    expect(graph.resources["app-two.prod"]?.dependsOn).toContain("host-deploy");
    expect(graph.resources["app-one.prod"]?.inputs["address"]).toBe("203.0.113.10");
});
