import type { DagEdge, DagNode } from "@intentic/extension-ui";
import type { PipelineJob, PipelineStatus } from "@intentic/sandbox-contract";

/* A run's flat job list → the layered graph both pipeline views render: the inline status circles and the
 * expanded DagGraph. One derivation, two consumers, so a circle and its node always agree.
 *
 * THREE WAYS TO LEARN THE SHAPE OF A RUN, in descending order of truth, and the picture is only ever as good
 * as the best one available:
 *
 *   1. DECLARED DEPENDENCIES (`needs`). The real graph, the only source that can say job X waited on job Y
 *      rather than on everything that happened before it. Neither vendor returns it from the jobs API; the
 *      daemon reads it out of the workflow definition (sandbox: ci/workflowGraph.ts). When it is here, the
 *      edges ARE the dependencies and the layers are dependency depth.
 *   2. STAGES. GitLab's native sequential grouping, returned per job and used verbatim. Edges join every job
 *      of a stage to every job of the next, because that is all a stage boundary claims: the next stage starts
 *      when this one is done, whichever job you follow.
 *   3. EXECUTION WAVES. The last resort, and what GitHub looked like before (1) existed: overlapping runtimes
 *      ⇒ the jobs were concurrent, and a job starting only after its whole layer finished opens the next one.
 *      It reconstructs the usual build → test → deploy shape without inventing dependencies, at the cost of one
 *      honest imprecision, a job merely DELAYED (queued behind a busy runner) reads as sequential. It did run
 *      later; it just may not have had to. On a big real workflow that failure mode dominates, and thirteen
 *      genuinely branching jobs come out as thirteen sequential steps: a flat line. Which is precisely why (1)
 *      is worth two extra HTTP calls.
 */

export interface PipelineStage {
    // GitLab's stage name. Absent for a GitHub wave, which has no name the vendor would recognize.
    readonly name: string | undefined;
    // The worst status among the stage's jobs, what the inline circle shows.
    readonly status: PipelineStatus;
    readonly jobs: readonly PipelineJob[];
}

/* Severity order for collapsing many job statuses into one stage status: a single failure dominates, and a
 * stage is only "success" when nothing in it did anything worse.
 *
 * `queued` sits behind `running` and ahead of the settled three, which is what makes a half-started stage read
 * as started: one leg of a four-way matrix executing while three wait for a runner is a stage in progress, and
 * a stage whose every job is still waiting is the one worth drawing as waiting. */
const STATUS_WEIGHT: Record<PipelineStatus, number> = { failed: 0, running: 1, queued: 2, canceled: 3, skipped: 4, success: 5 };

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
// sorts last, which is where wholly-skipped stages (deploy on a non-default branch) belong anyway.
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
            // A run that mixes staged and unstaged jobs leaves the latter under the empty key, unnamed, not "".
            .map(([name, group]): JobGroup => ({ name: name === `` ? undefined : name, jobs: group }))
    );
};

// GitHub: layer by observed concurrency. Walking start-ascending, a job joins the open layer while it starts
// before that layer's last finish; a still-running job holds its layer open (anything starting after it is
// genuinely concurrent with it). Jobs that never started are queued work, one trailing layer.
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

/* Declared dependencies: layer by DEPENDENCY DEPTH, one past the deepest thing a job waits on. That is the
 * layering dagre would derive from the edges anyway, computed here as well so the row's inline circles are
 * the same run as the graph rather than a second opinion about it.
 *
 * A job that matched nothing in the workflow file has no `needs` and lands at depth 0, beside the real roots.
 * That is the honest placement for "we could not tell what gated this", better than threading it into a
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
// holding a single job is that job, "build" beats "Step 1", so only a genuinely parallel unnamed wave falls
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

/* A CLUSTER is the compound node the graph draws: one or more jobs that share exactly the same set of incoming
 * and outgoing edges, rendered as rows inside a single card. GitHub's own pipeline view does the same grouping
 * visually (a box listing "release / images-amd64", "release / linux-build", …) rather than drawing N×M edges
 * between every pair of adjacent stages.
 *
 * Each member carries its original job-level node id so that hover/focus can still address an individual job
 * and the caption can name it. */
export interface PipelineJobCluster {
    readonly jobs: readonly { readonly id: string; readonly job: PipelineJob }[];
}

export interface PipelineDag {
    readonly nodes: DagNode<PipelineJobCluster>[];
    readonly edges: DagEdge[];
    // The focused job's line, handed back rather than recomputed by the caller: the caption reports the same
    // walk the dimming was drawn from, so the words and the picture cannot disagree. Undefined ⇒ nothing focused.
    readonly trace: PipelineTrace | undefined;
}

// One arrow before anything decides how to draw it. Kept separate from DagEdge because the trace has to walk
// these before a single one can be styled.
interface JobLink {
    readonly from: string;
    readonly to: string;
}

const linkKey = (link: JobLink): string => `${link.from}>${link.to}`;

