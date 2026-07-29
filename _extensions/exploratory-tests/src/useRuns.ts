import {
    type AgentSummary,
    AgentsListSchema,
    StartedTurnSchema,
    WorkspaceChildrenSchema,
    WorkspaceFileSchema,
} from "@intentic/sandbox-contract";
import { useQuery, useQueryClient } from "@tanstack/vue-query";
import { computed, type Ref } from "vue";
import { briefFor } from "./brief";
import { host } from "./host";
import {
    conversationIdOf,
    parseResult,
    reportPath,
    resultPath,
    type RunManifest,
    runIdAt,
    runManifestOf,
    runManifestPath,
    RUNS_DIR,
    type StoryResult,
} from "./runs";
import type { Story } from "./stories";

/* Runs, and the fleet sessions that produce them.
 *
 * A test session is an ISOLATED fleet agent: `POST /agent` with a conversationId and `isolated: true` is what
 * creates one (agent.routes.ts registers a fleet entry for exactly that shape and no other). That is the whole
 * reason this extension owns no session machinery — the worktree, the live status, the cost, the transcript and
 * the /agents/<id> page all already exist, and a run is just N of them started at once with a derived id.
 *
 * `bypassPermissions` because a test that parks on a permission card is a test that never finishes: nobody is
 * watching a fan-out of ten. The blast radius is bounded the way the fleet bounds it — each session is in its
 * own worktree — and the brief's first paragraph is "you are a tester, do not modify the source".
 *
 * Status is JOINED, never stored: the conversation ids are derived from the run id, so `GET /agents` filtered by
 * prefix IS the run's live state. There is no bookkeeping here that can drift out of sync with the fleet. */

const POLL_MS = 3000;

export interface RunRow {
    readonly manifest: RunManifest;
    readonly agents: readonly AgentSummary[];
    readonly running: boolean;
}

export interface StoryOutcome {
    readonly result?: StoryResult;
    readonly report?: string;
}

export interface StartRunInput {
    readonly stories: readonly Story[];
    readonly contents: Readonly<Record<string, string>>;
    readonly baseUrl: string;
    readonly provider: string;
    readonly model?: string | undefined;
    readonly projectNotes?: string | undefined;
    // Injected so the module has no clock of its own — the tests pin it.
    readonly now?: number;
}

