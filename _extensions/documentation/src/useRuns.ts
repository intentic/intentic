import { useQuery, useQueryClient } from "@tanstack/vue-query";
import { type AgentSummary, AgentsListSchema, WorkspaceChildrenSchema } from "@intentic/sandbox-contract";
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

/* GENERATION, map first, then one agent per package.
 *
 * A documentation session is an ISOLATED fleet agent: `POST /agent` with a conversationId and `isolated: true` is
 * the shape (and the only shape) that registers a fleet entry, which is why this extension owns no session
 * machinery. The worktree, live status, cost, transcript and the /agents/<id> page all already exist; a run is
 * N of them with derived ids. Isolation is NOT for safety here, these agents write to shared staging and are
 * told not to touch source, it is for that registry entry, and the branch it comes with is what keeps a
 * misbehaving run out of the main tree.
 *
 * WHY THE MAP GOES FIRST, AND WHY THAT COSTS A PHASE. The component grouping and the glossary are cross-package
 * judgements: 42 agents deciding independently produce 42 vocabularies and no map. So the fan-out cannot start
 * until `repo.json` exists, and the browser is what notices that it does.
 *
 * ADVANCING IS IDEMPOTENT AND DERIVED, WHICH IS WHAT MAKES THAT SAFE. `advance()` runs on every poll. It starts a
 * package's agent only when there is neither a fleet entry for its (derived) conversation id nor a staged document
 * for it, both read from the world rather than from bookkeeping. So closing the browser mid-run does not orphan
 * it: the run resumes the next time the view is open, and nothing is ever started twice. An agent that finished
 * and was archived drops off `GET /agents`, which is exactly why the staged document is the second half of the
 * test, without it, an archived agent's package would be documented again on the next poll.
 *
 * `bypassPermissions`, for the reason acceptance uses it: nobody watches a fan-out of forty for permission cards,
 * and the scope is bounded the way the fleet bounds it (one worktree each, and a brief whose first rule is
 * "write only these two files". */

const POLL_MS = 4000;

const isLive = (agent: AgentSummary): boolean => agent.status === `running` || agent.status === `awaiting`;

export interface RunManifest {
    readonly runId: string;
    readonly createdAt: number;
    readonly repo: string;
    /* The packages in scope, or ABSENT for "whatever the map finds".
     *
     * Absent is the normal first run, and it is what keeps package discovery in one place. Only `intentic-docs
     * facts` can enumerate a repo's packages, it runs on the AGENT's PATH, and the browser has no business
     * reimplementing that walk over `/workspace/children` to populate a picker. So a first run says "document this
     * repo", the map phase discovers the packages and assigns them to components, and the fan-out reads its scope
     * out of `repo.json`. A later run can narrow to a subset, the stale ones, because by then an index exists to
     * choose from. */
    readonly packages?: readonly string[];
    /* The model every session in this run opens on, when the reader used the caret beside Generate. Absent ⇒
     * the sandbox's agent-run list answers, which is the ordinary path.
     *
     * ON THE MANIFEST rather than held in the view, because a run OUTLIVES the press that started it: only the
     * map agent starts immediately, and the fan-out is started later by `advance()`, on a later poll, quite
     * possibly in a browser that has been reloaded since. A pick kept in memory would document the first
     * package on the model the user chose and the other forty on the standing one.
     *
     * The TIER is part of that choice and is recorded with it, for the same reason: a fan-out where the first
     * session thinks at Max and the rest at the model's default is not the run the reader asked for. */
    readonly pick?: { readonly agent: string; readonly model: string; readonly effort?: string };
}

