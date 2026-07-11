import type { DesiredStateGraph } from "@intentic/graph";
import type { ResourceType } from "@intentic/resources";
import type { ScanSource } from "../provider.js";
import { resolveInputs } from "../resolve-inputs.js";
import { createStore } from "../store.js";
import type { EngineConfig, OrphanEntry } from "../types.js";
import { makeContext } from "./reconcile.js";

// Enumerate live stamped resources (via each provider's `list`) whose id is absent from the desired graph.
// Providers without `list` are skipped. Runs once per command, not per reconcile iteration — a scan opens
// real connections. Scan sources are the graph's nodes with leniently-resolved inputs over an EMPTY store:
// refs resolve to PENDING, which is fine because `list` implementations only parse the ref-free inventory
// sources (host, cloudflare). Each entry carries the inputs its provider's `delete` needs — they hold
// connection secrets, so entries are for engine/CLI plumbing, never serialization.
export const collectOrphans = async (graph: DesiredStateGraph, config: EngineConfig): Promise<OrphanEntry[]> => {
    const env = config.env ?? process.env;
    const log = config.log ?? console.log;
    const emit = config.onEvent ?? (() => {});
    const store = createStore();
    const sources: ScanSource[] = Object.values(graph.resources).map((node) => ({
        id: node.id,
        type: node.type as ResourceType,
        inputs: resolveInputs(node.inputs, store, env, { lenient: true }),
    }));
    const ctx = makeContext("", store, env, log);
    const known = new Set(Object.keys(graph.resources));
    const orphans: OrphanEntry[] = [];
    for (const [type, provider] of Object.entries(config.providers)) {
        if (provider?.list === undefined) {
            continue;
        }
        // The scan is the longest silent stretch of a plan (one live connection per list-bearing provider) —
        // narrate it so a consumer can show which provider is being scanned instead of a blank spinner.
        log(`orphan scan: ${type}`);
        for (const listed of await provider.list(sources, ctx)) {
            if (!known.has(listed.id)) {
                emit({ kind: "orphan", id: listed.id, type: type as ResourceType });
                orphans.push({
                    id: listed.id,
                    type: type as ResourceType,
                    inputs: listed.inputs,
                    ...(listed.protected === true ? { protected: true } : {}),
                });
            }
        }
    }
    return orphans;
};
