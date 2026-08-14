import type { DagEdge, DagNode } from "@intentic/extension-ui";
import type { PipelineJob, PipelineStatus } from "@intentic/sandbox-contract";

/* A run's flat job list → the layered graph both pipeline views render: the inline status circles and the
 * expanded DagGraph. One derivation, two consumers, so a circle and its node always agree.
 *
 * THREE WAYS TO LEARN THE SHAPE OF A RUN, in descending order of truth, and the picture is only ever as good
 * as the best one available:
 *
 *   1. DECLARED DEPENDENCIES (`needs`). The real graph — the only source that can say job X waited on job Y
 *      rather than on everything that happened before it. Neither vendor returns it from the jobs API; the
 *      daemon reads it out of the workflow definition (sandbox: ci/workflowGraph.ts). When it is here, the
 *      edges ARE the dependencies and the layers are dependency depth.
 *   2. STAGES. GitLab's native sequential grouping, returned per job and used verbatim. Edges join every job
 *      of a stage to every job of the next, because that is all a stage boundary claims: the next stage starts
 *      when this one is done, whichever job you follow.
 *   3. EXECUTION WAVES. The last resort, and what GitHub looked like before (1) existed: overlapping runtimes
 *      ⇒ the jobs were concurrent, and a job starting only after its whole layer finished opens the next one.
 *      It reconstructs the usual build → test → deploy shape without inventing dependencies, at the cost of one
 *      honest imprecision — a job merely DELAYED (queued behind a busy runner) reads as sequential. It did run
 *      later; it just may not have had to. On a big real workflow that failure mode dominates, and thirteen
 *      genuinely branching jobs come out as thirteen sequential steps: a flat line. Which is precisely why (1)
 *      is worth two extra HTTP calls.
 */

export interface PipelineStage {
    // GitLab's stage name. Absent for a GitHub wave, which has no name the vendor would recognize.
    readonly name: string | undefined;
    // The worst status among the stage's jobs — what the inline circle shows.
    readonly status: PipelineStatus;
    readonly jobs: readonly PipelineJob[];
}

// Severity order for collapsing many job statuses into one stage status: a single failure dominates, and a
// stage is only "success" when nothing in it did anything worse.
const STATUS_WEIGHT: Record<PipelineStatus, number> = { failed: 0, running: 1, canceled: 2, skipped: 3, success: 4 };

const worstStatus = (jobs: readonly PipelineJob[]): PipelineStatus =>
    jobs.reduce<PipelineStatus>((worst, job) => (STATUS_WEIGHT[job.status] < STATUS_WEIGHT[worst] ? job.status : worst), `success`);

// One layer of the pipeline before its status is collapsed. Named only when the vendor named it.
interface JobGroup {
    readonly name: string | undefined;
    readonly jobs: readonly PipelineJob[];
}

// A group's place on the clock: the earliest start among its jobs. Groups that never ran sort last.
const startOf = (group: readonly PipelineJob[]): number =>
    group.reduce((earliest, job) => Math.min(earliest, job.startedAt ?? Number.MAX_SAFE_INTEGER), Number.MAX_SAFE_INTEGER);

// GitLab: group by the vendor's stage. Ordered by when each stage first started rather than by array order,
// because the jobs endpoint's ordering is not contractual. A stage that never ran carries no timestamp and
// sorts last — which is where wholly-skipped stages (deploy on a non-default branch) belong anyway.
const namedStages = (jobs: readonly PipelineJob[]): JobGroup[] => {
    const groups = new Map<string, PipelineJob[]>();
    for (const job of jobs) {
        const key = job.stage ?? ``;
        const group = groups.get(key);
        if (group === undefined) {
            groups.set(key, [job]);
            continue;
        }
        group.push(job);
    }
    return (
        [...groups.entries()]
            .toSorted(([, a], [, b]) => startOf(a) - startOf(b))
            // A run that mixes staged and unstaged jobs leaves the latter under the empty key — unnamed, not "".
            .map(([name, group]): JobGroup => ({ name: name === `` ? undefined : name, jobs: group }))
    );
};

