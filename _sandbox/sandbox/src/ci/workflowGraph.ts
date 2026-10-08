import type { PipelineStatus } from "@intentic/sandbox-contract";
import { parse } from "yaml";

// Builds the job graph the CI API doesn't expose, by reading `needs` from the workflow file and matching it to the API's
// display names by longest-prefix (matrix legs, reusable-workflow calls). Called workflow files, this repository's or
// another's, are flattened in when the caller could fetch them; one it could not stays coarse, and an unmatched name
// gets no edges. Like GitHub's own run graph, every declared job is drawn,
// whether or not the run reported it: a skipped call is reported as one job under the caller's name, and a job still
// waiting on its needs is not reported at all until it is created.

// Separator between a calling job and a job in the file it called; reused here for flattened keys.
const CALL = " / ";

// One job as its own file declares it; `needs` holds job IDs local to that file, translated before use outside this
// module.
interface DeclaredJob {
    readonly id: string;
    readonly name: string | undefined;
    // A `name:` written with Actions expressions, as a pattern of what it evaluates to (`Build: ${{ matrix.os }}` is
    // `Build: .*?`), regex source; undefined for a plain name. GitHub reports such a job by the evaluated name, and a
    // matrix it skipped before expanding by the expression itself, which the pattern matches too.
    readonly pattern: string | undefined;
    // A `name:` that is nothing but expressions: on its own any reported name could be it, so none is taken for it.
    // Under a call, the caller's name in front still pins it.
    readonly opaque: boolean;
    readonly needs: readonly string[];
    // Reusable-workflow call, as the key its file is fetched by (see callKey); undefined for a normal job.
    readonly calls: string | undefined;
    // Declares `strategy.matrix`: reported as one job per leg, drawn by GitHub as one card of its own.
    readonly matrix: boolean;
}

