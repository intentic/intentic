import { useQuery, useQueryClient } from "@tanstack/vue-query";
import { type AgentRunPick, AgentRunPickSchema, type AgentSummary, AgentsListSchema, WorkspaceChildrenSchema } from "@intentic/sandbox-contract";
import { computed, type ComputedRef, type Ref } from "vue";
import { mapBrief, packageBrief } from "./brief.js";
import { componentOfPackage, parseRepoDoc, type RepoDoc } from "./docModel.js";
import { host } from "./host.js";
import {
    ANY_RUN_PREFIX,
    conversationIdOf,
    mapConversationId,
    REPO_DOC_TAIL,
    RUNS_DIR,
    runIdAt,
    runManifestPath,
    runPrefix,
    SCAN_RUNS,
    slugOf,
    stagingPath,
} from "./paths.js";
import { documentedDirs, listStagedTails } from "./stagedTree.js";

// Each package gets an isolated fleet agent; the map runs first, since component grouping and vocabulary are
// cross-package judgements no single agent can make. advance() is idempotent: it starts an agent only when neither a
// fleet entry nor a staged document exists for it, so a closed browser or an archived agent never duplicates or stalls
// work.

const POLL_MS = 4000;

const isLive = (agent: AgentSummary): boolean => agent.status === `running` || agent.status === `awaiting`;

export interface RunManifest {
    readonly runId: string;
    readonly createdAt: number;
    readonly repo: string;
    // Packages in scope, or absent for whatever the map finds; a later run can narrow once an index exists.
    readonly packages?: readonly string[];
    /* The model every session in this run opens on, when the reader used the caret beside Generate. Absent ⇒
     * the sandbox's agent-run list answers, which is the ordinary path.
     *
     * ON THE MANIFEST rather than held in the view, because a run OUTLIVES the press that started it: only the
     * map agent starts immediately, and the fan-out is started later by `advance()`, on a later poll, quite
     * possibly in a browser that has been reloaded since. A pick kept in memory would document the first
     * package on the model the user chose and the other forty on the standing one.
     *
     * THE WHOLE PICK is recorded, not merely the pair, for the same reason: a fan-out where the first session
     * thinks at Max on the account the reader chose and the rest at the model's default on whichever account
     * came first is not the run they asked for. The contract's own shape (AgentRunPickSchema), so this manifest
     * cannot fall behind what the picker can set. */
    readonly pick?: NonNullable<AgentRunPick>;
}

const parseManifest = (text: string): RunManifest | undefined => {
    try {
        const body = JSON.parse(text) as Record<string, unknown>;
        const runId = body[`runId`];
        const repo = body[`repo`];
        const packages = body[`packages`];
        // Read back through the contract's own schema: both halves of the pair or neither (a model id means
        // nothing without the provider that vends it, so half a pick off disk is worse than none), and every
        // knob it carries comes with it, without this reader having to be told each time one is added.
        const pick = AgentRunPickSchema.safeParse(body[`pick`]);
        if (typeof runId !== `string` || typeof repo !== `string`) {
            return undefined;
        }
        return {
            runId,
            repo,
            createdAt: typeof body[`createdAt`] === `number` ? (body[`createdAt`] as number) : 0,
            packages: Array.isArray(packages) ? packages.filter((dir): dir is string => typeof dir === `string`) : undefined,
            ...(pick.success && pick.data !== undefined ? { pick: pick.data } : {}),
        };
    } catch {
        return undefined;
    }
};

export interface RunRow {
    readonly manifest: RunManifest;
    readonly agents: readonly AgentSummary[];
    readonly mapDone: boolean;
    readonly running: boolean;
    // Packages whose document is already staged, the run's real progress, read off disk rather than counted.
    readonly done: number;
    // How many packages this run owes, or undefined while the map has yet to discover them.
    readonly total: number | undefined;
}