// GitHub: layer by observed concurrency. Walking start-ascending, a job joins the open layer while it starts
// before that layer's last finish; a still-running job holds its layer open (anything starting after it is
// genuinely concurrent with it). Jobs that never started are queued work — one trailing layer.
const executionWaves = (jobs: readonly PipelineJob[]): JobGroup[] => {
    const started = jobs.filter((job) => job.startedAt !== undefined).toSorted((a, b) => (a.startedAt ?? 0) - (b.startedAt ?? 0));
    const queued = jobs.filter((job) => job.startedAt === undefined);

    const waves: PipelineJob[][] = [];
    let open: PipelineJob[] = [];
    let openEnd = Number.NEGATIVE_INFINITY;
    for (const job of started) {
        if (open.length > 0 && (job.startedAt ?? 0) >= openEnd) {
            waves.push(open);
            open = [];
            openEnd = Number.NEGATIVE_INFINITY;
        }
        open.push(job);
        openEnd = Math.max(openEnd, job.finishedAt ?? Number.POSITIVE_INFINITY);
    }
    if (open.length > 0) {
        waves.push(open);
    }
    if (queued.length > 0) {
        waves.push(queued);
    }
    return waves.map((wave): JobGroup => ({ name: undefined, jobs: wave }));
};

/* Declared dependencies: layer by DEPENDENCY DEPTH — one past the deepest thing a job waits on. That is the
 * layering dagre would derive from the edges anyway, computed here as well so the row's inline circles are
 * the same run as the graph rather than a second opinion about it.
 *
 * A job that matched nothing in the workflow file has no `needs` and lands at depth 0, beside the real roots.
 * That is the honest placement for "we could not tell what gated this" — better than threading it into a
 * sequence it may not belong to. A workflow that declares a cycle cannot happen through Actions, but a
 * hand-written file can say anything, so the walk carries a visiting guard and treats a revisit as depth 0;
 * dagre breaks the same cycle downstream. */
const declaredLevels = (jobs: readonly PipelineJob[]): JobGroup[] => {
    const byName = new Map<string, PipelineJob>(jobs.map((job) => [job.name, job]));
    const depths = new Map<PipelineJob, number>();
    const visiting = new Set<PipelineJob>();
    const depthOf = (job: PipelineJob): number => {
        const known = depths.get(job);
        if (known !== undefined) {
            return known;
        }
        if (visiting.has(job)) {
            return 0;
        }
        visiting.add(job);
        const parents = (job.needs ?? []).flatMap((name) => {
            const parent = byName.get(name);
            return parent === undefined || parent === job ? [] : [parent];
        });
        const depth = parents.length === 0 ? 0 : Math.max(...parents.map((parent) => depthOf(parent) + 1));
        visiting.delete(job);
        depths.set(job, depth);
        return depth;
    };

    const levels = new Map<number, PipelineJob[]>();
    for (const job of jobs) {
        const depth = depthOf(job);
        levels.set(depth, [...(levels.get(depth) ?? []), job]);
    }
    return [...levels.entries()].toSorted(([a], [b]) => a - b).map(([, group]): JobGroup => ({ name: undefined, jobs: group }));
};

// Whether this run came with its dependencies declared. One job carrying `needs` is enough: the resolver
// either understood the workflow file or it did not, and a job it could not place is exactly the one whose
// absence of `needs` must not drop the whole run back to guessing from timestamps.
const isDeclared = (jobs: readonly PipelineJob[]): boolean => jobs.some((job) => job.needs !== undefined);

export const pipelineStages = (jobs: readonly PipelineJob[]): PipelineStage[] => {
    const groups = isDeclared(jobs) ? declaredLevels(jobs) : jobs.some((job) => job.stage !== undefined) ? namedStages(jobs) : executionWaves(jobs);
    return groups.map((group) => ({ name: group.name, status: worstStatus(group.jobs), jobs: group.jobs }));
};

// What to call a stage on screen. GitLab names its own. A derived GitHub wave has no vendor name, but a wave
// holding a single job is that job — "build" beats "Step 1" — so only a genuinely parallel unnamed wave falls
// back to its position.
export const stageLabel = (stage: PipelineStage, index: number): string => {
    if (stage.name !== undefined) {
        return stage.name;
    }
    const [only] = stage.jobs;
    return stage.jobs.length === 1 && only !== undefined ? only.name : `Step ${index + 1}`;
};

// Stable per-job node id. Positional rather than name-based: GitHub matrix legs and reruns can repeat a name
// within a run, and a duplicate id would silently drop a node from the graph.
const jobNodeId = (stageIndex: number, jobIndex: number): string => `${stageIndex}:${jobIndex}`;

