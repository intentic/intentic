import { topoSort } from "./topo.js";
import type { DesiredStateGraph, RawNode, Readiness, Ref, SecretRef } from "./types.js";

export const env = (key: string): SecretRef => Object.freeze({ kind: "secret", source: "env", key });

// A secret intentic generates and persists itself (vs env(), which the user supplies). The key names the
// slot it is stored under; the resolver uses this for the Forgejo/Komodo admin credentials.
export const generated = (key: string): SecretRef => Object.freeze({ kind: "secret", source: "generated", key });

export const httpOk = (url: string | Ref<string>, options?: { timeout?: string; status?: number }): Readiness =>
    Object.freeze({
        kind: "readiness",
        check: "httpOk",
        url,
        ...(options?.timeout !== undefined ? { timeout: options.timeout } : {}),
        ...(options?.status !== undefined ? { status: options.status } : {}),
    });

export const linearize = (graph: DesiredStateGraph): string[] => {
    const ids = Object.keys(graph.resources);
    const dependsOn = new Map<string, readonly string[]>();
    for (const id of ids) {
        dependsOn.set(id, graph.resources[id]?.dependsOn ?? []);
    }
    return topoSort(ids, dependsOn);
};

// The dependency closure of `targets`: each target plus everything it transitively dependsOn, the graph
// slice a targeted plan/apply runs against. Node order (and so linearization) is preserved. Throws on an
// id the graph does not declare.
export const subgraph = (graph: DesiredStateGraph, targets: readonly string[]): DesiredStateGraph => {
    const keep = new Set<string>();
    const visit = (id: string): void => {
        if (keep.has(id)) {
            return;
        }
        const node = graph.resources[id];
        if (node === undefined) {
            throw new Error(`target "${id}" is not in the graph`);
        }
        keep.add(id);
        for (const dep of node.dependsOn) {
            visit(dep);
        }
    };
    for (const id of targets) {
        visit(id);
    }
    return { version: graph.version, resources: Object.fromEntries(Object.entries(graph.resources).filter(([id]) => keep.has(id))) };
};

// Fold a resolver's RawNode list into the id-keyed map compile() consumes, rejecting duplicate ids.
export const toNodeMap = (nodes: readonly RawNode[]): Map<string, RawNode> => {
    const map = new Map<string, RawNode>();
    for (const node of nodes) {
        if (map.has(node.id)) {
            throw new Error(`duplicate resource id: "${node.id}"`);
        }
        map.set(node.id, node);
    }
    return map;
};

export { compile } from "./compile.js";
export { isRef, makeRef, refKey } from "./ref.js";
export { collectSecretUsage, type SecretUsage, secretRef } from "./secrets.js";
export { formatStamp, HASH_KEY, hashInputs, parseStamp, STAMP_KEY } from "./stamp.js";

export type {
    DesiredStateGraph,
    Input,
    Move,
    RawNode,
    Readiness,
    Ref,
    ResourceNode,
    SecretRef,
    SecretSource,
    SerializedReadiness,
    SerializedValue,
} from "./types.js";
