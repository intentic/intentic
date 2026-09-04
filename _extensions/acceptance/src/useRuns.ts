import { errorMessage } from "@intentic/base/errors";
import { type AgentSummary, AgentsListSchema, StartedTurnSchema, BrowsersListSchema, WorkspaceChildrenSchema } from "@intentic/sandbox-contract";
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

/* Runs, and the fleet sessions that produce them.
 *
 * A test session is an ISOLATED fleet agent: `POST /agent` with a conversationId and `isolated: true` is what
 * creates one (agent.routes.ts registers a fleet entry for exactly that shape and no other). That is the whole
 * reason this extension owns no session machinery, the worktree, the live status, the cost, the transcript and
 * the /agents/<id> page all already exist, and a run is just N of them started at once with a derived id.
 *
 * `bypassPermissions` because a test that parks on a permission card is a test that never finishes: nobody is
 * watching a fan-out of ten. The scope is bounded the way the fleet bounds it (each session is in its
 * own worktree) and the brief's first paragraph is "you are a tester, do not modify the source".
 *
 * Live status is JOINED, never stored: the conversation ids are derived from the run id, so `GET /agents`
 * filtered by prefix IS the state of every registered session. A refusal before registration is the one fact
 * the fleet cannot carry, so the manifest keeps it until Retry succeeds. The same roster join reaches one step
 * further for the live BROWSER, see `browsers` below. */

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

// A persisted refusal means "not started" only while the fleet has no session. This one rule also covers the
// narrow success-before-manifest-write window of Retry: the live session is the stronger fact.
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

// The live Chromium one test session is driving, when there is one to watch.
export interface LiveBrowser {
    // The tmux-listed session name, what `api.terminal.open` is handed.
    readonly session: string;
    // The page it is on right now, straight off the daemon's listing.
    readonly url?: string | undefined;
}

export interface StartRunInput {
    readonly stories: readonly Story[];
    // The app under test per story GROUP, keyed by stories.ts targetKeyOf, so a repo serving a marketing site
    // and a web app points each of their groups at its own server.
    readonly targets: Readonly<Record<string, string>>;
    // Each repo's docs/user-stories/.acceptance.md, keyed by repo name.
    readonly notes: Readonly<Record<string, string>>;
    // The pair the header's chip resolved, the host names both, because a model id is only meaningful under the
    // provider that vends it. An empty model is a real answer (an ACP agent owns its own): the daemon then falls
    // to the provider's catalog default, exactly as an unpinned composer turn does.
    readonly provider: string;
    readonly model: string;
    // And the tier that model thinks at, where the reader chose one. Absent ⇒ the model's own default.
    readonly effort?: string | undefined;
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

    // The fleet roster, polled only while some run still has work in flight. `GET /agents` is the whole fleet;
    // the per-run join happens below.
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

    /* THE SUPERVISION SEAM. A test session drives a real Chromium that the daemon already attaches to over CDP
     * and streams into the Browsers area, with a tab per page and a Take control button. Nothing had to be
     * built here for that; what was missing was the pointer.
     *
     * The join is two hops and neither may be guessed: the fleet roster gives a conversation's `sessionId`, and
     * `browserSessionName` (the contract's, shared with the daemon that NAMES the session) turns that into the
     * listed name. It is checked against the live listing rather than derived and offered blind, a browser
     * session exists only once the agent has made its first browser call, and a button that opens an empty view
     * teaches the user the feature is broken.
     *
     * Polled only while a run is live: a finished run's Chromium is gone, and this is the third request in a
     * three-request view. */
    const browsersQuery = useQuery({
        queryKey: computed(() => api.sandbox.key(`acceptance`, `browsers`)),
        enabled: computed(() => api.sandbox.reachable() && live.value),
        refetchInterval: () => (live.value ? POLL_MS : false),
        queryFn: async (): Promise<Readonly<Record<string, string | undefined>>> =>
            Object.fromEntries(
                BrowsersListSchema.parse(await api.sandbox.json(`/system/browsers`))
                    .sessions.filter((session) => session.running)
                    // The page the agent is on right now, the same one its view opens onto.
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

    /* WHAT EVERY RECENT RUN FOUND, the verdict of each story of the newest SCAN_RUNS runs, and nothing else.
     *
     * The list needs this, and so does every story row: "3 stories, 2 hours ago" does not say whether anything is
     * broken, and a stories list that cannot show where each promise currently stands is a list of intentions.
     * Reading only the verdict (not the report, not the steps) is what makes that affordable, one small file per
     * story, and the SCAN_RUNS bound is the same one the rail badge scans under, so the tile and the list can
     * never disagree. Runs older than that carry no verdict here until one is opened, which is a read of exactly
     * the run someone is looking at. */
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
                        // The run's own key exists even when every story is still walking: "scanned, nothing
                        // written yet" and "too old to have been read" are different answers to the list.
                        return [
                            run.runId,
                            Object.fromEntries(results.flatMap(([slug, verdict]) => (verdict === undefined ? [] : [[slug, verdict] as const]))),
                        ] as const;
                    }),
                ),
            ),
    });

    /* One run's per-story artifacts. Separate from the run list on purpose: results and reports are only read
     * for the run being LOOKED at, so a workspace with fifty runs costs fifty reads to list and none to browse.
     * Re-read on the same interval as the roster while the run is live, so a report appears as it is written. */
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

    /* Start a run: write the manifest FIRST, then fan out the turns.
     *
     * Order matters. The manifest is what makes a run discoverable, if a turn started before it existed and the
     * browser closed in between, there would be a fleet agent with a derived id and nothing on disk saying which
     * stories it belonged to. A manifest with no turns behind it is the recoverable failure; the reverse is not. */
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
            // Unattended like every surface-started run, but this one keeps a picker, because a run
            // fans a whole session out PER STORY and the tier is therefore a per-run decision about
            // spend. An explicit model wins over the setting; an empty one lets it answer.
            unattended: true,
            agent: manifest.provider,
            ...(manifest.model === undefined ? {} : { model: manifest.model }),
            ...(manifest.effort === undefined ? {} : { effort: manifest.effort }),
        };
        StartedTurnSchema.parse(
            await api.sandbox.json(`/agent`, { method: `POST`, headers: { "content-type": `application/json` }, body: JSON.stringify(body) }),
        );
    };

    const start = async (input: StartRunInput): Promise<string> => {
        const createdAt = Date.now();
        const runId = runIdAt(createdAt);
        // The list prefetch is deliberately bounded, but a run is not: every selected file is read HERE, at the
        // point-in-time the run records. Missing text refuses before a manifest or any paid turn is created.
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
            provider: input.provider,
            model: input.model,
            effort: input.effort,
            stories: snapshots,
        });
        await api.workspace.write(runManifestPath(runId), JSON.stringify(manifest, null, 2));
        // Fired together rather than in sequence: the fleet runs them in parallel anyway, and awaiting each ack
        // in turn would make the last story's card appear seconds after the first's for no reason. The manifest's
        // own story entries are what the turns are built from, so the conversation id on disk is the one started.
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
            // This catch ends with the provider call. If clearing the manifest fails after the launch was
            // acknowledged, that storage error must not be rewritten as though the provider refused a session.
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
        // Keyed by conversationId, the row asks `browsers[story.conversationId]` and shows a Watch button when
        // there is something to watch.
        browsers,
        // runId → slug → verdict, for the newest SCAN_RUNS runs. A runId that is absent was never read; a runId
        // present with no entry for a slug has no result written yet.
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
