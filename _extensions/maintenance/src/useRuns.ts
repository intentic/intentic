import type { ChoreVerdict } from "@intentic/sandbox-contract/chores";
import { type AgentSummary, AgentsListSchema, StartedTurnSchema, WorkspaceChildrenSchema } from "@intentic/sandbox-contract";
import { useQuery, useQueryClient } from "@tanstack/vue-query";
import { computed } from "vue";
import { host } from "./host";
import {
    ANY_RUN_PREFIX,
    conversationIdOf,
    parseManifest,
    parseResult,
    reportingClause,
    resultPath,
    type RunManifest,
    type RunResult,
    runIdAt,
    runManifestPath,
    RUNS_DIR,
    SCAN_RUNS,
} from "./runs";

/* CHORE RUNS — starting them, watching them, and promoting the finished ones into the ledger.
 *
 * A chore run is an ISOLATED fleet agent: `POST /agent` with a conversationId and `isolated: true` is the shape
 * (and the only shape) that registers a fleet entry, which is why this extension owns no session machinery. The
 * worktree, the live status, the cost, the transcript and the /agents/<id> page all already exist.
 *
 * Isolation here is for SAFETY as well as for the registry entry, unlike the documentation extension's runs: an
 * acting chore edits source, unattended, against a plan nobody reviewed first. Its work landing on a branch the
 * owner reads and lands deliberately is the entire safety story, and it is the reason this surface can offer to
 * upgrade your dependencies at all.
 *
 * Permissions are NOT bypassed, also unlike acceptance's. A test that parks on a permission card is a test that
 * never finishes, so that surface trades the prompt away; a chore is different in kind — nobody is waiting on it,
 * it is allowed to take until tomorrow, and a maintenance sweep that can answer its own permission prompts is
 * exactly the thing an owner would want to have been asked about. */

const POLL_MS = 4000;

export interface ChoreRun {
    readonly manifest: RunManifest;
    readonly agent: AgentSummary | undefined;
    readonly result: RunResult | undefined;
    readonly running: boolean;
}