export function useRuns(repo: Ref<string>) {
    const api = host();
    const queryClient = useQueryClient();
    const runsKey = computed(() => api.sandbox.key(`exploratory`, `runs`, repo.value));

    const json = async <T>(path: string): Promise<T | undefined> => {
        try {
            return (await api.sandbox.json(path)) as T;
        } catch {
            return undefined;
        }
    };
    const file = async (path: string): Promise<string | undefined> => {
        const parsed = await json<unknown>(`/workspace/file?path=${encodeURIComponent(path)}`);
        return parsed === undefined ? undefined : WorkspaceFileSchema.parse(parsed).content;
    };

    const runsQuery = useQuery({
        queryKey: runsKey,
        enabled: computed(() => api.sandbox.reachable()),
        queryFn: async (): Promise<RunManifest[]> => {
            // No runs directory yet is the ordinary first state, not an error.
            const listing = await json<unknown>(`/workspace/children?path=${encodeURIComponent(RUNS_DIR)}`);
            if (listing === undefined) {
                return [];
            }
            const dirs = WorkspaceChildrenSchema.parse(listing).entries.filter((entry) => entry.type === `dir`);
            const manifests = await Promise.all(dirs.map(async (entry) => await file(`${entry.path}/run.json`)));
            return manifests
                .flatMap((text) => (text === undefined ? [] : [safeManifest(text)]))
                .flatMap((manifest) => (manifest === undefined || manifest.repo !== repo.value ? [] : [manifest]))
                .toSorted((left, right) => right.createdAt - left.createdAt);
        },
    });

    // The fleet roster, polled only while this repo's runs still have work in flight. `GET /agents` is the
    // whole fleet; the per-run join happens below.
    const conversationIds = computed(() => new Set((runsQuery.data.value ?? []).flatMap((run) => run.stories.map((story) => story.conversationId))));
    const agentsQuery = useQuery({
        queryKey: api.sandbox.key(`exploratory`, `agents`),
        enabled: computed(() => api.sandbox.reachable() && conversationIds.value.size > 0),
        queryFn: async (): Promise<AgentSummary[]> => AgentsListSchema.parse(await api.sandbox.json(`/agents`)).agents,
        refetchInterval: (state) =>
            (state.state.data ?? []).some((agent) => conversationIds.value.has(agent.id) && (agent.status === `running` || agent.status === `awaiting`))
                ? POLL_MS
                : false,
    });

    const agentsById = computed(() => new Map((agentsQuery.data.value ?? []).map((agent) => [agent.id, agent])));
    const runs = computed<RunRow[]>(() =>
        (runsQuery.data.value ?? []).map((manifest) => {
            const agents = manifest.stories.flatMap((story) => {
                const agent = agentsById.value.get(story.conversationId);
                return agent === undefined ? [] : [agent];
            });
            return { manifest, agents, running: agents.some((agent) => agent.status === `running` || agent.status === `awaiting`) };
        }),
    );

    /* One run's per-story artifacts. Separate from the run list on purpose: results and reports are only read
     * for the run being LOOKED at, so a workspace with fifty runs costs fifty reads to list and none to browse.
     * Re-read on the same interval as the roster while the run is live, so a report appears as it is written. */
    const useRunOutcomes = (runId: Ref<string | undefined>) =>
        useQuery({
            queryKey: computed(() => api.sandbox.key(`exploratory`, `outcomes`, runId.value ?? ``)),
            enabled: computed(() => api.sandbox.reachable() && runId.value !== undefined),
            refetchInterval: () => (runs.value.find((run) => run.manifest.runId === runId.value)?.running === true ? POLL_MS : false),
            queryFn: async (): Promise<Record<string, StoryOutcome>> => {
                const id = runId.value;
                const manifest = runsQuery.data.value?.find((run) => run.runId === id);
                if (id === undefined || manifest === undefined) {
                    return {};
                }
                const outcomes = await Promise.all(
                    manifest.stories.map(async (story) => {
                        const [result, report] = await Promise.all([file(resultPath(id, story.slug)), file(reportPath(id, story.slug))]);
                        const parsed = result === undefined ? undefined : parseResult(result);
                        return [story.slug, { ...(parsed === undefined ? {} : { result: parsed }), ...(report === undefined ? {} : { report }) }] as const;
                    }),
                );
                return Object.fromEntries(outcomes);
            },
        });

    /* Start a run: write the manifest FIRST, then fan out the turns.
     *
     * Order matters. The manifest is what makes a run discoverable — if a turn started before it existed and the
     * browser closed in between, there would be a fleet agent with a derived id and nothing on disk saying which
     * stories it belonged to. A manifest with no turns behind it is the recoverable failure; the reverse is not. */
    const start = async (input: StartRunInput): Promise<string> => {
        const runId = runIdAt(input.now ?? Date.now());
        const manifest = runManifestOf({
            runId,
            repo: repo.value,
            createdAt: input.now ?? Date.now(),
            baseUrl: input.baseUrl,
            provider: input.provider,
            model: input.model,
            stories: input.stories,
        });
        await api.sandbox.request(`/workspace/upload?path=${encodeURIComponent(runManifestPath(runId))}`, {
            method: `POST`,
            body: JSON.stringify(manifest, null, 2),
        });
        // Fired together rather than in sequence: the fleet runs them in parallel anyway, and awaiting each ack
        // in turn would make the last story's card appear seconds after the first's for no reason.
        await Promise.all(
            input.stories.map(async (story) => {
                const brief = briefFor({
                    story,
                    content: input.contents[story.path] ?? ``,
                    runId,
                    repo: repo.value,
                    baseUrl: input.baseUrl,
                    projectNotes: input.projectNotes,
                });
                const body = {
                    prompt: brief,
                    title: `Test: ${story.title}`.slice(0, 80),
                    conversationId: conversationIdOf(runId, story.slug),
                    isolated: true,
                    permissionMode: `bypassPermissions`,
                    agent: input.provider,
                    ...(input.model === undefined || input.model === `` ? {} : { model: input.model }),
                };
                StartedTurnSchema.parse(
                    await api.sandbox.json(`/agent`, { method: `POST`, headers: { "content-type": `application/json` }, body: JSON.stringify(body) }),
                );
            }),
        );
        await queryClient.invalidateQueries({ queryKey: runsKey.value });
        return runId;
    };

    const stop = async (conversationId: string): Promise<void> => {
        await api.sandbox.json(`/agent/stop`, {
            method: `POST`,
            headers: { "content-type": `application/json` },
            body: JSON.stringify({ conversationId }),
        });
        await queryClient.invalidateQueries({ queryKey: api.sandbox.key(`exploratory`, `agents`) });
    };

    return {
        runs,
        error: computed(() => runsQuery.error.value?.message),
        isLoading: runsQuery.isLoading,
        refresh: async (): Promise<void> => {
            await queryClient.invalidateQueries({ queryKey: runsKey.value });
        },
        start,
        stop,
        useRunOutcomes,
    };
}

// A run.json written by an older version of this extension (or half-written) is skipped, not thrown on: one bad
// directory must not blank the whole runs list.
const safeManifest = (text: string): RunManifest | undefined => {
    try {
        const parsed: unknown = JSON.parse(text);
        if (typeof parsed !== `object` || parsed === null) {
            return undefined;
        }
        const manifest = parsed as Partial<RunManifest>;
        return typeof manifest.runId === `string` && typeof manifest.repo === `string` && Array.isArray(manifest.stories)
            ? { createdAt: 0, baseUrl: ``, provider: `claude`, ...manifest, runId: manifest.runId, repo: manifest.repo, stories: manifest.stories }
            : undefined;
    } catch {
        return undefined;
    }
};
