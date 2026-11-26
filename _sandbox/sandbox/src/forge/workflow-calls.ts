import { parse } from "yaml";
import { z } from "zod";

// WHICH WORKFLOW FILES A GITHUB WORKFLOW CALLS, so the core's client can read them for a run (github.ts
// `workflowSource`, POST /ci/runs/workflow) with the connection's token. What the files say, the run's job graph, is the
// Pipelines board's backend's to draw (the pipelines extension's workflow-graph.ts, which reads calls the same way).
// (2026-11-26) Split from the daemon's workflowGraph.ts when the graph moved there.

// Where a called file lives: another repository's, at the ref the call pins.
export interface RemoteWorkflow {
    readonly repo: string;
    readonly path: string;
    readonly ref: string;
}

// `owner/repo/.github/workflows/file.yml@ref`, the form a call into another repository takes.
export const remoteWorkflow = (key: string): RemoteWorkflow | undefined => {
    const match = /^([^/@\s]+\/[^/@\s]+)\/([^@\s]+\.ya?ml)@([^@\s]+)$/.exec(key);
    const [, repo, path, ref] = match ?? [];
    return repo === undefined || path === undefined || ref === undefined ? undefined : { repo, path, ref };
};

// The key a called file is fetched by: a path for a file of the run's own repository (`./` and the newer `$/`, both at
// the run's own commit), the call itself for another repository's. A `./` call inside another repository's file means
// that repository, at the same ref. Undefined for anything that is not a workflow call.
const callKey = (uses: string, from: string | undefined): string | undefined => {
    if (uses.startsWith("./") || uses.startsWith("$/")) {
        const remote = from === undefined ? undefined : remoteWorkflow(from);
        return remote === undefined ? uses.slice(2) : `${remote.repo}/${uses.slice(2)}@${remote.ref}`;
    }
    return remoteWorkflow(uses) === undefined ? undefined : uses;
};

// The workflow files a workflow calls, one level deep, by the key each is fetched by. A matrix of calls is drawn as the
// caller's own matrix and is not followed. The caller fetches them and asks again of each, passing the key it fetched
// it by, until a round finds nothing new. An unreadable file calls nothing.
// A workflow file as far as its calls go: its jobs, each maybe calling another file (`uses`), maybe a matrix.
const WorkflowSchema = z.looseObject({ jobs: z.record(z.string(), z.unknown()) });
const JobSchema = z.looseObject({ uses: z.string().optional(), strategy: z.looseObject({ matrix: z.unknown() }).optional() });

export const workflowCalls = (workflowYaml: string, from?: string): string[] => {
    let parsed: unknown;
    try {
        parsed = parse(workflowYaml);
    } catch {
        // allow(silent-catch): a file that is not YAML calls nothing, and the graph is enrichment only
        return [];
    }
    const jobs = WorkflowSchema.safeParse(parsed).data?.jobs ?? {};
    const keys = Object.values(jobs).flatMap((body) => {
        const job = JobSchema.safeParse(body).data;
        const key = job?.uses === undefined || job.strategy?.matrix !== undefined ? undefined : callKey(job.uses, from);
        return key === undefined ? [] : [key];
    });
    return [...new Set(keys)];
};
