import type { DesiredStateGraph } from "@intentic/graph";
import type { ApplyOutcome, EngineConfig } from "../types.js";
import { apply } from "./apply.js";
import { plan } from "./plan.js";

export interface ConvergeResult {
    readonly converged: boolean;
    readonly iterations: number;
    readonly outcome: ApplyOutcome;
}

// Execute a desired-state artifact until state-reading shows it is true. Each iteration applies
// the graph (which gates readiness on every node it touches) then plans it: convergence is when that plan
// reads all-noop — the framework's own definition of "converged & idempotent". apply is idempotent, so a
// graph that needed several passes (e.g. a service that only becomes diff-clean once a dependency is live)
// settles within a few iterations. Errors propagate, as everywhere else; the bound guards against a graph
// that never settles. (The LLM-driven fix-operations seam — catching a failed apply to repair it — is a
// later increment that wraps this loop.)
export const reconcile = async (graph: DesiredStateGraph, config: EngineConfig, options: { maxIterations: number }): Promise<ConvergeResult> => {
    if (options.maxIterations < 1) {
        throw new Error("reconcile requires maxIterations >= 1");
    }
    const emit = config.onEvent ?? (() => {});
    for (let iteration = 1; iteration <= options.maxIterations; iteration++) {
        const outcome = await apply(graph, config);
        const check = await plan(graph, config);
        const converged = check.steps.every((step) => step.action === "noop");
        emit({ kind: "iteration", n: iteration, converged });
        if (converged) {
            return { converged: true, iterations: iteration, outcome };
        }
    }
    throw new Error(`reconcile did not converge within ${options.maxIterations} iterations`);
};