/* THE DECLARED GRAPH, when the run came with one. `needs` names jobs, the graph addresses nodes, and one name
 * can own several nodes, every leg of a matrix, every job of a called workflow nobody could read, so depending
 * on a name is depending on all of them. A name that no job in this run answers to is dropped rather than
 * drawn: it is an `if:` that never fired or a matrix leg that was excluded, and an edge to a node it does not
 * contain would be a claim about work that did not happen.
 *
 * Undefined when nothing declared anything, which is how the caller knows to fall back rather than to render
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
// boundary actually claims, the next stage starts when this one is done, whichever job you follow, and it is
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

/* ONE JOB'S LINE THROUGH THE RUN, what lights up when a card is under the pointer.
 *
 * Everything reachable BACKWARDS had to finish before this job could start; everything reachable FORWARDS
 * waited on it. Everything else, the jobs it merely ran alongside, fades, and on a run that fans out those
 * are most of the picture. That is the whole point of the gesture: on the four-way `test` stage every reader
 * has, hovering one leg answers "which of these am I looking at, and what did it hold up" instantly.
 *
 * A walk over the EDGES rather than arithmetic on stage positions, and that is what makes it worth having.
 * With declared dependencies the answer is exact: hovering one leg of a fan-out lights the one parent it
 * actually named and leaves its five siblings' parents dark. With the stage-join fallback the same walk
 * reaches every job of every earlier and later stage, which is the strongest true statement that shape
 * supports, so one implementation says as much as each source of truth allows, and never more.
 *
 * Edges are collected DURING the walk instead of being inferred from the endpoints afterwards. An edge whose
 * two ends are both related to the focus is not necessarily on a path THROUGH it, a bypass from an ancestor
 * straight to a descendant is the standard case, and lighting one would draw a route the run never took. */
export interface JobLineage {
    // The focus and everything on its line, by node id: what stays lit.
    readonly nodes: ReadonlySet<string>;
    /* That set's two halves, focus excluded: what had to finish first, and what waited. Sets rather than the
     * counts the caption prints, because one node here can stand for several jobs (a compound card) and only
     * the caller knows what one node is worth. */
    readonly before: ReadonlySet<string>;
    readonly after: ReadonlySet<string>;
    // Edge keys on the line: what the trace is drawn along.
    readonly links: ReadonlySet<string>;
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
        before: before.reached,
        after: after.reached,
        links: new Set([...before.taken, ...after.taken]),
    };
};

// ── Compound cards: the jobs that share a line share a box ──────────────────────────────────────

// One job and the id the graph addresses it by.
interface JobNode {
    readonly id: string;
    readonly job: PipelineJob;
}

/* THE JOBS GROUPED INTO THE CARDS THE GRAPH DRAWS. Two jobs share a card when their incoming and outgoing
 * edges are exactly the same, which is the same property that lets a card be lit or faded as ONE thing: jobs
 * with identical edges have identical lines through the run, so no reading of a trace would light one member
 * and leave another dark.
 *
 * The signature is those two endpoint sets, sorted and joined: cheap to compare, and independent of the focus,
 * so only styling ever moves with a hover. A job whose signature is its own stays alone in its card, which
 * makes the grouping strictly additive, it changes how many boxes are drawn and never the topology.
 *
 * A card's id is its first member's job id: positional, stable, and already unique. */
interface JobCards {
    // First-appearance order, which is stage order: the order the nodes come back in.
    readonly cards: readonly { readonly id: string; readonly cluster: PipelineJobCluster }[];
    // Job id → the id of the card holding it.
    readonly cardOf: ReadonlyMap<string, string>;
}

const jobCards = (jobs: readonly JobNode[], links: readonly JobLink[]): JobCards => {
    const present = new Set(jobs.map((entry) => entry.id));
    // Only edges the graph will actually draw: a dropped one must not split two otherwise identical jobs.
    const drawn = links.filter((link) => present.has(link.from) && present.has(link.to));
    const endpoints = (ids: readonly string[]): string => [...new Set(ids)].toSorted().join(`,`);
    const signatureOf = (id: string): string => {
        const waitedOn = endpoints(drawn.filter((link) => link.to === id).map((link) => link.from));
        const opened = endpoints(drawn.filter((link) => link.from === id).map((link) => link.to));
        return `${waitedOn}|${opened}`;
    };

    const bySignature = new Map<string, JobNode[]>();
    for (const entry of jobs) {
        const signature = signatureOf(entry.id);
        bySignature.set(signature, [...(bySignature.get(signature) ?? []), entry]);
    }

    const cardOf = new Map<string, string>();
    const cards = [...bySignature.values()].flatMap((members) => {
        const [first] = members;
        if (first === undefined) {
            return [];
        }
        for (const member of members) {
            cardOf.set(member.id, first.id);
        }
        return [{ id: first.id, cluster: { jobs: members } }];
    });
    return { cards, cardOf };
};

/* Job-level links → card-level links: the whole point of the grouping. A stage-sequenced run's N×M bipartite
 * join between two stages is one arrow between two cards, which is the spaghetti this view had before, and an
 * edge whose ends land in the same card is dropped, it was an arrow between two rows of one box. */
