import { parse } from "yaml";

// Builds the job dependency graph the CI API doesn't expose, by reading `needs` from the workflow file and matching it
// to the API's display names by longest-prefix (matrix legs, reusable-workflow calls). Local `uses:` files are
// flattened in; a call elsewhere stays coarse, and an unmatched name gets no edges.

// Separator between a calling job and a job in the file it called; reused here for flattened keys.
const CALL = " / ";

// One job as its own file declares it; `needs` holds job IDs local to that file, translated before use outside this
// module.
interface DeclaredJob {
    readonly id: string;
    readonly name: string | undefined;
    readonly needs: readonly string[];
    // Local reusable-workflow call, as a repo-relative path; undefined for a normal job or an unfollowable call.
    readonly calls: string | undefined;
}

// One job after the call tree is flattened: addressed by a key unique across every file involved, with dependencies in
// that same key space.
interface FlatJob {
    // `plan` at the top level, `release / plan` one call down, `release / windows-verify / smoke` two.
    readonly key: string;
    // Every reported name this job answers to; empty for a followed call, since the run reports only callee jobs.
    readonly labels: readonly string[];
    readonly needs: readonly string[];
    // For a followed call, the keys that finish it; a dependency resolves through them. Empty otherwise.
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

// `./.github/workflows/release.yml` -> `.github/workflows/release.yml`; anything not starting with `./` is another
// repo's file or an action.
const localCall = (uses: unknown): string | undefined => (typeof uses === "string" && uses.startsWith("./") ? uses.slice(2) : undefined);

// The workflow's `jobs:` map, flattened; anything not a mapping of mappings is unreadable and returns empty.
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
                // An Actions expression resolves per leg at run time; it never matches, so drop it and keep the job ID.
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

// Local files a workflow calls, one level deep; the caller fetches and hands them back so this applies to each, until a
// round finds nothing new.
export const localWorkflowCalls = (workflowYaml: string): string[] => [
    ...new Set(declaredJobs(workflowYaml).flatMap((job) => (job.calls === undefined ? [] : [job.calls]))),
];

// A call being followed: the calling job's key and labels (what the called file's jobs hang under) and what it waited
// on (what the called file's roots inherit).
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

// Every reported name a job could answer to once its call site prefixes them; at the top level its own labels, one call
// down, each caller label crossed with its own.
const labelsUnder = (job: DeclaredJob, site: CallSite | undefined): string[] =>
    site === undefined ? labelsOf(job) : site.labels.flatMap((prefix) => labelsOf(job).map((label) => `${prefix}${CALL}${label}`));

// A job's own needs are IDs in its own file; a job with none inherits the call site's, putting a called file's roots
// where the calling job sat.
const needsUnder = (job: DeclaredJob, site: CallSite | undefined, keyOf: (id: string) => string): readonly string[] =>
    job.needs.length > 0 ? job.needs.map(keyOf) : (site?.needs ?? []);

// One workflow file plus every local file it calls, flattened. A path missing from `called` is left unfollowed;
// `following` stops a file that calls itself, directly or in a ring.
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
        // An unfollowable call (another repo, failed fetch) or a ring stays one job, matched only by its own labels.
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

// Exact label match first; only then the longest prefix at ` (` or ` / `, the two separators GitHub introduces, so
// `verify` cannot claim `verify-core / verify`.
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

// Reported names -> what each waited on, in reported names. A match with no needs is an empty array (a root); needs
// pointing at a job that never ran drops rather than dangling.
export const resolveNeeds = (
    workflowYaml: string,
    reportedNames: readonly string[],
    calledWorkflows: ReadonlyMap<string, string> = new Map(),
): Map<string, string[]> => {
    const { jobs } = flatten(workflowYaml, calledWorkflows, undefined, new Set());
    if (jobs.length === 0) {
        return new Map();
    }
    // One job can own several reported names (matrix legs, unread call jobs); depending on it depends on all.
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
    // A followed call reports nothing itself; waiting on it waits on whatever finishes it, maybe another call.
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
