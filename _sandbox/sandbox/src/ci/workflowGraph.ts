import { parse } from "yaml";

/* THE DEPENDENCY GRAPH GITHUB'S API WILL NOT TELL YOU, read out of the workflow file instead.
 *
 * `GET /actions/runs/:id/jobs` returns what ran and when, and nothing about what gated what, no `stage`, no
 * `needs`. A view given only that can say "these overlapped in time" and no more, which is why the expanded
 * job graph used to draw a thirteen-job run as a flat line: every job looked like its own sequential step.
 * Actions' own graph does not have a better API; it reads `jobs.<id>.needs` out of the workflow definition,
 * and so does this.
 *
 * THE HARD PART IS NOT THE YAML, IT IS THE NAMES. `needs` refers to workflow job IDs; the jobs API reports
 * DISPLAY names, which the two features people actually use rewrite beyond recognition:
 *   - a matrix leg is `<name> (chromium, 20)`, one declared job, N reported ones
 *   - a reusable workflow call is `<caller> / <job inside the called file>`, again one declared job, N
 *     reported ones
 * Both are handled the same way, and it is the only honest one available: a reported name is matched to the
 * declared job whose ID or `name` it BEGINS with, at a separator those two features are the reason for. The
 * longest such label wins, so `verify` never steals a name that `verify-core` explains.
 *
 * A CALLED FILE THAT IS IN FRONT OF US IS READ. `uses: ./.github/workflows/release.yml` points inside this
 * repository, so the caller fetches those files alongside the run's own and hands them in; each one's jobs are
 * then flattened into the graph under the calling job's name. `release / plan` waits on whatever `release`
 * waited on, `release / publish` waits on `release / plan`, and a job that waited on `release` waits on
 * whatever FINISHES release, so seven jobs that used to be siblings on one card are drawn as the chain they
 * always were. A `uses:` into another repository is still a file we cannot see, and its jobs stay siblings
 * with the calling job's own dependencies: a coarser truth, not a false one.
 *
 * WHAT IS DELIBERATELY NOT GUESSED. A name nothing matches resolves to no edges at all rather than to a
 * plausible one, the caller then knows this job's place is unknown instead of being told a lie in the shape
 * of a graph. */

// The separator Actions puts between a calling job and a job inside the file it called, and so the one this
// module builds reported names and flattened keys with.
const CALL = " / ";

// One job exactly as its own file declares it. `needs` holds job IDs local to that file, which is what the
// file says and what has to be translated before anything outside this module can use it.
interface DeclaredJob {
    readonly id: string;
    readonly name: string | undefined;
    readonly needs: readonly string[];
    // A local reusable-workflow call, as a repository-relative path (`.github/workflows/release.yml`).
    // Undefined for a normal job and for a call we cannot follow: another repository, or an action.
    readonly calls: string | undefined;
}

/* One job after the call tree has been flattened: the same job, addressed by a key that is unique across every
 * file involved, with its dependencies in that same key space. */
interface FlatJob {
    // `plan` at the top level, `release / plan` one call down, `release / windows-verify / smoke` two.
    readonly key: string;
    // Every reported name this job could answer to. EMPTY for a call we followed: a run reports the called
    // file's jobs, never the call itself, so nothing may match it.
    readonly labels: readonly string[];
    readonly needs: readonly string[];
    /* For a call we followed, the keys that FINISH the called file. Waiting for a call means waiting for the
     * whole file, and every job in a file is an ancestor of one of its sinks, so the sinks are what a
     * dependency on the call resolves through. Empty for every other job. */
    readonly finishedBy: readonly string[];
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

// `./.github/workflows/release.yml` → `.github/workflows/release.yml`. Anything not starting with `./` is not
// a file in this repository: `owner/repo/file@ref` is another repository's, and a bare name is an action.
const localCall = (uses: unknown): string | undefined => (typeof uses === "string" && uses.startsWith("./") ? uses.slice(2) : undefined);

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
                calls: localCall(fields["uses"]),
            },
        ];
    });
};

// Every string a reported name could match a declared job by. The `name:` is what Actions shows when it is
// set, but the ID keeps matching whenever it is not, or cannot be, because it was written as an expression.
const labelsOf = (job: DeclaredJob): string[] => (job.name === undefined ? [job.id] : [job.name, job.id]);

/* WHICH LOCAL FILES A WORKFLOW CALLS, so the caller can fetch them and hand them back in. One level: the files
 * these in turn call come out of running this over each of them, which is what lets the walk stop as soon as a
 * round turns up nothing new. */
export const localWorkflowCalls = (workflowYaml: string): string[] => [
    ...new Set(declaredJobs(workflowYaml).flatMap((job) => (job.calls === undefined ? [] : [job.calls]))),
];

// A call being followed: the calling job's key and labels, which every job of the called file hangs under, and
// what the calling job waited on, which the called file's own roots inherit.
interface CallSite {
    readonly key: string;
    readonly labels: readonly string[];
    readonly needs: readonly string[];
}

interface FlatWorkflow {
    readonly jobs: readonly FlatJob[];
    // The keys nothing else in this file waits on, see FlatJob.finishedBy.
    readonly sinks: readonly string[];
}

// Every reported name a job could answer to, once the call it sits inside has prefixed them. At the top level
// that is just its own labels; one call down, each of the caller's labels carries each of this job's.
const labelsUnder = (job: DeclaredJob, site: CallSite | undefined): string[] =>
    site === undefined ? labelsOf(job) : site.labels.flatMap((prefix) => labelsOf(job).map((label) => `${prefix}${CALL}${label}`));

