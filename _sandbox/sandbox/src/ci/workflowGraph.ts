import { parse } from "yaml";

/* THE DEPENDENCY GRAPH GITHUB'S API WILL NOT TELL YOU, read out of the workflow file instead.
 *
 * `GET /actions/runs/:id/jobs` returns what ran and when, and nothing about what gated what — no `stage`, no
 * `needs`. A view given only that can say "these overlapped in time" and no more, which is why the expanded
 * job graph used to draw a thirteen-job run as a flat line: every job looked like its own sequential step.
 * Actions' own graph does not have a better API; it reads `jobs.<id>.needs` out of the workflow definition,
 * and so does this.
 *
 * THE HARD PART IS NOT THE YAML, IT IS THE NAMES. `needs` refers to workflow job IDs; the jobs API reports
 * DISPLAY names, which the two features people actually use rewrite beyond recognition:
 *   - a matrix leg is `<name> (chromium, 20)` — one declared job, N reported ones
 *   - a reusable workflow call is `<caller> / <job inside the called file>` — again one declared job, N
 *     reported ones, and the called file is not in front of us (it can live in another repository entirely)
 * Both are handled the same way, and it is the only honest one available: a reported name is matched to the
 * declared job whose ID or `name` it BEGINS with, at a separator those two features are the reason for. The
 * longest such label wins, so `verify` never steals a name that `verify-core` explains.
 *
 * WHAT IS DELIBERATELY NOT GUESSED. A name nothing matches resolves to no edges at all rather than to a
 * plausible one — the caller then knows this job's place is unknown instead of being told a lie in the shape
 * of a graph. Jobs inside a called workflow are siblings here, because their real order lives in a file we
 * cannot see; that is a coarser truth, not a false one. */

// One job as the workflow file declares it. `needs` holds workflow job IDs, which is what the file says and
// what has to be translated before anything outside this module can use it.
interface DeclaredJob {
    readonly id: string;
    readonly name: string | undefined;
    readonly needs: readonly string[];
}

const asStringArray = (value: unknown): string[] => {
    if (typeof value === "string") {
        return [value];
    }
    if (Array.isArray(value)) {
        return value.filter((item): item is string => typeof item === "string");
    }
    return [];
};

// The workflow's `jobs:` map, flattened. Anything that is not a mapping of mappings is not a workflow we can
// read, and comes back empty rather than half-understood.
const declaredJobs = (workflowYaml: string): DeclaredJob[] => {
    const parsed: unknown = parse(workflowYaml);
    if (typeof parsed !== "object" || parsed === null) {
        return [];
    }
    const jobs = (parsed as Record<string, unknown>)["jobs"];
    if (typeof jobs !== "object" || jobs === null) {
        return [];
    }
    return Object.entries(jobs as Record<string, unknown>).flatMap(([id, body]) => {
        if (typeof body !== "object" || body === null) {
            return [];
        }
        const fields = body as Record<string, unknown>;
        const name = fields["name"];
        return [
            {
                id,
                // A name built from an Actions expression resolves per leg at run time, so as written it can
                // never match a reported name. Dropping it leaves the ID, which still can.
                name: typeof name === "string" && !name.includes("${{") ? name : undefined,
                needs: asStringArray(fields["needs"]),
            },
        ];
    });
};

// Every string a reported name could match a declared job by. The `name:` is what Actions shows when it is
// set, but the ID keeps matching whenever it is not — or cannot be, because it was written as an expression.
const labelsOf = (job: DeclaredJob): string[] => (job.name === undefined ? [job.id] : [job.name, job.id]);

/* Which declared job a reported name came from. Exact first — the overwhelming majority of jobs are neither
 * matrixed nor reusable and report exactly their ID or `name`. Only then the prefix rule, and only at ` (` or
 * ` / `, the two separators GitHub itself introduces; a bare `startsWith` would let `verify` claim
 * `verify-core / verify`, which is how a graph ends up quietly wired to the wrong node. */
const matchDeclared = (reported: string, jobs: readonly DeclaredJob[]): DeclaredJob | undefined => {
    for (const job of jobs) {
        if (labelsOf(job).includes(reported)) {
            return job;
        }
    }
    let best: { job: DeclaredJob; length: number } | undefined;
    for (const job of jobs) {
        for (const label of labelsOf(job)) {
            const prefixed = reported.startsWith(`${label} / `) || reported.startsWith(`${label} (`);
            if (prefixed && (best === undefined || label.length > best.length)) {
                best = { job, length: label.length };
            }
        }
    }
    return best?.job;
};

/* A workflow file plus the names a run reported → what each reported job waited on, in reported names.
 *
 * Only jobs that matched a declared one appear, and a matched job always appears — with an EMPTY array when
 * it declares nothing, which is the load-bearing statement that it is a root and not that we failed to look.
 * `needs` pointing at a job that did not run (an `if:` that never fired, a leg of a matrix that was excluded)
 * drops out here rather than becoming an edge to a node the graph does not contain. */
export const resolveNeeds = (workflowYaml: string, reportedNames: readonly string[]): Map<string, string[]> => {
    const declared = declaredJobs(workflowYaml);
    if (declared.length === 0) {
        return new Map();
    }
    // One declared job can own several reported ones — every matrix leg, every job of a called workflow — and
    // a dependency on it is a dependency on all of them.
    const reportedByDeclared = new Map<string, string[]>();
    const declaredOfReported = new Map<string, DeclaredJob>();
    for (const reported of reportedNames) {
        const job = matchDeclared(reported, declared);
        if (job === undefined) {
            continue;
        }
        declaredOfReported.set(reported, job);
        reportedByDeclared.set(job.id, [...(reportedByDeclared.get(job.id) ?? []), reported]);
    }

    const resolved = new Map<string, string[]>();
    for (const [reported, job] of declaredOfReported) {
        resolved.set(
            reported,
            job.needs.flatMap((needed) => reportedByDeclared.get(needed) ?? []),
        );
    }
    return resolved;
};