// A node id back to the stage it belongs to. The ids are positional (jobNodeId), so this is a parse rather
// than a lookup, and it is what every question about a job's place in the run is answered from.
export const stageOfNode = (nodeId: string): number => Number(nodeId.split(`:`)[0]);

export interface PipelineDag {
    readonly nodes: DagNode<PipelineJob>[];
    readonly edges: DagEdge[];
    // The focused job's line, handed back rather than recomputed by the caller: the caption reports the same
    // walk the dimming was drawn from, so the words and the picture cannot disagree. Undefined ⇒ nothing focused.
    readonly lineage: JobLineage | undefined;
}

// One arrow before anything decides how to draw it. Kept separate from DagEdge because the trace has to walk
// these before a single one can be styled.
interface JobLink {
    readonly from: string;
    readonly to: string;
}

const linkKey = (link: JobLink): string => `${link.from}>${link.to}`;

/* THE DECLARED GRAPH, when the run came with one. `needs` names jobs, the graph addresses nodes, and one name
 * can own several nodes — every leg of a matrix, every job of a called workflow — so depending on a name is
 * depending on all of them. A name that no job in this run answers to is dropped rather than drawn: it is an
 * `if:` that never fired or a matrix leg that was excluded, and an edge to a node the graph does not contain
 * would be a claim about work that did not happen.
 *
 * Undefined when nothing declared anything — which is how the caller knows to fall back rather than to render
 * a graph with no edges at all, a picture that says "these thirteen jobs are unrelated" and means "we did not
 * look". */
const declaredLinks = (stages: readonly PipelineStage[]): JobLink[] | undefined => {
    const idsByName = new Map<string, string[]>();
    stages.forEach((stage, stageIndex) =>
        stage.jobs.forEach((job, jobIndex) => idsByName.set(job.name, [...(idsByName.get(job.name) ?? []), jobNodeId(stageIndex, jobIndex)])),
    );
    if (!stages.some((stage) => isDeclared(stage.jobs))) {
        return undefined;
    }
    return stages.flatMap((stage, stageIndex) =>
        stage.jobs.flatMap((job, jobIndex) => {
            const to = jobNodeId(stageIndex, jobIndex);
            return (job.needs ?? []).flatMap((name) => (idsByName.get(name) ?? []).filter((from) => from !== to).map((from) => ({ from, to })));
        }),
    );
};

// The fallback shape: every job of a stage into every job of the next. That bipartite join is all a stage
// boundary actually claims — the next stage starts when this one is done, whichever job you follow — and it is
// what both vendors' own graphs draw for a stage-sequenced pipeline.
const stageJoinLinks = (stages: readonly PipelineStage[]): JobLink[] =>
    stages.flatMap((stage, stageIndex) => {
        const downstream = stages[stageIndex + 1];
        if (downstream === undefined) {
            return [];
        }
        return stage.jobs.flatMap((_job, jobIndex) =>
            downstream.jobs.map((_next, nextIndex) => ({ from: jobNodeId(stageIndex, jobIndex), to: jobNodeId(stageIndex + 1, nextIndex) })),
        );
    });

/* ONE JOB'S LINE THROUGH THE RUN — what lights up when a card is under the pointer.
 *
 * Everything reachable BACKWARDS had to finish before this job could start; everything reachable FORWARDS
 * waited on it. Everything else — the jobs it merely ran alongside — fades, and on a run that fans out those
 * are most of the picture. That is the whole point of the gesture: on the four-way `test` stage every reader
 * has, hovering one leg answers "which of these am I looking at, and what did it hold up" instantly.
 *
 * A walk over the EDGES rather than arithmetic on stage positions, and that is what makes it worth having.
 * With declared dependencies the answer is exact: hovering one leg of a fan-out lights the one parent it
 * actually named and leaves its five siblings' parents dark. With the stage-join fallback the same walk
 * reaches every job of every earlier and later stage, which is the strongest true statement that shape
 * supports — so one implementation says as much as each source of truth allows, and never more.
 *
 * Edges are collected DURING the walk instead of being inferred from the endpoints afterwards. An edge whose
 * two ends are both related to the focus is not necessarily on a path THROUGH it — a bypass from an ancestor
 * straight to a descendant is the standard case — and lighting one would draw a route the run never took. */