export interface StartRunInput {
    readonly repo: string;
    readonly label: string;
    // Absent ⇒ document every package the map finds.
    readonly packages?: readonly string[] | undefined;
    // The caret's choice, when the reader made one. Recorded on the manifest so the whole fan-out inherits it.
    readonly pick?: NonNullable<AgentRunPick> | undefined;
}

export function useRuns(repo: Ref<string>) {
    const api = host();
    const queryClient = useQueryClient();
    const runsKey = computed(() => api.sandbox.key(`documentation-runs`, `manifests`));
    const agentsKey = computed(() => api.sandbox.key(`documentation-runs`, `agents`));

    const json = async <T>(path: string): Promise<T | undefined> => {
        try {
            return (await api.sandbox.json(path)) as T;
        } catch {
            return undefined;
        }
    };

    const runsQuery = useQuery({
        queryKey: runsKey,
        enabled: computed(() => api.sandbox.reachable()),
        queryFn: async (): Promise<readonly RunManifest[]> => {
            const listing = await json<unknown>(`/workspace/children?path=${encodeURIComponent(RUNS_DIR)}`);
            if (listing === undefined) {
                return [];
            }
            const dirs = WorkspaceChildrenSchema.parse(listing)
                .entries.filter((entry) => entry.type === `dir`)
                // Run ids are base-36 timestamps, so the newest sort last, take the tail and reverse.
                .toSorted((left, right) => left.name.localeCompare(right.name))
                .slice(-SCAN_RUNS)
                .toReversed();
            const texts = await Promise.all(dirs.map((entry) => api.workspace.file(runManifestPath(entry.name))));
            return texts.flatMap((text) => (text === undefined ? [] : (parseManifest(text) ?? [])));
        },
    });

    const agentsQuery = useQuery({
        queryKey: agentsKey,
        enabled: computed(() => api.sandbox.reachable()),
        // Derives liveness from this query's own data, not a computed defined later: vue-query resolves
        // `refetchInterval` synchronously while building the observer, before such a const would exist.
        refetchInterval: (query) => {
            const agents = query.state.data ?? [];
            return agents.some((agent) => agent.id.startsWith(ANY_RUN_PREFIX) && isLive(agent)) ? POLL_MS : false;
        },
        queryFn: async (): Promise<readonly AgentSummary[]> => {
            const body = await json<unknown>(`/agents`);
            return body === undefined ? [] : AgentsListSchema.parse(body).agents;
        },
    });

    // Staged documents per run repo, advance()'s "which packages are finished" half and the run rows' progress. Keyed
    // on the `documentation` prefix contributes.files invalidates, so a write updates this without a poll.
    const stagedQuery = useQuery({
        queryKey: computed(() => api.sandbox.key(`documentation`, `staged-tails`, repo.value)),
        enabled: computed(() => api.sandbox.reachable()),
        queryFn: async () => documentedDirs(await listStagedTails(api, repo.value)),
    });

    // Annotated so the type doesn't walk back through three queries and degrade every `row` to `any`.
    const rows: ComputedRef<readonly RunRow[]> = computed(() => {
        const agents = agentsQuery.data.value ?? [];
        const staged = stagedQuery.data.value ?? [];
        return (runsQuery.data.value ?? [])
            .filter((manifest) => manifest.repo === repo.value)
            .map((manifest) => {
                const mapId = mapConversationId(manifest.runId);
                const mine = agents.filter((agent) => agent.id.startsWith(runPrefix(manifest.runId)));
                const mapAgent = agents.find((agent) => agent.id === mapId);
                const scope = manifest.packages;
                return {
                    manifest,
                    agents: mine,
                    // Absent from the roster means it finished and was archived, which is done, not pending.
                    mapDone: mapAgent === undefined || !isLive(mapAgent),
                    running: mine.some(isLive),
                    done: scope === undefined ? staged.length : scope.filter((dir) => staged.includes(dir)).length,
                    total: scope?.length,
                };
            });
    });

    // `unattended` + `runRole`, usually with no model, so the daemon fills one in from that role's list. `pick`
    // overrides it, read off the manifest so every session in the fan-out (even ones started later) agrees.
    const startAgent = async (conversationId: string, prompt: string, pick?: RunManifest[`pick`]): Promise<void> => {
        await api.sandbox.request(`/agent`, {
            method: `POST`,
            headers: { "content-type": `application/json` },
            body: JSON.stringify({
                prompt,
                conversationId,
                isolated: true,
                permissionMode: `bypassPermissions`,
                unattended: true,
                // Which of the owner's model lists pays for it (Sandbox ▸ Agent ▸ Models).
                runRole: `documentation-run`,
                // Spread verbatim: the pick's fields ARE the turn's (contract AgentRunPickSchema).
                ...pick,
            }),
        });
    };

    const start = async (input: StartRunInput): Promise<string> => {
        const runId = runIdAt(Date.now());
        const manifest: RunManifest = {
            runId,
            createdAt: Date.now(),
            repo: input.repo,
            ...(input.packages === undefined ? {} : { packages: [...input.packages] }),
            ...(input.pick === undefined ? {} : { pick: input.pick }),
        };
        // Written before the first turn starts, so a run that dies mid-launch is still visible and advanceable.
        await api.workspace.write(runManifestPath(runId), `${JSON.stringify(manifest, undefined, 2)}\n`);
        await startAgent(mapConversationId(runId), mapBrief({ repo: input.repo, label: input.label }), input.pick);
        void queryClient.invalidateQueries({ queryKey: api.sandbox.key(`documentation-runs`) });
        return runId;
    };

    // Starts the package agents a run still owes, once its map exists; safe on every poll since both checks below are
    // derived, never bookkept.
    const advance = async (): Promise<void> => {
        const agents = agentsQuery.data.value ?? [];
        const staged = stagedQuery.data.value ?? [];
        for (const row of rows.value) {
            if (!row.mapDone) {
                continue;
            }
            const text = await api.workspace.file(stagingPath(row.manifest.repo, REPO_DOC_TAIL));
            const repoDoc: RepoDoc | undefined = text === undefined ? undefined : parseRepoDoc(text);
            // No map means the map agent finished without one; starting package agents with no shared vocabulary is
            // worse.
            if (repoDoc === undefined) {
                continue;
            }
            // The run's scope: what it was told, or, for a first run, every package the map assigned to a component.
            const scope = row.manifest.packages ?? [...new Set(repoDoc.components.flatMap((component) => component.packages))];
            const pending = scope.filter((dir) => {
                const conversationId = conversationIdOf(row.manifest.runId, slugOf(dir));
                return !agents.some((agent) => agent.id === conversationId) && !staged.includes(dir);
            });
            for (const dir of pending) {
                await startAgent(
                    conversationIdOf(row.manifest.runId, slugOf(dir)),
                    packageBrief({
                        repo: row.manifest.repo,
                        label: row.manifest.repo === `` ? `the workspace root` : row.manifest.repo,
                        dir,
                        component: componentOfPackage(repoDoc, dir),
                        glossary: repoDoc.glossary,
                        components: repoDoc.components,
                    }),
                    row.manifest.pick,
                );
            }
            if (pending.length > 0) {
                void queryClient.invalidateQueries({ queryKey: agentsKey.value });
            }
        }
    };

    const stop = async (runId: string): Promise<void> => {
        const row = rows.value.find((entry) => entry.manifest.runId === runId);
        await Promise.all(
            (row?.agents ?? []).filter(isLive).map((agent) =>
                api.sandbox.request(`/agent/stop`, {
                    method: `POST`,
                    headers: { "content-type": `application/json` },
                    body: JSON.stringify({ conversationId: agent.id }),
                }),
            ),
        );
        void queryClient.invalidateQueries({ queryKey: agentsKey.value });
    };

    return { rows, isLoading: runsQuery.isLoading, start, advance, stop };
}
