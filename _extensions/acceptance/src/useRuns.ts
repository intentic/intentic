import { errorMessage } from "@intentic/base/errors";
import {
    type AgentRunPick,
    type AgentSummary,
    AgentsListSchema,
    StartedTurnSchema,
    BrowsersListSchema,
    WorkspaceChildrenSchema,
} from "@intentic/sandbox-contract";
import { browserSessionName } from "@intentic/sandbox-contract/session-names";
import { useQuery, useQueryClient } from "@tanstack/vue-query";
import { computed, type Ref } from "vue";
import { briefFor } from "./brief";
import { host } from "./host";
import {
    parseManifest,
    parseResult,
    reportPath,
    resultPath,
    type RunManifest,
    runIdAt,
    runManifestOf,
    runManifestPath,
    RUNS_DIR,
    SCAN_RUNS,
    type StoryResult,
    type Verdict,
} from "./runs";
import { criteriaOf, type Story, targetKeyOf, titleOf } from "./stories";

// A test session is an isolated fleet agent (POST /agent, a derived conversationId, isolated:true); this extension owns
// no session machinery, since the fleet's worktree, status, cost and transcript already exist. `bypassPermissions`,
// since an unattended fan-out can't answer a permission card. Live status joins GET /agents by conversation id prefix,
// never stored.

const POLL_MS = 3000;

const launchError = (reason: unknown): string => {
    const message = errorMessage(reason);
    return message === `` ? `The session could not be started.` : message;
};

export interface RunRow {
    readonly manifest: RunManifest;
    readonly agents: readonly AgentSummary[];
    readonly running: boolean;
}

// A persisted refusal means "not started" only while the fleet has no matching session; this also covers Retry's narrow
// success-before-write window, since a live session is the stronger fact.
export const launchFailureOf = (run: Pick<RunRow, "manifest" | "agents">, slug: string): string | undefined => {
    const failure = run.manifest.launchFailures[slug];
    if (failure === undefined) {
        return undefined;
    }
    const conversationId = run.manifest.stories.find((story) => story.slug === slug)?.conversationId;
    return run.agents.some((agent) => agent.id === conversationId) ? undefined : failure;
};

export interface StoryOutcome {
    readonly result?: StoryResult;
    readonly report?: string;
    readonly invalidResult?: boolean;
}

// The live Chromium a test session is driving, when there is one to watch.
export interface LiveBrowser {
    // The tmux-listed session name, what api.terminal.open is handed.
    readonly session: string;
    // The page it's on right now, straight off the daemon's listing.
    readonly url?: string | undefined;
}

export interface StartRunInput {
    readonly stories: readonly Story[];
    // The app under test per story group (targetKeyOf), so a repo serving several apps points each group at its own
    // server.
    readonly targets: Readonly<Record<string, string>>;
    // Each repo's docs/user-stories/.acceptance.md, keyed by repo name.
    readonly notes: Readonly<Record<string, string>>;
    // What every session opens on, as the run button resolved it: the pair, and the account, harness, tier,
    // thinking and speed configured with it. Recorded on the manifest, so Retry launches the same run.
    readonly pick: NonNullable<AgentRunPick>;
}

