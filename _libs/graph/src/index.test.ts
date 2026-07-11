import { expect, test } from "vitest";

import { compile, env, httpOk, subgraph, toNodeMap } from "./index.js";
import type { RawNode } from "./types.js";

test("env builds an env-sourced secret ref", () => {
    expect(env("TOKEN")).toEqual({ kind: "secret", source: "env", key: "TOKEN" });
});

test("httpOk omits timeout unless provided", () => {
    expect(httpOk("https://x/health")).toEqual({ kind: "readiness", check: "httpOk", url: "https://x/health" });
    expect(httpOk("https://x/health", { timeout: "30s" })).toEqual({ kind: "readiness", check: "httpOk", url: "https://x/health", timeout: "30s" });
});

test("toNodeMap rejects duplicate ids", () => {
    const nodes: RawNode[] = [
        { id: "dup", type: "host", inputs: {}, explicitDependsOn: [] },
        { id: "dup", type: "host", inputs: {}, explicitDependsOn: [] },
    ];
    expect(() => toNodeMap(nodes)).toThrow('duplicate resource id: "dup"');
});

test("compile guards against dependency cycles", () => {
    const nodes = new Map<string, RawNode>([
        ["a", { id: "a", type: "host", inputs: { peer: { kind: "ref", resourceId: "b" } }, explicitDependsOn: [] }],
        ["b", { id: "b", type: "host", inputs: { peer: { kind: "ref", resourceId: "a" } }, explicitDependsOn: [] }],
    ]);
    expect(() => compile(nodes)).toThrow(/dependency cycle/);
});

test("compile rejects references to unknown resources", () => {
    const nodes = new Map<string, RawNode>([
        ["a", { id: "a", type: "host", inputs: { peer: { kind: "ref", resourceId: "ghost" } }, explicitDependsOn: [] }],
    ]);
    expect(() => compile(nodes)).toThrow('references unknown resource "ghost"');
});

test("subgraph keeps the targets plus their transitive dependencies, preserving order", () => {
    const graph = compile(
        toNodeMap([
            { id: "host", type: "host", inputs: {}, explicitDependsOn: [] },
            { id: "git", type: "forgejo", inputs: { on: { kind: "ref", resourceId: "host" } }, explicitDependsOn: [] },
            { id: "repo", type: "repo", inputs: { git: { kind: "ref", resourceId: "git" } }, explicitDependsOn: [] },
            { id: "other", type: "deployment", inputs: { on: { kind: "ref", resourceId: "host" } }, explicitDependsOn: [] },
        ]),
    );
    const sliced = subgraph(graph, ["repo"]);
    expect(Object.keys(sliced.resources)).toEqual(["host", "git", "repo"]);
});

test("subgraph rejects a target the graph does not declare", () => {
    const graph = compile(toNodeMap([{ id: "host", type: "host", inputs: {}, explicitDependsOn: [] }]));
    expect(() => subgraph(graph, ["ghost"])).toThrow('target "ghost" is not in the graph');
});
