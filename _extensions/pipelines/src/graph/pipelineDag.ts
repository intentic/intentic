import { dagLayers } from "@intentic/base/dag";
import type { DagEdge, DagNode } from "@intentic/extension-ui";
import type { PipelineJob, PipelineStatus } from "@intentic/sandbox-contract";
import { t } from "../i18n";

// A run's flat job list becomes the layered graph both pipeline views render, from the best available source of shape:
// 1. Declared dependencies (`needs`): the real graph; layers are dependency depth.
// 2. Stages: GitLab's own sequential grouping; edges join every job of a stage to every job of the next.
// 3. Execution waves: overlapping runtimes imply concurrency; a runner-delayed job reads as sequential.

export interface PipelineStage {
    // GitLab's stage name; absent for a GitHub wave, which has no vendor name.
    readonly name: string | undefined;
    // Worst status among the stage's jobs; what the inline circle shows.
    readonly status: PipelineStatus;
    readonly jobs: readonly PipelineJob[];
}

// Failure dominates; `queued` outranks settled statuses so a half-started stage still reads as in progress.
const STATUS_WEIGHT: Record<PipelineStatus, number> = { failed: 0, running: 1, queued: 2, canceled: 3, skipped: 4, success: 5 };

const worstStatus = (jobs: readonly PipelineJob[]): PipelineStatus =>
    jobs.reduce<PipelineStatus>((worst, job) => (STATUS_WEIGHT[job.status] < STATUS_WEIGHT[worst] ? job.status : worst), `success`);

// One layer of the pipeline before its status is collapsed; named only when the vendor named it.
interface JobGroup {
    readonly name: string | undefined;
    readonly jobs: readonly PipelineJob[];
}

// A group's place on the clock: earliest start among its jobs. Groups that never ran sort last.
const startOf = (group: readonly PipelineJob[]): number =>
    group.reduce((earliest, job) => Math.min(earliest, job.startedAt ?? Number.MAX_SAFE_INTEGER), Number.MAX_SAFE_INTEGER);

// Groups by GitLab stage, ordered by first start rather than array order (the jobs endpoint's order isn't contractual);
// a stage that never ran sorts last.
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
            // Unstaged jobs land under the empty key, mapped to `undefined`, not `""`.
            .map(([name, group]): JobGroup => ({ name: name === `` ? undefined : name, jobs: group }))
    );
};

// Layers by observed concurrency: walking start-ascending, a job joins the open layer if it starts before that layer's
// last finish (a still-running job keeps the layer open). Jobs that never started form one trailing layer.
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

// Layers by dependency generation, the one layering workflows use too: a job lands one past the deepest `needs` target,
// a need matching no job is ignored, and a declared cycle goes in one final layer rather than an invented order.
const declaredLevels = (jobs: readonly PipelineJob[]): JobGroup[] =>
    dagLayers(
        jobs,
        (job) => job.name,
        (job) => job.needs ?? [],
    ).map((group): JobGroup => ({ name: undefined, jobs: group }));

// True if any job carries `needs`; one job missing it must not fall the whole run back to guessing from timestamps.
const isDeclared = (jobs: readonly PipelineJob[]): boolean => jobs.some((job) => job.needs !== undefined);

export const pipelineStages = (jobs: readonly PipelineJob[]): PipelineStage[] => {
    const groups = isDeclared(jobs) ? declaredLevels(jobs) : jobs.some((job) => job.stage !== undefined) ? namedStages(jobs) : executionWaves(jobs);
    return groups.map((group) => ({ name: group.name, status: worstStatus(group.jobs), jobs: group.jobs }));
};

// Stage label: GitLab's own name if set; an unnamed single-job wave takes that job's name; only a genuinely parallel
// wave falls back to its position.
export const stageLabel = (stage: PipelineStage, index: number): string => {
    if (stage.name !== undefined) {
        return stage.name;
    }
    const [only] = stage.jobs;
    return stage.jobs.length === 1 && only !== undefined ? only.name : t(`pipelineDag.step`, { n: index + 1 });
};

// A job two calls deep or more is named the way GitHub names it on a card: the outermost call, an ellipsis, the job
// itself (`release / … / smoke`); the whole name stays on its tooltip.
export const jobLabel = (name: string): string => {
    const parts = name.split(` / `);
    const first = parts[0];
    const last = parts.at(-1);
    return parts.length > 2 && first !== undefined && last !== undefined ? `${first} / … / ${last}` : name;
};

// Positional node id, not name-based: matrix legs and reruns can repeat a job name, colliding as an id.
const jobNodeId = (stageIndex: number, jobIndex: number): string => `${stageIndex}:${jobIndex}`;

// Stage index parsed back out of a node id (`stageIndex:jobIndex`, see jobNodeId).
export const stageOfNode = (nodeId: string): number => Number(nodeId.split(`:`)[0]);