export function useRuns() {
    const api = host();
    const queryClient = useQueryClient();
    const runsKey = computed(() => api.sandbox.key(`acceptance`, `runs`));
    const agentsKey = computed(() => api.sandbox.key(`acceptance`, `agents`));

    const runsQuery = useQuery({
        queryKey: runsKey,
        enabled: computed(() => api.sandbox.reachable()),
        queryFn: async (): Promise<RunManifest[]> => {
            // No runs directory yet is the ordinary first state, not an error.
            const listing = await api.sandbox.json(`/workspace/children?path=${encodeURIComponent(RUNS_DIR)}`);
            const dirs = WorkspaceChildrenSchema.parse(listing).entries.filter((entry) => entry.type === `dir`);
            const manifests = await Promise.all(dirs.map(async (entry) => await api.workspace.file(`${entry.path}/run.json`)));
            return manifests
                .flatMap((text) => (text === undefined ? [] : [parseManifest(text)]))
                .flatMap((manifest) => (manifest === undefined ? [] : [manifest]))
                .toSorted((left, right) => right.createdAt - left.createdAt);
        },
    });

    // The fleet roster, polled only while some run has work in flight; GET /agents is the whole fleet, the per-run join
    // happens below.
    const conversationIds = computed(() => new Set((runsQuery.data.value ?? []).flatMap((run) => run.stories.map((story) => story.conversationId))));
    const agentsQuery = useQuery({
        queryKey: agentsKey,
        enabled: computed(() => api.sandbox.reachable() && conversationIds.value.size > 0),
        queryFn: async (): Promise<AgentSummary[]> => AgentsListSchema.parse(await api.sandbox.json(`/agents`)).agents,
        refetchInterval: (state) =>
            (state.state.data ?? []).some(
                (agent) => conversationIds.value.has(agent.id) && (agent.status === `running` || agent.status === `awaiting`),
            )
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

    const live = computed<boolean>(() => runs.value.some((run) => run.running));

    // The supervision seam: a session's Chromium already streams into the Browsers area over CDP. The join (roster to
    // sessionId to browserSessionName to live listing) is checked against the listing, not derived blind, since a
    // session exists only after the first browser call.
    const browsersQuery = useQuery({
        queryKey: computed(() => api.sandbox.key(`acceptance`, `browsers`)),
        enabled: computed(() => api.sandbox.reachable() && live.value),
        refetchInterval: () => (live.value ? POLL_MS : false),
        queryFn: async (): Promise<Readonly<Record<string, string | undefined>>> =>
            Object.fromEntries(
                BrowsersListSchema.parse(await api.sandbox.json(`/system/browsers`))
                    .sessions.filter((session) => session.running)
                    // The page the agent is on right now, the same one its own view opens onto.
                    .map((session) => [session.name, session.pages.find((page) => page.active)?.url] as const),
            ),
    });

    const browsers = computed<Readonly<Record<string, LiveBrowser>>>(() => {
        const listed = browsersQuery.data.value ?? {};
        return Object.fromEntries(
            (agentsQuery.data.value ?? []).flatMap((agent) => {
                const session = agent.sessionId === undefined ? undefined : browserSessionName(agent.sessionId);
                return session === undefined || !(session in listed) ? [] : [[agent.id, { session, url: listed[session] }] as const];
            }),
        );
    });

    // Verdicts only (not the report or steps) for the newest SCAN_RUNS runs, the same bound the rail badge scans under,
    // so the tile and the list can never disagree. A run past that bound shows no verdict here until it's opened.
    const scanned = computed<readonly RunManifest[]>(() => (runsQuery.data.value ?? []).slice(0, SCAN_RUNS));
    const verdictsQuery = useQuery({
        queryKey: computed(() => api.sandbox.key(`acceptance`, `verdicts`, scanned.value.map((run) => run.runId).join(`,`))),
        enabled: computed(() => api.sandbox.reachable() && scanned.value.length > 0),
        refetchInterval: () => (live.value ? POLL_MS : false),
        queryFn: async (): Promise<Record<string, Record<string, Verdict>>> =>
            Object.fromEntries(
                await Promise.all(
                    scanned.value.map(async (run) => {
                        const results = await Promise.all(
                            run.stories.map(
                                async (story) =>
                                    [
                                        story.slug,
                                        parseResult((await api.workspace.file(resultPath(run.runId, story.slug))) ?? ``, story)?.verdict,
                                    ] as const,
                            ),
                        );
                        // The run's own key exists even with no results yet, so "nothing written" and "too old to read"
                        // stay distinct answers.
                        return [
                            run.runId,
                            Object.fromEntries(results.flatMap(([slug, verdict]) => (verdict === undefined ? [] : [[slug, verdict] as const]))),
                        ] as const;
                    }),
                ),
            ),
    });

    // One run's artifacts, read only for the run being looked at, so a workspace with fifty runs costs nothing to
    // browse until one is opened; re-read on the same interval as the roster while live.
    const useRunOutcomes = (runId: Ref<string | undefined>) =>
        useQuery({
            queryKey: computed(() => api.sandbox.key(`acceptance`, `outcomes`, runId.value ?? ``)),
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
                        const [result, report] = await Promise.all([
                            api.workspace.file(resultPath(id, story.slug)),
                            api.workspace.file(reportPath(id, story.slug)),
                        ]);
                        const parsed = result === undefined ? undefined : parseResult(result, story);
                        return [
                            story.slug,
                            {
                                ...(parsed === undefined ? {} : { result: parsed }),
                                ...(result !== undefined && parsed === undefined ? { invalidResult: true } : {}),
                                ...(report === undefined ? {} : { report }),
                            },
                        ] as const;
                    }),
                );
                return Object.fromEntries(outcomes);
            },
        });

    // Writes the manifest before fanning out turns: a turn started with nothing on disk describing it is unrecoverable,
    // while a manifest with no turns behind it just needs a retry.
    const launch = async (manifest: RunManifest, story: RunManifest["stories"][number]): Promise<void> => {
        const brief = briefFor({
            story,
            runId: manifest.runId,
            baseUrl: manifest.targets[targetKeyOf(story)] ?? ``,
            projectNotes: manifest.notes[story.repo],
        });
        const body = {
            prompt: brief,
            title: `Acceptance: ${story.title}`.slice(0, 80),
            conversationId: story.conversationId,
            isolated: true,
            permissionMode: `bypassPermissions`,
            // Unattended like every surface-started run, but the tier is a per-run spend decision here, since one run
            // fans a session out per story.
            unattended: true,
            // Which of the owner's model lists pays for it (Sandbox / Agent / Models).
            runRole: `acceptance-run`,
            // Spread verbatim: the pick's fields ARE the turn's (contract AgentRunPickSchema).
            ...manifest.pick,
        };
        StartedTurnSchema.parse(
            await api.sandbox.json(`/agent`, { method: `POST`, headers: { "content-type": `application/json` }, body: JSON.stringify(body) }),
        );
    };

    const start = async (input: StartRunInput): Promise<string> => {
        const createdAt = Date.now();
        const runId = runIdAt(createdAt);
        // Every selected story is read here, at the run's own point in time, unlike the list's bounded prefetch;
        // missing text refuses before any turn is created.
        const snapshots = await Promise.all(
            input.stories.map(async (story) => {
                const content = await api.workspace.file(story.path);
                if (content === undefined) {
                    throw new Error(`Could not read ${story.path}; no acceptance sessions were started.`);
                }
                return { ...story, title: titleOf(story.path, content), content, criteria: criteriaOf(content) };
            }),
        );
        const manifest = runManifestOf({
            runId,
            createdAt,
            targets: input.targets,
            notes: input.notes,
            pick: input.pick,
            stories: snapshots,
        });
        await api.workspace.write(runManifestPath(runId), JSON.stringify(manifest, null, 2));
        // Fired together, not in sequence, since the fleet runs them in parallel anyway and sequential awaits would
        // stagger the cards for no reason.
        const launched = await Promise.allSettled(manifest.stories.map(async (story) => await launch(manifest, story)));
        const launchFailures = Object.fromEntries(
            launched.flatMap((result, index) =>
                result.status === `fulfilled` ? [] : [[manifest.stories[index]?.slug ?? `unknown`, launchError(result.reason)] as const],
            ),
        );
        if (Object.keys(launchFailures).length > 0) {
            await api.workspace.write(runManifestPath(runId), JSON.stringify({ ...manifest, launchFailures }, null, 2));
        }
        await Promise.all([queryClient.invalidateQueries({ queryKey: runsKey.value }), queryClient.invalidateQueries({ queryKey: agentsKey.value })]);
        return runId;
    };

    const retry = async (runId: string, slug: string): Promise<void> => {
        const manifest = runsQuery.data.value?.find((run) => run.runId === runId);
        const story = manifest?.stories.find((entry) => entry.slug === slug);
        if (manifest === undefined || story === undefined || manifest.launchFailures[slug] === undefined) {
            return;
        }
        try {
            // Scoped to the provider call alone, so a storage failure after a successful launch isn't rewritten as a
            // refused session.
            try {
                await launch(manifest, story);
            } catch (error) {
                await api.workspace.write(
                    runManifestPath(runId),
                    JSON.stringify({ ...manifest, launchFailures: { ...manifest.launchFailures, [slug]: launchError(error) } }, null, 2),
                );
                throw error;
            }
            const launchFailures = Object.fromEntries(Object.entries(manifest.launchFailures).filter(([failed]) => failed !== slug));
            await api.workspace.write(runManifestPath(runId), JSON.stringify({ ...manifest, launchFailures }, null, 2));
        } finally {
            await Promise.all([
                queryClient.invalidateQueries({ queryKey: runsKey.value }),
                queryClient.invalidateQueries({ queryKey: agentsKey.value }),
            ]);
        }
    };

    const stop = async (conversationId: string): Promise<void> => {
        await api.sandbox.json(`/agent/stop`, {
            method: `POST`,
            headers: { "content-type": `application/json` },
            body: JSON.stringify({ conversationId }),
        });
        await queryClient.invalidateQueries({ queryKey: agentsKey.value });
    };

    return {
        runs,
        // Keyed by conversationId; a row checks `browsers[story.conversationId]` to show its Watch button.
        browsers,
        // runId -> slug -> verdict for the newest SCAN_RUNS runs; an absent runId was never read, a present one with no
        // slug entry has no result yet.
        verdicts: computed<Readonly<Record<string, Readonly<Record<string, Verdict>>>>>(() => verdictsQuery.data.value ?? {}),
        error: computed(
            () =>
                runsQuery.error.value?.message ??
                agentsQuery.error.value?.message ??
                browsersQuery.error.value?.message ??
                verdictsQuery.error.value?.message,
        ),
        isLoading: runsQuery.isLoading,
        refresh: async (): Promise<void> => {
            await queryClient.invalidateQueries({ queryKey: runsKey.value });
        },
        start,
        retry,
        stop,
        useRunOutcomes,
    };
}