export function useRuns() {
    const api = host();
    const queryClient = useQueryClient();
    const runsKey = computed(() => api.sandbox.key(`maintenance-runs`));
    const agentsKey = computed(() => api.sandbox.key(`maintenance-runs`, `agents`));

    const json = async <T>(path: string): Promise<T | undefined> => {
        try {
            return (await api.sandbox.json(path)) as T;
        } catch {
            return undefined;
        }
    };

    // The manifests and whatever results exist beside them, newest first. Both files are read in the same pass:
    // a run's result is a few hundred bytes, the walk is capped at SCAN_RUNS, and needing a second query to know
    // whether a run finished is what makes a history list flicker.
    const runsQuery = useQuery({
        queryKey: runsKey,
        enabled: computed(() => api.sandbox.reachable()),
        queryFn: async (): Promise<{ manifest: RunManifest; result: RunResult | undefined }[]> => {
            // No runs directory yet is the ordinary first state, not an error.
            const listing = await json<unknown>(`/workspace/children?path=${encodeURIComponent(RUNS_DIR)}`);
            if (listing === undefined) {
                return [];
            }
            const dirs = WorkspaceChildrenSchema.parse(listing)
                .entries.filter((entry) => entry.type === `dir`)
                // Run ids sort by their base-36 timestamp, so newest-first is a reverse lexical sort — no manifest
                // read needed to decide which SCAN_RUNS to read at all.
                .toSorted((left, right) => right.path.localeCompare(left.path))
                .slice(0, SCAN_RUNS);
            const runs = await Promise.all(
                dirs.map(async (entry) => {
                    const text = await api.workspace.file(`${entry.path}/run.json`);
                    const manifest = text === undefined ? undefined : parseManifest(text);
                    if (manifest === undefined) {
                        return undefined;
                    }
                    const resultText = await api.workspace.file(resultPath(manifest.runId));
                    return { manifest, result: resultText === undefined ? undefined : parseResult(resultText) };
                }),
            );
            return runs
                .flatMap((run) => (run === undefined ? [] : [run]))
                .toSorted((left, right) => right.manifest.createdAt - left.manifest.createdAt);
        },
    });

    // The fleet roster, polled only while some run still has work in flight. `GET /agents` is the whole fleet; the
    // per-run join is a lookup by the derived conversation id below.
    const agentsQuery = useQuery({
        queryKey: agentsKey,
        enabled: computed(() => api.sandbox.reachable() && (runsQuery.data.value ?? []).length > 0),
        queryFn: async (): Promise<AgentSummary[]> =>
            AgentsListSchema.parse(await api.sandbox.json(`/agents`)).agents.filter((agent) => agent.id.startsWith(ANY_RUN_PREFIX)),
        refetchInterval: (state) =>
            (state.state.data ?? []).some((agent) => agent.status === `running` || agent.status === `awaiting`) ? POLL_MS : false,
    });

    const agentsById = computed(() => new Map((agentsQuery.data.value ?? []).map((agent) => [agent.id, agent])));

    const runs = computed<ChoreRun[]>(() =>
        (runsQuery.data.value ?? []).map(({ manifest, result }) => {
            const agent = agentsById.value.get(manifest.conversationId);
            return { manifest, agent, result, running: agent?.status === `running` || agent?.status === `awaiting` };
        }),
    );

    // The newest run per repo + chore — what a chore row shows as "last run", and the only one of a chore's runs
    // that is ever the current answer.
    const latestByChore = computed(() => {
        const latest = new Map<string, ChoreRun>();
        for (const run of runs.value) {
            const key = `${run.manifest.repo}|${run.manifest.chore}`;
            if (!latest.has(key)) {
                latest.set(key, run);
            }
        }
        return latest;
    });

    /* PROMOTION — a finished run becomes a ledger row. Runs on every settle of the runs query, and is idempotent:
     * a run whose ledger row already carries its id is skipped, so re-running this costs one comparison per run.
     *
     * The alternative — having the agent post the ledger row itself — would mean handing a turn a daemon token
     * and a client it needs for nothing else. This way the agent writes one JSON file, which is a thing every
     * agent can already do, and a browser that was closed when the turn finished picks the run up the next time
     * it opens. Nothing is lost by not being watched.
     *
     * `ranAt` is the run's CREATION time rather than now: it is the moment the evidence was looked at, and a
     * survey's "surveyed 10 days ago" would otherwise reset every time an old run was promoted. */
    const promote = async (ledgerRunIds: ReadonlySet<string>): Promise<void> => {
        const pending = runs.value.filter((run) => run.result !== undefined && !run.running && !ledgerRunIds.has(run.manifest.runId));
        if (pending.length === 0) {
            return;
        }
        await Promise.all(
            pending.map(async (run) =>
                api.sandbox.json(`/chores/ledger`, {
                    method: `POST`,
                    headers: { "content-type": `application/json` },
                    body: JSON.stringify({
                        repo: run.manifest.repo,
                        chore: run.manifest.chore,
                        ranAt: run.manifest.createdAt,
                        runId: run.manifest.runId,
                        outcome: run.result?.outcome,
                        digest: run.manifest.digest,
                    }),
                }),
            ),
        );
        await queryClient.invalidateQueries({ queryKey: api.sandbox.key(`maintenance-report`) });
    };

    /* Start a chore: write the manifest FIRST, then the turn.
     *
     * Order matters, and it is the same reason acceptance writes its manifest first. The manifest is what makes a
     * run discoverable — if the turn started before it existed and the browser closed in between, there would be
     * a fleet agent with a derived id and nothing on disk saying which chore it belonged to. A manifest with no
     * turn behind it is the recoverable failure; the reverse is not. */
    const start = async (verdict: ChoreVerdict): Promise<string> => {
        if (verdict.prompt === undefined) {
            throw new Error(`ext-maintenance: ${verdict.chore.id} has nothing to do`);
        }
        const createdAt = Date.now();
        const runId = runIdAt(createdAt);
        const manifest: RunManifest = {
            runId,
            createdAt,
            repo: verdict.repo,
            chore: verdict.chore.id,
            digest: verdict.digest,
            conversationId: conversationIdOf(runId),
            headline: verdict.headline,
        };
        await api.workspace.write(runManifestPath(runId), JSON.stringify(manifest, null, 2));
        StartedTurnSchema.parse(
            await api.sandbox.json(`/agent`, {
                method: `POST`,
                headers: { "content-type": `application/json` },
                body: JSON.stringify({
                    prompt: `${verdict.prompt}\n\n${reportingClause(runId)}`,
                    title: `${verdict.chore.title} — ${verdict.repo}`.slice(0, 80),
                    conversationId: manifest.conversationId,
                    isolated: true,
                }),
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
        await queryClient.invalidateQueries({ queryKey: agentsKey.value });
    };

    return {
        runs,
        latestByChore,
        error: computed(() => runsQuery.error.value?.message),
        isLoading: runsQuery.isLoading,
        start,
        stop,
        promote,
    };
}
