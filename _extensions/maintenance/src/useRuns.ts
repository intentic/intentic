import type { ChoreVerdict } from "@intentic/sandbox-contract/chores";
import { type AgentSummary, AgentsListSchema, runPickOf, StartedTurnSchema } from "@intentic/sandbox-contract";
import type { AgentRunChoice } from "@intentic/extension-ui";
import { useQuery, useQueryClient } from "@tanstack/vue-query";
import { computed } from "vue";
import { choresRunsQuery } from "./choresQuery";
import { host } from "./host";
import { ANY_RUN_PREFIX, conversationIdOf, reportingClause, type RunManifest, type RunResult, runIdAt, runManifestPath } from "./runs";

// Chore runs are isolated fleet agents (`POST /agent`, isolated: true), so this extension owns no session machinery;
// the worktree, status, cost and transcript already exist. Isolation here is a safety measure: an acting chore edits
// source unattended. Permissions are never bypassed.

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

    // Manifests and results together, newest first, in one pass; a second query to learn a run finished is what makes a
    // list flicker. Read lives in choresQuery, shared with the host's read-ahead.
    const runsQuery = useQuery({
        queryKey: runsKey,
        enabled: computed(() => api.sandbox.reachable()),
        queryFn: () => choresRunsQuery().queryFn(),
    });

    // Fleet roster, polled only while a run has work in flight; `GET /agents` returns everything, joined per run by
    // conversation id.
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

    // Newest run per repo + chore: what a row shows as 'last run', the only one that is ever current.
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

    // Turns a finished run into a ledger row; idempotent by run id, one comparison per run. The agent only writes a
    // file, so promotion works from a closed browser too; `ranAt` is the run's creation time, not now.
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

    // Writes the manifest before starting the turn: a turn with no manifest (browser closed mid-request) is an
    // untraceable fleet agent, the unrecoverable failure the wrong order risks.
    const start = async (verdict: ChoreVerdict, pick?: AgentRunChoice | undefined): Promise<string> => {
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
                    title: `${verdict.chore.title}, ${verdict.repo}`.slice(0, 80),
                    conversationId: manifest.conversationId,
                    isolated: true,
                    // Always true: a chore turn has no person at a composer, whether or not the model was overridden.
                    unattended: true,
                    // Which of the owner's model lists pays for it (Sandbox ▸ Agent ▸ Models).
                    runRole: `maintenance-chore`,
                    ...(pick === undefined ? {} : runPickOf(pick)),
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