// A cluster is the compound node the graph draws: jobs sharing the exact same incoming/outgoing edges, rendered as rows
// in one card. Each member keeps its job-level id for hover/focus and the caption.
export interface PipelineJobCluster {
    readonly jobs: readonly { readonly id: string; readonly job: PipelineJob }[];
}

export interface PipelineDag {
    readonly nodes: DagNode<PipelineJobCluster>[];
    readonly edges: DagEdge[];
    // Focused job's line, handed back so the caption matches the dimming; undefined when nothing is focused.
    readonly trace: PipelineTrace | undefined;
}

// One arrow, undecorated; kept separate from DagEdge since the trace walks these before any styling is chosen.
interface JobLink {
    readonly from: string;
    readonly to: string;
}

const linkKey = (link: JobLink): string => `${link.from}>${link.to}`;

// Declared graph from `needs`: a job name can address several nodes (matrix legs, called-workflow jobs); an unmatched
// name is dropped, not drawn to nothing. Undefined when nothing declared anything.
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

// Fallback shape: every job of a stage links to every job of the next, all a stage boundary actually claims.
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

// A job's line through the run: everything reachable backward finished first; everything forward waited on it. Walks
// edges directly, so a bypass edge related to the focus but not on a path through it never lights by mistake.
export interface JobLineage {
    // Focus plus everything on its line, by node id.
    readonly nodes: ReadonlySet<string>;
    // Focus excluded: what finished first, what waited; sets, not counts, since one node can stand for several jobs.
    readonly before: ReadonlySet<string>;
    readonly after: ReadonlySet<string>;
    // Edge keys the trace is drawn along.
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

// Compound cards: jobs that share a line share a box.

// One job and the id the graph addresses it by.
interface JobNode {
    readonly id: string;
    readonly job: PipelineJob;
}

// Jobs sharing exactly the same incoming/outgoing edges join one card, since identical edges mean identical lines
// through the run; a matrix's legs only ever share one with each other. Signature is the sorted endpoint sets
// (focus-independent); a card's id is its first member's job id.
interface JobCards {
    // First-appearance order, i.e. stage order.
    readonly cards: readonly { readonly id: string; readonly cluster: PipelineJobCluster }[];
    // Job id → the id of the card holding it.
    readonly cardOf: ReadonlyMap<string, string>;
}

const jobCards = (jobs: readonly JobNode[], links: readonly JobLink[]): JobCards => {
    const present = new Set(jobs.map((entry) => entry.id));
    // Edges the graph will draw; a dropped edge must not split two otherwise-identical jobs into different cards.
    const drawn = links.filter((link) => present.has(link.from) && present.has(link.to));
    const endpoints = (ids: readonly string[]): string => [...new Set(ids)].toSorted().join(`,`);
    const signatureOf = (entry: JobNode): string => {
        const waitedOn = endpoints(drawn.filter((link) => link.to === entry.id).map((link) => link.from));
        const opened = endpoints(drawn.filter((link) => link.from === entry.id).map((link) => link.to));
        // A matrix's legs share a card of their own, never one with another job wired the same way, as on GitHub.
        return `${entry.job.matrix ?? ``}#${waitedOn}|${opened}`;
    };

    const bySignature = new Map<string, JobNode[]>();
    for (const entry of jobs) {
        const signature = signatureOf(entry);
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

// Job-level links collapsed to card-level: an N×M bipartite join between two stages becomes one arrow between two
// cards; an edge whose ends land in the same card is dropped.
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

// GitHub's own drawing of a declared run, reproduced card for card: the rule below was read off GitHub's run pages, and
// sorts every column of twenty repositories' runs the way GitHub did. Within a column, cards sort by
// 1. their parents in the column just before, by place there, nearest the bottom compared first, fewer parents first
//    on a tie, so a card sits under the last card it waits on;
// 2. then the more cards waiting on them, the higher;
// 3. then GitHub's own key for a card, `needs|deps` (a matrix's `needs|-name-|deps`), compared code unit by code unit.
const compareText = (one: string, other: string): number => (one < other ? -1 : one > other ? 1 : 0);

const compareParents = (one: readonly number[], other: readonly number[]): number => {
    for (let index = 0; index < Math.max(one.length, other.length); index += 1) {
        const left = one[index];
        const right = other[index];
        if (left === undefined || right === undefined) {
            return left === undefined ? (right === undefined ? 0 : -1) : 1;
        }
        if (left !== right) {
            return left - right;
        }
    }
    return 0;
};

const githubOrder = (cards: JobCards[`cards`], links: readonly JobLink[]): Map<string, number> => {
    const parents = new Map<string, string[]>();
    const children = new Map<string, Set<string>>();
    for (const link of links) {
        parents.set(link.to, [...(parents.get(link.to) ?? []), link.from]);
        children.set(link.from, new Set([...(children.get(link.from) ?? []), link.to]));
    }
    // GitHub keys a job by its id in the workflow, a matrix's legs by the matrix job's, once; a name stands in where the
    // workflow was not read.
    const idOf = (job: PipelineJob): string => job.declaredId ?? job.name;
    const byName = new Map(cards.flatMap((card) => card.cluster.jobs.map((member) => [member.job.name, member.job] as const)));
    const keyOf = (card: (typeof cards)[number]): string => {
        const [first] = card.cluster.jobs;
        const needs = (first?.job.needs ?? []).flatMap((name) => {
            const job = byName.get(name);
            return job === undefined ? [] : [idOf(job)];
        });
        const members = new Set(card.cluster.jobs.map((member) => member.job.name));
        const waiting = new Set(
            cards.flatMap((other) =>
                other.cluster.jobs.filter((member) => (member.job.needs ?? []).some((name) => members.has(name))).map((member) => idOf(member.job)),
            ),
        );
        // Jobs of this file first, then jobs of called ones (`caller.job`), each alphabetical.
        const deps = [...waiting].toSorted((one, other) => Number(one.includes(`.`)) - Number(other.includes(`.`)) || compareText(one, other));
        const matrix = first?.job.matrix === undefined ? `` : `-${idOf(first.job)}-|`;
        return `${[...new Set(needs)].join(`&`)}|${matrix}${deps.join(`&`)}`;
    };

    const columns = new Map<number, (typeof cards)[number][]>();
    for (const card of cards) {
        const column = stageOfNode(card.id);
        columns.set(column, [...(columns.get(column) ?? []), card]);
    }
    const place = new Map<string, number>();
    for (const column of [...columns.keys()].toSorted((one, other) => one - other)) {
        const above = (id: string): number[] =>
            (parents.get(id) ?? [])
                .filter((parent) => stageOfNode(parent) === column - 1)
                .map((parent) => place.get(parent) ?? 0)
                .toSorted((one, other) => other - one);
        const ordered = (columns.get(column) ?? [])
            .map((card) => ({ card, above: above(card.id), waiting: children.get(card.id)?.size ?? 0, key: keyOf(card) }))
            .toSorted((one, other) => compareParents(one.above, other.above) || other.waiting - one.waiting || compareText(one.key, other.key));
        ordered.forEach((entry, index) => place.set(entry.card.id, index));
    }
    return place;
};

// Focused card's line reshaped for the view: lit cards, edge keys, and before/after as job counts, not card counts,
// since a card can hold several jobs.
export interface PipelineTrace {
    // Card ids that stay lit; everything else fades.
    readonly cards: ReadonlySet<string>;
    // Edge keys on the line.
    readonly links: ReadonlySet<string>;
    // Individual jobs upstream and downstream of the focus, for the caption.
    readonly before: number;
    readonly after: number;
}

// Every edge draws as one solid line, tinted by what flowed through the cards it spans. While a job is focused, the
// trace's single accent color replaces that tint for the traced line; everything else fades.
const linkEdge = (link: JobLink, clusterById: ReadonlyMap<string, PipelineJobCluster>, trace: PipelineTrace | undefined): DagEdge => {
    if (trace !== undefined) {
        return trace.links.has(linkKey(link)) ? { ...link, accent: `text-link` } : { ...link, dimmed: true };
    }
    // Worst outcome inside the source card tints the edge leaving it.
    const source = clusterById.get(link.from);
    const carried = (status: PipelineStatus): boolean => source?.jobs.some((member) => member.job.status === status) === true;
    const accent = carried(`failed`) ? { accent: `text-danger` } : carried(`running`) ? { accent: `text-info` } : {};
    return { ...link, ...accent };
};

// Stages to DagGraph: one card per group of identically-wired jobs, one edge per card pair. `focus` is a job id; only
// styling moves with it, never ids or endpoints, so a hover cannot reflow the layout.
export const pipelineDag = (stages: readonly PipelineStage[], focus?: string): PipelineDag => {
    // Positional ids first; everything below derives from the links they address.
    const jobs = stages.flatMap((stage, stageIndex) => stage.jobs.map((job, jobIndex): JobNode => ({ id: jobNodeId(stageIndex, jobIndex), job })));
    const declared = declaredLinks(stages);
    const jobLinks = declared ?? stageJoinLinks(stages);
    const { cards, cardOf } = jobCards(jobs, jobLinks);
    const links = cardLinks(jobLinks, cardOf);
    // A declared run is drawn exactly as GitHub draws it; stages and waves have no such picture to match.
    const order = declared === undefined ? undefined : githubOrder(cards, links);

    // Trace walks over cards, so a job-level focus first resolves to the card holding it.
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
        ...(order === undefined ? {} : { order: order.get(card.id) ?? 0 }),
        // No `tooltip`: the card's popup renders above it, over neighbours whose lighting/fading answers the hover.
        ...(trace !== undefined && !trace.cards.has(card.id) ? { dimmed: true } : {}),
    }));

    return { nodes, edges: links.map((link) => linkEdge(link, clusterById, trace)), trace };
};