// A job's own `needs` are IDs in its own file. A job that declares none inherits the call's, which is what puts
// a called file's roots where the calling job sat.
const needsUnder = (job: DeclaredJob, site: CallSite | undefined, keyOf: (id: string) => string): readonly string[] =>
    job.needs.length > 0 ? job.needs.map(keyOf) : (site?.needs ?? []);

/* ONE WORKFLOW FILE, PLUS EVERY LOCAL FILE IT CALLS, AS ONE FLAT JOB LIST.
 *
 * `called` is path → source for the files the caller could fetch; a path missing from it is a call left
 * unfollowed, which is the same coarse graph this module drew before it could follow any. `following` carries
 * the paths already open so a file that calls itself (directly or round a ring) stops instead of recursing. */
const flatten = (
    workflowYaml: string,
    called: ReadonlyMap<string, string>,
    site: CallSite | undefined,
    following: ReadonlySet<string>,
): FlatWorkflow => {
    const declared = declaredJobs(workflowYaml);
    const keyOf = (id: string): string => (site === undefined ? id : `${site.key}${CALL}${id}`);
    const waitedOn = new Set(declared.flatMap((job) => job.needs));
    const jobs = declared.flatMap((job): FlatJob[] => {
        const here: CallSite = { key: keyOf(job.id), labels: labelsUnder(job, site), needs: needsUnder(job, site, keyOf) };
        // A call we cannot follow (another repository, a file that failed to fetch) or must not (a ring of
        // calls) stays one job, and its reported names stay whatever the prefix rule can claim for it.
        const path = job.calls;
        const source = path === undefined || following.has(path) ? undefined : called.get(path);
        const inner = source === undefined || path === undefined ? undefined : flatten(source, called, here, new Set([...following, path]));
        if (inner === undefined || inner.jobs.length === 0) {
            return [{ ...here, finishedBy: [] }];
        }
        return [{ ...here, labels: [], finishedBy: inner.sinks }, ...inner.jobs];
    });
    return { jobs, sinks: declared.filter((job) => !waitedOn.has(job.id)).map((job) => keyOf(job.id)) };
};

/* Which flattened job a reported name came from. Exact first, the overwhelming majority of jobs are neither
 * matrixed nor reusable and report exactly their ID or `name`. Only then the prefix rule, and only at ` (` or
 * ` / `, the two separators GitHub itself introduces; a bare `startsWith` would let `verify` claim
 * `verify-core / verify`, which is how a graph ends up quietly wired to the wrong node. */
const matchFlat = (reported: string, jobs: readonly FlatJob[]): FlatJob | undefined => {
    for (const job of jobs) {
        if (job.labels.includes(reported)) {
            return job;
        }
    }
    let best: { job: FlatJob; length: number } | undefined;
    for (const job of jobs) {
        for (const label of job.labels) {
            const prefixed = reported.startsWith(`${label}${CALL}`) || reported.startsWith(`${label} (`);
            if (prefixed && (best === undefined || label.length > best.length)) {
                best = { job, length: label.length };
            }
        }
    }
    return best?.job;
};

/* A workflow file plus the names a run reported → what each reported job waited on, in reported names.
 *
 * `calledWorkflows` is every local file this run's workflow calls, by repository-relative path (see
 * localWorkflowCalls); empty means none could be fetched, and the graph is then as coarse as it always was.
 *
 * Only jobs that matched a declared one appear, and a matched job always appears, with an EMPTY array when
 * it declares nothing, which is the meaningful statement that it is a root and not that we failed to look.
 * `needs` pointing at a job that did not run (an `if:` that never fired, a leg of a matrix that was excluded)
 * drops out here rather than becoming an edge to a node the graph does not contain. */
export const resolveNeeds = (
    workflowYaml: string,
    reportedNames: readonly string[],
    calledWorkflows: ReadonlyMap<string, string> = new Map(),
): Map<string, string[]> => {
    const { jobs } = flatten(workflowYaml, calledWorkflows, undefined, new Set());
    if (jobs.length === 0) {
        return new Map();
    }
    // One job can own several reported ones, every matrix leg, every job of a called file we could not read,
    // and a dependency on it is a dependency on all of them.
    const reportedByKey = new Map<string, string[]>();
    const jobOfReported = new Map<string, FlatJob>();
    for (const reported of reportedNames) {
        const job = matchFlat(reported, jobs);
        if (job === undefined) {
            continue;
        }
        jobOfReported.set(reported, job);
        reportedByKey.set(job.key, [...(reportedByKey.get(job.key) ?? []), reported]);
    }

    const byKey = new Map(jobs.map((job): [string, FlatJob] => [job.key, job]));
    // A call we followed reports nothing itself, so waiting for it means waiting for the jobs that finish it,
    // and those can be another call: `release / windows-verify` finishes with a job inside windows-smoke.yml.
    const reportedFor = (key: string): string[] => {
        const job = byKey.get(key);
        if (job === undefined) {
            return [];
        }
        return job.finishedBy.length > 0 ? job.finishedBy.flatMap(reportedFor) : (reportedByKey.get(key) ?? []);
    };

    const resolved = new Map<string, string[]>();
    for (const [reported, job] of jobOfReported) {
        resolved.set(reported, [...new Set(job.needs.flatMap(reportedFor))]);
    }
    return resolved;
};