const parseManifest = (text: string): RunManifest | undefined => {
    try {
        const body = JSON.parse(text) as Record<string, unknown>;
        const runId = body[`runId`];
        const repo = body[`repo`];
        const packages = body[`packages`];
        const pick = body[`pick`] as { agent?: unknown; model?: unknown; effort?: unknown } | undefined;
        if (typeof runId !== `string` || typeof repo !== `string`) {
            return undefined;
        }
        return {
            runId,
            repo,
            createdAt: typeof body[`createdAt`] === `number` ? (body[`createdAt`] as number) : 0,
            packages: Array.isArray(packages) ? packages.filter((dir): dir is string => typeof dir === `string`) : undefined,
            // Both halves or neither: a model id means nothing without the provider that vends it, so half a
            // pick read back off disk is worse than none. The tier is its own question and rides along when the
            // file has one, a manifest written before the reader chose a tier simply has none.
            ...(typeof pick?.agent === `string` && typeof pick.model === `string`
                ? { pick: { agent: pick.agent, model: pick.model, ...(typeof pick.effort === `string` ? { effort: pick.effort } : {}) } }
                : {}),
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
    // Absent ⇒ document every package the map finds. See RunManifest.packages.
    readonly packages?: readonly string[] | undefined;
    // The caret's choice, when the reader made one. Recorded on the manifest so the whole fan-out inherits it.
    readonly pick?: { readonly agent: string; readonly model: string; readonly effort?: string } | undefined;
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
        /* Liveness comes from THIS QUERY'S OWN DATA, never from a computed defined below it.
         *
         * vue-query resolves `refetchInterval` synchronously while `useQuery` builds its observer, so a callback
         * reading a `const` declared later in this function reads it inside its temporal dead zone and throws
         * `Cannot access 'live' before initialization`, which is what shipped, because nothing in the suite ever
         * CALLED this composable: a type-level cycle was broken with annotations while the runtime cycle was left
         * in place. useRuns.test.ts now executes it for exactly this reason.
         *
         * Deriving from `query.state.data` is not a workaround but the honest source: "is any documentation-run
         * agent still working" is a fact about the agents list, and this query IS the agents list. */
        refetchInterval: (query) => {
            const agents = query.state.data ?? [];
            return agents.some((agent) => agent.id.startsWith(ANY_RUN_PREFIX) && isLive(agent)) ? POLL_MS : false;
        },
        queryFn: async (): Promise<readonly AgentSummary[]> => {
            const body = await json<unknown>(`/agents`);
            return body === undefined ? [] : AgentsListSchema.parse(body).agents;
        },
    });

    // Staged documents per run repo, the "which packages are finished" half of advance(), and the run rows' own
    // progress readout. Keyed on the same `documentation` prefix the manifest's contributes.files invalidates,
    // so an agent writing a document updates this without a poll.
    const stagedQuery = useQuery({
        queryKey: computed(() => api.sandbox.key(`documentation`, `staged-tails`, repo.value)),
        enabled: computed(() => api.sandbox.reachable()),
        queryFn: async () => documentedDirs(await listStagedTails(api, repo.value)),
    });

    // Annotated because the inferred type would otherwise walk back through three query results; the annotation
    // is also what keeps every downstream `row` from degrading to `any`.
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

    /* `unattended` and usually no model: the daemon then fills in from `agentRunModels`, which is the one place
     * a documentation run and every other surface-started run get their answer from.
     *
     * `pick` is the run's own override, read back off its manifest so every session in the fan-out opens on the
     * same model and tier the caret named, including the ones started an hour later by `advance()`. */
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
                ...(pick !== undefined
                    ? { agent: pick.agent, model: pick.model, ...(pick.effort === undefined ? {} : { effort: pick.effort }) }
                    : {}),
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
        // The manifest is written BEFORE the first turn starts, so a run that dies mid-launch is still a run the
        // view can show and advance rather than an invisible half-thing.
        await api.workspace.write(runManifestPath(runId), `${JSON.stringify(manifest, undefined, 2)}\n`);
        await startAgent(mapConversationId(runId), mapBrief({ repo: input.repo, label: input.label }), input.pick);
        void queryClient.invalidateQueries({ queryKey: api.sandbox.key(`documentation-runs`) });
        return runId;
    };

    /* Start the package agents a run still owes, once its map exists. Safe to call on every poll: the two tests
     * below are both derived, so a package that has an agent or a document is never started again. */
    const advance = async (): Promise<void> => {
        const agents = agentsQuery.data.value ?? [];
        const staged = stagedQuery.data.value ?? [];
        for (const row of rows.value) {
            if (!row.mapDone) {
                continue;
            }
            const text = await api.workspace.file(stagingPath(row.manifest.repo, REPO_DOC_TAIL));
            const repoDoc: RepoDoc | undefined = text === undefined ? undefined : parseRepoDoc(text);
            // No map means the map agent finished without producing one (it errored, or it was stopped). Starting
            // 40 package agents with no shared vocabulary is worse than leaving the run visibly unfinished.
            if (repoDoc === undefined) {
                continue;
            }
            /* The run's scope: what it was told to document, or, for a first run, every package the map assigned
             * to a component. The map is the only thing that has run `intentic-docs facts`, so this is where its
             * discovery becomes the fan-out's work list. */
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