// One job after the call tree is flattened: addressed by a key unique across every file involved, with dependencies in
// that same key space.
interface FlatJob {
    // `plan` at the top level, `release / plan` one call down, `release / windows-verify / smoke` two.
    readonly key: string;
    // Every reported name this job answers to, display name first. For a followed call, the names the run reports the
    // call itself by when it never expanded into its jobs (skipped, or not started).
    readonly labels: readonly string[];
    // Regex sources for the names it answers to when it or a call above it is named by an expression.
    readonly patterns: readonly string[];
    readonly needs: readonly string[];
    // For a followed call, the keys that finish it; a dependency resolves through them. Empty otherwise.
    readonly finishedBy: readonly string[];
    readonly followed: boolean;
    readonly matrix: boolean;
    // False when nothing pins the name the run would report it by (an expression and no literal text around it, here or
    // in a calling job): a job the run has not reported could still be one it did under a name not matched.
    readonly predictable: boolean;
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

// The key a called file is fetched by: a path for a file of the run's own repository (`./` and the newer `$/`, both
// at the run's own commit), the call itself for another repository's. A `./` call inside another repository's file
// means that repository, at the same ref. Undefined for anything that is not a workflow call.
const callKey = (uses: unknown, from: string | undefined): string | undefined => {
    if (typeof uses !== "string") {
        return undefined;
    }
    if (uses.startsWith("./") || uses.startsWith("$/")) {
        const remote = from === undefined ? undefined : remoteWorkflow(from);
        return remote === undefined ? uses.slice(2) : `${remote.repo}/${uses.slice(2)}@${remote.ref}`;
    }
    return remoteWorkflow(uses) === undefined ? undefined : uses;
};

const isMapping = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null && !Array.isArray(value);

const escapeRegExp = (text: string): string => text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

// Each `${{ … }}` stands for whatever it evaluates to; the text between stays literal.
const templatePattern = (name: string): { readonly source: string; readonly literal: boolean } => {
    const literal = name.split(/\$\{\{[\s\S]*?\}\}/);
    return { source: literal.map(escapeRegExp).join(".*?"), literal: literal.join("").trim() !== "" };
};

// The workflow's `jobs:` map, flattened; anything not a mapping of mappings is unreadable and returns empty. `from` is
// the key the file itself was fetched by, undefined for the run's own workflow.
const declaredJobs = (workflowYaml: string, from: string | undefined): DeclaredJob[] => {
    const parsed: unknown = parse(workflowYaml);
    if (!isMapping(parsed)) {
        return [];
    }
    const jobs = parsed["jobs"];
    if (!isMapping(jobs)) {
        return [];
    }
    return Object.entries(jobs).flatMap(([id, body]) => {
        if (!isMapping(body)) {
            return [];
        }
        const name = body["name"];
        const dynamicName = typeof name === "string" && name.includes("${{");
        const template = dynamicName ? templatePattern(name) : undefined;
        const strategy = body["strategy"];
        const matrix = isMapping(strategy) && strategy["matrix"] !== undefined;
        return [
            {
                id,
                // An Actions expression resolves per leg at run time: it is matched by its pattern, and the job ID stands
                // in for it wherever a name has to be shown before the run reports one.
                name: typeof name === "string" && !dynamicName ? name : undefined,
                pattern: template?.source,
                opaque: template?.literal === false,
                needs: asStringArray(body["needs"]),
                // A matrix of calls is reported leg by leg under the caller, `test (a) / build`, and GitHub draws it as
                // the caller's matrix: it stays one job rather than being followed.
                calls: matrix ? undefined : callKey(body["uses"], from),
                matrix,
            },
        ];
    });
};

// Every string a reported name could match a declared job by. The `name:` is what Actions shows when it is
// set, but the ID keeps matching whenever it is not, or cannot be, because it was written as an expression.
const labelsOf = (job: DeclaredJob): string[] => (job.name === undefined ? [job.id] : [job.name, job.id]);

// The workflow files a workflow calls, one level deep, by the key each is fetched by: a path in the run's repository,
// or another repository's call as written (remoteWorkflow reads it). The caller fetches them and hands them back, and
// asks again of each, passing the key it fetched it by, until a round finds nothing new.
export const workflowCalls = (workflowYaml: string, from?: string): string[] => [
    ...new Set(declaredJobs(workflowYaml, from).flatMap((job) => (job.calls === undefined ? [] : [job.calls]))),
];

// A call being followed: the calling job's key, labels and patterns (what the called file's jobs hang under), what it
// waited on (what the called file's roots inherit), and whether its name is pinned.
interface CallSite {
    readonly key: string;
    readonly labels: readonly string[];
    readonly patterns: readonly string[];
    readonly needs: readonly string[];
    readonly predictable: boolean;
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

// The patterns a job's reported name could match once its call site prefixes it: only those with an expression in
// them somewhere, since a name with none is already among its labels.
const patternsUnder = (job: DeclaredJob, site: CallSite | undefined): string[] => {
    const own = job.pattern === undefined ? [] : [job.pattern];
    if (site === undefined) {
        return job.opaque ? [] : own;
    }
    const sources = [...labelsOf(job).map(escapeRegExp), ...own];
    const separator = escapeRegExp(CALL);
    return [
        ...site.patterns.flatMap((prefix) => sources.map((source) => `${prefix}${separator}${source}`)),
        ...site.labels.flatMap((prefix) => own.map((source) => `${escapeRegExp(prefix)}${separator}${source}`)),
    ];
};

// A job's own needs are IDs in its own file; a job with none inherits the call site's, putting a called file's roots
// where the calling job sat.
const needsUnder = (job: DeclaredJob, site: CallSite | undefined, keyOf: (id: string) => string): readonly string[] =>
    job.needs.length > 0 ? job.needs.map(keyOf) : (site?.needs ?? []);

// One workflow file plus every file it calls, flattened. A key missing from `called` is left unfollowed; `following`
// stops a file that calls itself, directly or in a ring, and names the file being read last.
const flatten = (
    workflowYaml: string,
    called: ReadonlyMap<string, string>,
    site: CallSite | undefined,
    following: readonly string[],
): FlatWorkflow => {
    const declared = declaredJobs(workflowYaml, following.at(-1));
    const keyOf = (id: string): string => (site === undefined ? id : `${site.key}${CALL}${id}`);
    const waitedOn = new Set(declared.flatMap((job) => job.needs));
    const jobs = declared.flatMap((job): FlatJob[] => {
        const here: CallSite = {
            key: keyOf(job.id),
            labels: labelsUnder(job, site),
            patterns: patternsUnder(job, site),
            needs: needsUnder(job, site, keyOf),
            predictable: site === undefined ? !job.opaque : site.predictable,
        };
        const flat = { ...here, matrix: job.matrix };
        // An unfollowable call (a file not fetched) or a ring stays one job, matched only by its own labels.
        const path = job.calls;
        const source = path === undefined || following.includes(path) ? undefined : called.get(path);
        const inner = source === undefined || path === undefined ? undefined : flatten(source, called, here, [...following, path]);
        if (inner === undefined || inner.jobs.length === 0) {
            return [{ ...flat, finishedBy: [], followed: false }];
        }
        return [{ ...flat, finishedBy: inner.sinks, followed: true }, ...inner.jobs];
    });
    return { jobs, sinks: declared.filter((job) => !waitedOn.has(job.id)).map((job) => keyOf(job.id)) };
};

// A name written as an expression: the most literal pattern wins. A leg or a called job may follow it, as after a
// plain label; a followed call is matched whole only, being reported so only when it never expanded.
const patternMatch = (reported: string, jobs: readonly FlatJob[]): FlatJob | undefined => {
    let best: { job: FlatJob; length: number } | undefined;
    for (const job of jobs) {
        for (const pattern of job.patterns) {
            const whole = new RegExp(job.followed ? `^(?:${pattern})$` : `^(?:${pattern})(?: \\(.*\\)| / .*)?$`);
            if (whole.test(reported) && (best === undefined || pattern.length > best.length)) {
                best = { job, length: pattern.length };
            }
        }
    }
    return best?.job;
};

// Exact label match first (a followed call's own labels only ever match the one job a call is reported as when it
// never expanded); only then the longest prefix at ` (` or ` / `, the two separators GitHub introduces, so `verify`
// cannot claim `verify-core / verify`. A followed call is never a prefix match: its jobs carry their full names.
// Expression names come last, by pattern.
const matchFlat = (reported: string, jobs: readonly FlatJob[]): FlatJob | undefined => {
    for (const job of jobs) {
        if (job.labels.includes(reported)) {
            return job;
        }
    }
    let best: { job: FlatJob; length: number } | undefined;
    for (const job of jobs) {
        if (job.followed) {
            continue;
        }
        for (const label of job.labels) {
            const prefixed = reported.startsWith(`${label}${CALL}`) || reported.startsWith(`${label} (`);
            if (prefixed && (best === undefined || label.length > best.length)) {
                best = { job, length: label.length };
            }
        }
    }
    return best?.job ?? patternMatch(reported, jobs);
};

// What the run reported for one job: its display name and how it went.
export interface ReportedJob {
    readonly name: string;
    readonly status: PipelineStatus;
}

// One job of the run's graph, reported or only declared.
export interface RunJob {
    readonly name: string;
    // Its id in the workflow, a called file's job under its caller as `caller.job`: GitHub's own name for it.
    readonly declaredId?: string;
    // Index into the reported list; absent for a job only the workflow declares, which the run has not reported.
    readonly reported?: number;
    // How a declared-only job is drawn; a reported job keeps the status the run gave it.
    readonly status: PipelineStatus;
    // What it waited on, by the names in this list: jobs it declares as needs first, then the jobs that finish a call
    // it needs, the order GitHub lists them in. Absent for a reported job nothing declares.
    readonly needs?: readonly string[];
    // The matrix it is a leg of, by the matrix job's name; legs of one matrix share a card.
    readonly matrix?: string;
    // A declared-only job inside a call the run reported as one job: that job's index, whose page stands in for it.
    readonly standIn?: number;
}

// Plain code-unit order, the same on every machine; localeCompare would follow the server's locale.
const compareText = (one: string, other: string): number => (one < other ? -1 : one > other ? 1 : 0);

// A call reported as one job in these states never expanded into its own jobs; they are drawn in its place, as it was.
// One that failed or ran stays one job: a failed call's own report is the thing to read.
const STAND_IN_EXPANDS: ReadonlySet<PipelineStatus> = new Set(["skipped", "queued", "canceled"]);

// The run's jobs as GitHub draws them: every reported job matched to its declaration, plus every declared job the run
// has not reported (still waiting while the run is in flight, never ran once it settled), in GitHub's order inside a
// card, with unmatched reported jobs last and unwired. Undefined when the workflow can't be read.
export const resolveRun = (
    workflowYaml: string,
    reported: readonly ReportedJob[],
    calledWorkflows: ReadonlyMap<string, string> = new Map(),
): RunJob[] | undefined => {
    const { jobs } = flatten(workflowYaml, calledWorkflows, undefined, []);
    if (jobs.length === 0) {
        return undefined;
    }
    const byKey = new Map(jobs.map((job): [string, FlatJob] => [job.key, job]));
    const matched = reported.map((job) => matchFlat(job.name, jobs));
    const reportedByKey = new Map<string, number[]>();
    matched.forEach((job, index) => {
        if (job !== undefined) {
            reportedByKey.set(job.key, [...(reportedByKey.get(job.key) ?? []), index]);
        }
    });

    // A followed call the run reported as one job: expanded into its jobs, or kept whole (see STAND_IN_EXPANDS).
    const standIns = [...reportedByKey].flatMap(([key, indexes]) => {
        const [index] = indexes;
        const call = byKey.get(key);
        const job = index === undefined ? undefined : reported[index];
        return call?.followed === true && index !== undefined && job !== undefined ? [{ key, index, expands: STAND_IN_EXPANDS.has(job.status) }] : [];
    });
    const within = (key: string, call: string): boolean => key.startsWith(`${call}${CALL}`);
    const standInOver = (key: string): { readonly index: number; readonly expands: boolean } | undefined =>
        standIns.find((standIn) => within(key, standIn.key));

    const inFlight = reported.length === 0 || reported.some((job) => job.status === "queued" || job.status === "running");
    const unreportedStatus = (key: string): PipelineStatus => {
        const standIn = standInOver(key);
        const job = standIn === undefined ? undefined : reported[standIn.index];
        return job?.status ?? (inFlight ? "queued" : "skipped");
    };
    // A declared job the run has not reported is drawn when its name can be predicted, unless a call it sits in was
    // reported whole and kept that way.
    const drawnUnreported = (job: FlatJob): boolean =>
        !job.followed && job.predictable && !reportedByKey.has(job.key) && standInOver(job.key)?.expands !== false;
    const displayOf = (job: FlatJob): string => job.labels[0] ?? job.key;

    // The names a dependency on `key` resolves to: what the run reported for it, its drawn stand-in, or, for a followed
    // call, whatever finishes it, maybe another call.
    const namesFor = (key: string): string[] => {
        const job = byKey.get(key);
        if (job === undefined) {
            return [];
        }
        const own = reportedByKey.get(key) ?? [];
        if (job.followed) {
            const kept = standIns.find((standIn) => standIn.key === key && !standIn.expands);
            return kept !== undefined ? own.map((index) => reported[index]?.name ?? "") : job.finishedBy.flatMap(namesFor);
        }
        if (own.length > 0) {
            return own.map((index) => reported[index]?.name ?? "");
        }
        return drawnUnreported(job) ? [displayOf(job)] : [];
    };
    const needsOf = (job: FlatJob): string[] => {
        const direct = job.needs.filter((key) => byKey.get(key)?.followed !== true);
        const throughCalls = job.needs.filter((key) => byKey.get(key)?.followed === true);
        return [...new Set([...direct, ...throughCalls].flatMap(namesFor))];
    };
    // The declaration's GitHub id, and the matrix it is a leg of; both describe the declaration, whoever reported it.
    const declarationOf = (job: FlatJob): { declaredId: string; matrix?: string } => ({
        declaredId: job.key.split(CALL).join("."),
        ...(job.matrix ? { matrix: displayOf(job) } : {}),
    });

    const reportedEntry = (index: number, job: FlatJob): RunJob[] => {
        const found = reported[index];
        return found === undefined ? [] : [{ name: found.name, reported: index, status: found.status, needs: needsOf(job), ...declarationOf(job) }];
    };
    const drawn = jobs.flatMap((job): RunJob[] => {
        const own = reportedByKey.get(job.key) ?? [];
        if (job.followed) {
            const kept = standIns.find((standIn) => standIn.key === job.key && !standIn.expands);
            return kept === undefined ? [] : own.flatMap((index) => reportedEntry(index, job));
        }
        if (own.length > 0) {
            return own.flatMap((index) => reportedEntry(index, job));
        }
        if (!drawnUnreported(job)) {
            return [];
        }
        const standIn = standInOver(job.key);
        return [
            {
                name: displayOf(job),
                status: unreportedStatus(job.key),
                needs: needsOf(job),
                ...declarationOf(job),
                ...(standIn === undefined ? {} : { standIn: standIn.index }),
            },
        ];
    });

    // GitHub's order of a card's rows: what the run reported, in workflow order (a matrix's legs as the run listed
    // them), then what it has not, by name.
    const ordered = drawn.toSorted((one, other) => {
        const oneDeclared = one.reported === undefined;
        const otherDeclared = other.reported === undefined;
        return Number(oneDeclared) - Number(otherDeclared) || (oneDeclared && otherDeclared ? compareText(one.name, other.name) : 0);
    });
    const unmatched = reported.flatMap((job, index): RunJob[] =>
        matched[index] === undefined ? [{ name: job.name, reported: index, status: job.status }] : [],
    );
    return [...ordered, ...unmatched];
};
