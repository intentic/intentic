import { refKey } from "./ref.js";
import { collectRefs, serializeValue } from "./serialize.js";
import { topoSort } from "./topo.js";
import type { DesiredStateGraph, RawNode, Readiness, ResourceNode, SerializedReadiness, SerializedValue } from "./types.js";

const serializeReadiness = (readiness: Readiness): SerializedReadiness => {
    const url = typeof readiness.url === "string" ? readiness.url : { $ref: refKey(readiness.url.resourceId, readiness.url.output) };
    return {
        check: readiness.check,
        url,
        ...(readiness.timeout !== undefined ? { timeout: readiness.timeout } : {}),
        ...(readiness.status !== undefined ? { status: readiness.status } : {}),
    };
};

export const compile = (nodes: ReadonlyMap<string, RawNode>): DesiredStateGraph => {
    const ids = [...nodes.keys()];
    const known = new Set(ids);
    const resources: Record<string, ResourceNode> = {};
    const dependsOnMap = new Map<string, readonly string[]>();

    for (const node of nodes.values()) {
        const inputs: Record<string, SerializedValue> = {};
        for (const [key, value] of Object.entries(node.inputs)) {
            inputs[key] = serializeValue(value);
        }

        const referenced = [
            ...node.explicitDependsOn,
            ...Object.values(node.inputs).flatMap(collectRefs),
            ...(node.readyWhen !== undefined ? collectRefs(node.readyWhen.url) : []),
        ];
        const dependsOn: string[] = [];
        for (const dep of referenced) {
            if (dep === node.id) {
                continue;
            }
            if (!known.has(dep)) {
                throw new Error(`resource "${node.id}" references unknown resource "${dep}"`);
            }
            if (!dependsOn.includes(dep)) {
                dependsOn.push(dep);
            }
        }

        const resourceNode: ResourceNode = {
            id: node.id,
            type: node.type,
            inputs,
            dependsOn,
            ...(node.readyWhen !== undefined ? { readyWhen: serializeReadiness(node.readyWhen) } : {}),
        };
        resources[node.id] = Object.freeze(resourceNode);
        dependsOnMap.set(node.id, dependsOn);
    }

    // Validate acyclicity at authoring time; the execution order itself is derived on demand via linearize().
    topoSort(ids, dependsOnMap);
    const graph: DesiredStateGraph = { version: 1, resources };
    return Object.freeze(graph);
};
