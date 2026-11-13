import type { AgentSummary } from "@intentic/sandbox-contract/schemas/agents";
import type { CiRunsResponse, PipelineRun } from "@intentic/sandbox-contract/schemas/ci";
import type { IntenticApi, ViewBadge } from "@intentic/extension-api";
import { sandboxPoll } from "@intentic/extension-api";
import { ciAttention, type Owed, owedTone } from "./attention";
import { ciRunsQuery } from "./ciRunsQuery";
import { host } from "./host";
import { t } from "./i18n.js";

// What the tile reads: the board's runs and failures, and the fleet's roster, which says who is on each failure.
interface AttentionFeed {
    readonly ci: CiRunsResponse;
    readonly agents: readonly AgentSummary[];
}

// The fleet's own `agents.list` entry, which the shell keeps live from its event stream (useCiFixes.ts reads the same),
// so asking it here is mostly a cache hit.
const AGENTS_STALE_MS = 15_000;
const agentsNow = async (api: IntenticApi): Promise<readonly AgentSummary[]> =>
    (
        await api.sandbox.fetch({
            queryKey: api.sandbox.readKey(`agents.list`),
            queryFn: () => api.sandbox.rpc.agents.list(),
            staleTime: AGENTS_STALE_MS,
        })
    ).agents;

// Module state owned by activate(), not the view, so the badge updates without Pipelines being open; reads through the
// host's cache, doubling as the board's first paint. A timer, not a file watch: nothing local observes the CI provider,
// so polling every 60s is the whole feed. The roster is asked only when something failed: a green board owes nothing.
const { state: feed, start: startCiAttention } = sandboxPoll<AttentionFeed>({
    host,
    everyMs: 60_000,
    initial: () => ({ ci: { repos: [], runs: [] }, agents: [] }),
    read: async (api, previous) => {
        const ci = await api.sandbox.fetch(ciRunsQuery());
        const failing = ci.runs.some((run) => run.status === `failed`) || (ci.failures?.length ?? 0) > 0;
        return { ci, agents: failing ? await agentsNow(api).catch(() => previous.agents) : [] };
    },
});

// Started by activate() so the badge is live from login, and disposed with the extension.
export { startCiAttention };

// The runs and repositories as the poll last read them: what the run side view's tab and a claimed link are answered
// from, since both are asked synchronously, on a render and on a click.
export const ciRunsNow = (): CiRunsResponse => feed.value.ci;

// What CI is doing right now, in the board's own words and split the board's own way: `queued` is never folded into
// `running`, or the rail would claim a runner had picked up work nobody has started. Undefined when nothing is moving,
// which is most of the day.
export const inFlightNote = (all: readonly PipelineRun[]): string | undefined => {
    const running = all.filter((run) => run.status === `running`).length;
    const queued = all.filter((run) => run.status === `queued`).length;
    const parts = [
        ...(running > 0 ? [t(`extension.running`, { count: running })] : []),
        ...(queued > 0 ? [t(`extension.queued`, { count: queued })] : []),
    ];
    return parts.length === 0 ? undefined : parts.join(`, `);
};

// One owed failure in the tile's words: where, then the move.
const owedLine = (item: Owed): string => {
    const move = item.kind === `push` && item.release ? t(`attention.releaseAgain`) : t(`attention.${item.kind}`);
    return t(`attention.line`, { repo: item.repo, branch: item.branch, move });
};

// THE TILE'S TWO READINGS, kept apart. What CI owes the reader is the count (attention.ts): a failure nobody is on, one
// handed back, a fix to review, answer, push, or a step outside the repository. It clears when that move is made or CI
// passes, never by opening the view. What needs nobody (a fix agent working, a run measuring) is the running mark, with
// CI's own runs in flight beside it.
export const attentionBadge = (feedNow: AttentionFeed, inProject: (repo: string) => boolean = () => true): ViewBadge | undefined => {
    const runs = feedNow.ci.runs.filter((run) => inProject(run.repo));
    const failures = feedNow.ci.failures?.filter((failure) => inProject(failure.repo));
    const { owed, handled } = ciAttention(runs, failures, feedNow.agents, feedNow.ci.ownerSteps);
    const moving = [inFlightNote(runs), handled === 0 ? undefined : t(`attention.beingFixed`, { count: handled })].filter((part) => part !== undefined);
    const running = moving.length === 0 ? undefined : moving.join(`, `);
    const [only] = owed;
    if (only === undefined) {
        // Nothing owed: the tile is here only because CI or a fix is working, and it stands down when that lands.
        return running === undefined ? undefined : { running };
    }
    const tooltip = owed.length === 1 ? owedLine(only) : t(`attention.many`, { count: owed.length }, owed.length);
    const badge: ViewBadge = { count: owed.length, tone: owedTone(owed), tooltip };
    return running === undefined ? badge : { ...badge, running };
};

// Touching the poll's state here is what repaints the tile. Scoped to the open project, as the board is: a tile counting
// a repository the board hides would send the reader to a board with nothing on it.
export const ciBadge = (): ViewBadge | undefined => attentionBadge(feed.value, (repo) => host().workspace.inProject(repo));
