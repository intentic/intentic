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
    return [...groups.entries()]
        .toSorted(([, a], [, b]) => startOf(a) - startOf(b))
        // A run that mixes staged and unstaged jobs leaves the latter under the empty key — unnamed, not "".
        .map(([name, group]): JobGroup => ({ name: name === `` ? undefined : name, jobs: group }));
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

export interface PipelineDag {
    readonly nodes: DagNode<PipelineJob>[];
    readonly edges: DagEdge[];
}

// One edge, styled by the two jobs it spans: tinted by what flowed along it so a failure's blast radius is
// traceable by eye, and dashed into work that never ran rather than asserting "and then this happened".
const stageEdge = (from: string, to: string, job: PipelineJob, next: PipelineJob): DagEdge => ({
    from,
    to,
    ...(job.status === `failed` ? { accent: `text-danger` } : {}),
    ...(job.status === `running` ? { accent: `text-info` } : {}),
    ...(next.status === `skipped` || next.status === `canceled` ? { dashed: true } : {}),
});

// Stages → the DagGraph model: one node per job, and edges fanning every job of a stage into every job of the
// next. That bipartite join is what both vendors' own graphs draw for stage-sequenced pipelines — a stage
// starts when the previous one is done, regardless of which job you follow.
export const pipelineDag = (stages: readonly PipelineStage[]): PipelineDag => {
    const nodes = stages.flatMap((stage, stageIndex) =>
        stage.jobs.map((job, jobIndex) => ({
            id: jobNodeId(stageIndex, jobIndex),
            data: job,
            tooltip: [job.name, stage.name, job.status].filter((part) => part !== undefined && part !== ``).join(` · `),
        })),
    );

    const edges = stages.flatMap((stage, stageIndex) => {
        const downstream = stages[stageIndex + 1];
        if (downstream === undefined) {
            return [];
        }
        return stage.jobs.flatMap((job, jobIndex) =>
            downstream.jobs.map((next, nextIndex) =>
                stageEdge(jobNodeId(stageIndex, jobIndex), jobNodeId(stageIndex + 1, nextIndex), job, next),
            ),
        );
    });

    return { nodes, edges };
};