const cardLinks = (links: readonly JobLink[], cardOf: ReadonlyMap<string, string>): JobLink[] => {
    const seen = new Set<string>();
    return links.flatMap((link) => {
        const from = cardOf.get(link.from) ?? link.from;
        const to = cardOf.get(link.to) ?? link.to;
        if (from === to || seen.has(`${from}>${to}`)) {
            return [];
        }
        seen.add(`${from}>${to}`);
        return [{ from, to }];
    });
};

/* THE FOCUSED CARD'S LINE, AS THE VIEW NEEDS IT rather than as the walk produced it: which cards stay lit,
 * which edges the trace is drawn along, and the two halves as JOB counts. Counting jobs and not cards is the
 * whole reason this is a second type: a reader hovering one leg of a four-way fan-out is told what the run
 * did, and "one ran before" would be a lie about a card holding four of them. */
export interface PipelineTrace {
    // Card ids that stay lit. Everything else fades.
    readonly cards: ReadonlySet<string>;
    // Edge keys on the line.
    readonly links: ReadonlySet<string>;
    // Individual jobs upstream and downstream of the focus, for the caption.
    readonly before: number;
    readonly after: number;
}

/* One edge, styled by the cards it spans: tinted by what flowed along it so a failure's reach is traceable by
 * eye.
 *
 * EVERY EDGE IS ONE SOLID LINE. An arrow into a card whose jobs all skipped used to be DASHED, on the reasoning
 * that a dash says "this handover never happened" rather than asserting that it did. What a dash actually says
 * to a reader is "uncertain, or not real, or some other kind of thing" — a distinction they then have to look
 * up, on a diagram whose whole job is to be read at a glance. And it was never the only witness: the skipped
 * jobs carry their own glyph and their own muted row, one card away from the line asking the question. GitHub's
 * own graph draws one weight for every edge for the same reason.
 *
 * While a job is focused the TRACE wins that tinting, in one colour for the whole line rather than two for its
 * two directions, which is the choice the vendors' own graphs make, and it stays out of a view where every
 * other colour on screen already means a status. Left-to-right says the direction; the accent only says
 * "you are on it". Everything off the line fades instead. */
const linkEdge = (link: JobLink, clusterById: ReadonlyMap<string, PipelineJobCluster>, trace: PipelineTrace | undefined): DagEdge => {
    if (trace !== undefined) {
        return trace.links.has(linkKey(link)) ? { ...link, accent: `text-link` } : { ...link, dimmed: true };
    }
    // A card's worst outcome tints what left it: a failure anywhere inside it is what a reader is tracing.
    const source = clusterById.get(link.from);
    const carried = (status: PipelineStatus): boolean => source?.jobs.some((member) => member.job.status === status) === true;
    const accent = carried(`failed`) ? { accent: `text-danger` } : carried(`running`) ? { accent: `text-info` } : {};
    return { ...link, ...accent };
};

// Stages → the DagGraph model: one compound card per group of identically-wired jobs, one edge per pair of
// cards. `focus` is the JOB id under the pointer (or pinned by a click): the line through the card holding it
// is drawn, the rest fades. Only the STYLING moves with it, never an id or an endpoint, so a hover cannot
// disturb the layout or throw away the reader's pan (DagGraph refits on the layout signature, which is ids,
// endpoints and node boxes, see dagLayout.ts).
export const pipelineDag = (stages: readonly PipelineStage[], focus?: string): PipelineDag => {
    // Positional ids first: the links are addressed by them, and everything below is derived from the links.
    const jobs = stages.flatMap((stage, stageIndex) => stage.jobs.map((job, jobIndex): JobNode => ({ id: jobNodeId(stageIndex, jobIndex), job })));
    const jobLinks = declaredLinks(stages) ?? stageJoinLinks(stages);
    const { cards, cardOf } = jobCards(jobs, jobLinks);
    const links = cardLinks(jobLinks, cardOf);

    // The trace is walked over the CARDS, so a job-level focus moves to the card holding it first.
    const focusCard = focus === undefined ? undefined : cardOf.get(focus);
    const lineage = focusCard === undefined ? undefined : jobLineage(links, focusCard);
    const jobsIn = (ids: ReadonlySet<string>): number =>
        cards.reduce((count, card) => (ids.has(card.id) ? count + card.cluster.jobs.length : count), 0);
    const trace: PipelineTrace | undefined =
        lineage === undefined
            ? undefined
            : { cards: lineage.nodes, links: lineage.links, before: jobsIn(lineage.before), after: jobsIn(lineage.after) };

    const clusterById = new Map(cards.map((card) => [card.id, card.cluster]));
    const nodes = cards.map((card): DagNode<PipelineJobCluster> => ({
        id: card.id,
        data: card.cluster,
        // No `tooltip`: a card's own popup is drawn ABOVE it, over the neighbours whose lighting or fading
        // is the entire answer to the hover that summoned it. The graph's caption says the same things,
        // full name, stage, what the job's line reaches, in a fixed corner that occludes nothing.
        ...(trace !== undefined && !trace.cards.has(card.id) ? { dimmed: true } : {}),
    }));

    return { nodes, edges: links.map((link) => linkEdge(link, clusterById, trace)), trace };
};
