import type { DagEdge, DagNode } from "@intentic/extension-ui";
import type { PipelineJob, PipelineStatus } from "@intentic/sandbox-contract";

/* A run's flat job list → the layered graph both pipeline views render: the inline status circles and the
 * expanded DagGraph. One derivation, two consumers, so a circle and its node always agree.
 *
 * The two vendors hand us different amounts of truth and the layering follows that split:
 *   - GitLab names a `stage` per job — its native sequential grouping, used verbatim.
 *   - GitHub Actions exposes neither `stage` nor `needs` on the jobs API, so there is no declared graph to
 *     draw. Jobs are layered by observed execution instead: overlapping runtimes ⇒ the jobs were concurrent,
 *     and a job starting only after its whole layer finished opens the next one. That reconstructs the usual
 *     build → test → deploy shape without inventing dependencies, at the cost of one honest imprecision —
 *     a job merely *delayed* (queued behind a busy runner) reads as sequential. It did run later; it just may
 *     not have had to.
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

export const worstStatus = (jobs: readonly PipelineJob[]): PipelineStatus =>
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

export const pipelineStages = (jobs: readonly PipelineJob[]): PipelineStage[] => {
    const groups = jobs.some((job) => job.stage !== undefined) ? namedStages(jobs) : executionWaves(jobs);
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
export const jobNodeId = (stageIndex: number, jobIndex: number): string => `${stageIndex}:${jobIndex}`;

// A node id back to the stage it belongs to. The ids are positional (jobNodeId), so this is a parse rather
// than a lookup, and it is what every question about a job's place in the run is answered from.
export const stageOfNode = (nodeId: string): number => Number(nodeId.split(`:`)[0]);

/* ONE JOB'S LINE THROUGH THE RUN — what lights up when a card is under the pointer.
 *
 * Everything an earlier stage held had to finish before this job could start, and everything a later stage
 * holds waited on it: both are on its line. The jobs BESIDE it in its own stage are the ones it merely ran
 * alongside — same moment, no relation — so they are what fades, and on a run that fans out they are most of
 * the picture. That is the whole point of the gesture: on the four-way `test` stage every reader has, hovering
 * one leg answers "which of these am I looking at" instantly.
 *
 * Exact rather than a graph walk, because the edges are a stage-to-stage join and not a declared dependency
 * (see pipelineDag): a job's line IS every job in an earlier stage and every job in a later one. Nothing to
 * traverse, and no closure to keep in sync with the edges it was derived from.
 *
 * The honest limit, worth knowing before reading much into a wide fan-in: neither vendor's jobs API returns
 * `needs`, so "everything in the previous stage" is the strongest true statement available. A job that in the
 * workflow file waited on exactly one of six lights all six here. */
export const onJobLine = (nodeId: string, focusId: string): boolean => stageOfNode(nodeId) !== stageOfNode(focusId) || nodeId === focusId;

export interface PipelineDag {
    readonly nodes: DagNode<PipelineJob>[];
    readonly edges: DagEdge[];
}

/* One edge, styled by the two jobs it spans: tinted by what flowed along it so a failure's blast radius is
 * traceable by eye, and dashed into work that never ran rather than asserting "and then this happened".
 *
 * While a job is focused the TRACE wins that tinting, in one colour for the whole line rather than two for its
 * two directions — which is the choice the vendors' own graphs make, and it stays out of a view where every
 * other colour on screen already means a status. Left-to-right says the direction; the accent only says
 * "you are on it". Everything off the line fades instead. */
const stageEdge = (from: string, to: string, job: PipelineJob, next: PipelineJob, focus: string | undefined): DagEdge => {
    const dashed = next.status === `skipped` || next.status === `canceled` ? { dashed: true } : {};
    if (focus !== undefined) {
        return onJobLine(from, focus) && onJobLine(to, focus) ? { from, to, accent: `text-link`, ...dashed } : { from, to, dimmed: true, ...dashed };
    }
    return {
        from,
        to,
        ...(job.status === `failed` ? { accent: `text-danger` } : {}),
        ...(job.status === `running` ? { accent: `text-info` } : {}),
        ...dashed,
    };
};

// Stages → the DagGraph model: one node per job, and edges fanning every job of a stage into every job of the
// next. That bipartite join is what both vendors' own graphs draw for stage-sequenced pipelines — a stage
// starts when the previous one is done, regardless of which job you follow. `focus` is the job under the
// pointer (or pinned by a click): its line is drawn, the rest fades. Only the styling moves with it, never an
// id or an edge, so a hover cannot disturb the layout or throw away the reader's pan.
export const pipelineDag = (stages: readonly PipelineStage[], focus?: string): PipelineDag => {
    const nodes = stages.flatMap((stage, stageIndex) =>
        stage.jobs.map((job, jobIndex) => {
            const id = jobNodeId(stageIndex, jobIndex);
            // No `tooltip`: a card's own popup is drawn ABOVE it, over the neighbours whose lighting or fading
            // is the entire answer to the hover that summoned it. The graph's caption says the same things —
            // full name, stage, what the job's line reaches — in a fixed corner that occludes nothing.
            return { id, data: job, ...(focus !== undefined && !onJobLine(id, focus) ? { dimmed: true } : {}) };
        }),
    );

    const edges = stages.flatMap((stage, stageIndex) => {
        const downstream = stages[stageIndex + 1];
        if (downstream === undefined) {
            return [];
        }
        return stage.jobs.flatMap((job, jobIndex) =>
            downstream.jobs.map((next, nextIndex) =>
                stageEdge(jobNodeId(stageIndex, jobIndex), jobNodeId(stageIndex + 1, nextIndex), job, next, focus),
            ),
        );
    });

    return { nodes, edges };
};

/* WHAT THE TRACE SAYS IN WORDS, for the caption above the canvas. The counts are the reason to read the
 * picture at all — "nine jobs waited on this one" is the sentence a person is looking for when they hover the
 * job that failed — and they are the one part of the highlight a screenshot or a colour-blind reader still
 * gets. `alongside` is deliberately absent: it is what the fading already says. */
export interface LineageCounts {
    readonly before: number;
    readonly after: number;
}

export const lineageCounts = (stages: readonly PipelineStage[], focus: string): LineageCounts => {
    const focused = stageOfNode(focus);
    const total = (from: number, to: number): number => stages.slice(from, to).reduce((count, stage) => count + stage.jobs.length, 0);
    return { before: total(0, focused), after: total(focused + 1, stages.length) };
};
