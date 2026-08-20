import type { DesiredStateGraph } from "@intentic/graph";
import { hashInputs, linearize, refKey } from "@intentic/graph";
import type { ResourceType } from "@intentic/resources";
import { httpProbe, waitReady } from "../readiness.js";
import { resolveInputs } from "../resolve-inputs.js";
import { createStore } from "../store.js";
import type { Action, ApplyOutcome, EngineConfig, Step } from "../types.js";
import { validateOutputs } from "./outputs-check.js";
import { decideDiff, makeContext, narratedRead, requireProvider } from "./reconcile.js";

// Converge: walk the graph in dependency order, reconcile each node (create/update/noop), record its
// outputs for downstream refs, then gate on readiness. Strictly sequential, a dependent must observe
// its dependencies' outputs in the store, which holds because linearize() places deps first.
export const apply = async (graph: DesiredStateGraph, config: EngineConfig): Promise<ApplyOutcome> => {
    const env = config.env ?? process.env;
    const log = config.log ?? console.log;
    const emit = config.onEvent ?? (() => {});
    const probe = config.probe ?? httpProbe;
    const store = createStore();
    const steps: Step[] = [];
    const outputs: Record<string, Readonly<Record<string, unknown>>> = {};

    for (const id of linearize(graph)) {
        const node = graph.resources[id];
        if (node === undefined) {
            continue;
        }
        const type = node.type as ResourceType;
        emit({ kind: "node", phase: "apply", state: "start", id, type });
        const provider = requireProvider(config.providers, type, id);
        const ctx = makeContext(id, store, env, log, hashInputs(node.inputs));
        const inputs = resolveInputs(node.inputs, store, env, { lenient: false });
        const observed = await narratedRead(provider, inputs, ctx, id, log);

        let action: Action;
        let reason: string | undefined;
        let produced: Record<string, unknown>;
        if (observed === undefined) {
            action = "create";
            produced = await provider.apply(inputs, undefined, ctx);
        } else {
            const result = decideDiff(provider, node, inputs, observed);
            if (result.action === "update") {
                action = "update";
                reason = result.reason;
                produced = await provider.apply(inputs, observed, ctx);
            } else {
                action = "noop";
                produced = { ...observed.outputs };
            }
        }

        validateOutputs(type, produced, id);
        store.set(id, id);
        for (const [name, value] of Object.entries(produced)) {
            store.set(refKey(id, name), value);
        }
        outputs[id] = produced;
        steps.push(reason !== undefined ? { id, type, action, reason } : { id, type, action });
        emit({ kind: "node", phase: "apply", state: "done", id, type, action, ...(reason !== undefined ? { reason } : {}) });

        // Gate on readiness only for resources this apply actually touched. A noop resource was converged
        // (and ready) in a prior apply; re-waiting on its live health would be runtime supervision, which
        // the provisioner deliberately leaves to the running services and their deploy loop.
        if (action !== "noop" && node.readyWhen !== undefined) {
            const url =
                typeof node.readyWhen.url === "string" ? node.readyWhen.url : (store.get(node.readyWhen.url.$ref, { lenient: false }) as string);
            const options = {
                ...(node.readyWhen.status !== undefined ? { status: node.readyWhen.status } : {}),
                ...(node.readyWhen.timeout !== undefined ? { timeout: node.readyWhen.timeout } : {}),
            };
            emit({ kind: "readiness", state: "waiting", id, url });
            await waitReady(id, url, options, probe);
            emit({ kind: "readiness", state: "ready", id, url });
        }
    }

    return { steps, outputs };
};
