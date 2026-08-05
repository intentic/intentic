import type { DesiredStateGraph, SecretSource, SerializedValue } from "./types.js";

// Read the source + env-var key behind a serialized secret input ({ $secret: { source, key } }), or undefined
// if `value` is not a secret node. Enumeration/display only — never reads the secret VALUE (that is the
// engine's resolve-inputs path).
export const secretRef = (value: SerializedValue | undefined): { readonly source: SecretSource; readonly key: string } | undefined => {
    if (typeof value !== "object" || value === null || Array.isArray(value)) {
        return undefined;
    }
    const secret = (value as { $secret?: { source?: unknown; key?: unknown } }).$secret;
    if (typeof secret !== "object" || secret === null) {
        return undefined;
    }
    const { source, key } = secret;
    if (typeof key !== "string" || (source !== "env" && source !== "generated")) {
        return undefined;
    }
    return { source, key };
};

export interface SecretUsage {
    readonly key: string;
    readonly source: SecretSource;
    readonly requiredBy: readonly { readonly id: string; readonly type: string }[];
}

// Every secret the graph requires, with the resource nodes that reference it. Secrets nest (an app
// environment's `env` map, the platform nodes the resolver injects), so walk inputs recursively; the graph is
// the only complete source (a hand-written list drifts). Sorted by key, each `requiredBy` de-duplicated and
// sorted by node id. A key declared under BOTH sources is a resolver bug — surface it here rather than
// half-generate it at apply time.
export const collectSecretUsage = (graph: DesiredStateGraph): SecretUsage[] => {
    const usages = new Map<string, { source: SecretSource; requiredBy: Map<string, string> }>();
    const walk = (value: SerializedValue, node: { id: string; type: string }): void => {
        if (Array.isArray(value)) {
            for (const item of value) {
                walk(item, node);
            }
            return;
        }
        const ref = secretRef(value);
        if (ref !== undefined) {
            const usage = usages.get(ref.key);
            if (usage === undefined) {
                usages.set(ref.key, { source: ref.source, requiredBy: new Map([[node.id, node.type]]) });
                return;
            }
            if (usage.source !== ref.source) {
                throw new Error(`secret "${ref.key}" is declared as both ${usage.source} and ${ref.source}`);
            }
            usage.requiredBy.set(node.id, node.type);
            return;
        }
        if (typeof value === "object" && value !== null) {
            for (const nested of Object.values(value)) {
                walk(nested, node);
            }
        }
    };
    for (const node of Object.values(graph.resources)) {
        for (const input of Object.values(node.inputs)) {
            walk(input, node);
        }
    }
    return [...usages]
        .toSorted(([a], [b]) => a.localeCompare(b))
        .map(([key, { source, requiredBy }]) => ({
            key,
            source,
            requiredBy: [...requiredBy].toSorted(([a], [b]) => a.localeCompare(b)).map(([id, type]) => ({ id, type })),
        }));
};