export interface JobLineage {
    // The focus and everything on its line, by node id: what stays lit.
    readonly nodes: ReadonlySet<string>;
    // Edge keys on the line: what the trace is drawn along.
    readonly links: ReadonlySet<string>;
    // The two halves as counts, for the caption. "Nine jobs waited on this one" is the sentence someone
    // hovering a failed job came for, and it is the part of the highlight that survives a screenshot.
    readonly before: number;
    readonly after: number;
}

export const jobLineage = (links: readonly JobLink[], focus: string): JobLineage => {
    const walk = (step: (link: JobLink, at: string) => string | undefined): { reached: Set<string>; taken: Set<string> } => {
        const reached = new Set<string>();
        const taken = new Set<string>();
        const queue = [focus];
        while (queue.length > 0) {
            const at = queue.pop();
            if (at === undefined) {
                break;
            }
            for (const link of links) {
                const next = step(link, at);
                if (next === undefined) {
                    continue;
                }
                taken.add(linkKey(link));
                if (next !== focus && !reached.has(next)) {
                    reached.add(next);
                    queue.push(next);
                }
            }
        }
        return { reached, taken };
    };
    const before = walk((link, at) => (link.to === at ? link.from : undefined));
    const after = walk((link, at) => (link.from === at ? link.to : undefined));
    return {
        nodes: new Set([focus, ...before.reached, ...after.reached]),
        links: new Set([...before.taken, ...after.taken]),
        before: before.reached.size,
        after: after.reached.size,
    };
};

/* One edge, styled by the two jobs it spans: tinted by what flowed along it so a failure's blast radius is
 * traceable by eye, and dashed into work that never ran rather than asserting "and then this happened".
 *
 * While a job is focused the TRACE wins that tinting, in one colour for the whole line rather than two for its
 * two directions — which is the choice the vendors' own graphs make, and it stays out of a view where every
 * other colour on screen already means a status. Left-to-right says the direction; the accent only says
 * "you are on it". Everything off the line fades instead. */
const linkEdge = (link: JobLink, jobOf: ReadonlyMap<string, PipelineJob>, lineage: JobLineage | undefined): DagEdge => {
    const next = jobOf.get(link.to);
    const dashed = next?.status === `skipped` || next?.status === `canceled` ? { dashed: true } : {};
    if (lineage !== undefined) {
        return lineage.links.has(linkKey(link)) ? { ...link, accent: `text-link`, ...dashed } : { ...link, dimmed: true, ...dashed };
    }
    const job = jobOf.get(link.from);
    return {
        ...link,
        ...(job?.status === `failed` ? { accent: `text-danger` } : {}),
        ...(job?.status === `running` ? { accent: `text-info` } : {}),
        ...dashed,
    };
};

// Stages → the DagGraph model: one node per job, edges from whichever source of truth this run came with.
// `focus` is the job under the pointer (or pinned by a click): its line is drawn, the rest fades. Only the
// STYLING moves with it, never an id or an endpoint, so a hover cannot disturb the layout or throw away the
// reader's pan (DagGraph refits on the layout signature, which is ids and endpoints — see dagLayout.ts).
export const pipelineDag = (stages: readonly PipelineStage[], focus?: string): PipelineDag => {
    // The links come first because the trace is walked over them, and a node cannot say whether it is dimmed
    // until that walk has happened.
    const links = declaredLinks(stages) ?? stageJoinLinks(stages);
    const lineage = focus === undefined ? undefined : jobLineage(links, focus);

    const jobOf = new Map<string, PipelineJob>();
    const nodes = stages.flatMap((stage, stageIndex) =>
        stage.jobs.map((job, jobIndex) => {
            const id = jobNodeId(stageIndex, jobIndex);
            jobOf.set(id, job);
            // No `tooltip`: a card's own popup is drawn ABOVE it, over the neighbours whose lighting or fading
            // is the entire answer to the hover that summoned it. The graph's caption says the same things —
            // full name, stage, what the job's line reaches — in a fixed corner that occludes nothing.
            return { id, data: job, ...(lineage !== undefined && !lineage.nodes.has(id) ? { dimmed: true } : {}) };
        }),
    );

    return { nodes, edges: links.map((link) => linkEdge(link, jobOf, lineage)), lineage };
};
