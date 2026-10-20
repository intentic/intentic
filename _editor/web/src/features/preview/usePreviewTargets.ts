import { useQueryClient } from "@tanstack/vue-query";
import { allLoaded } from "@intentic/extension-api";
import { computed, type Ref } from "vue";
import { usePanels } from "../../models/extensions/usePanels";
import { APPS, rpcPrefix } from "../../lib/queryKeys";
import { sandboxRpc } from "../../client/sandbox/sandboxRpc";
import { stopJob } from "../../models/fleet/useAgents-actions";
import { usePorts } from "../../models/sandbox/environment/usePorts";
import { useSandboxQuery } from "../../client/sandbox/useSandboxQuery";
import { usePublicOutbox } from "../../models/workspace/push/usePublicOutbox";
import { appTargets, mergeTargets, portTargets, type PreviewTarget, portTargetId, publicTarget, repoTargets } from "../../models/preview/previewModel";

// The live list. `active` gates the per-monorepo apps fan-out while the panel is mounted (same economy as
// useWorkspaceApps); panels/outbox ride reads the shell holds. No clock: the daemon's runtime push invalidates panels
// and apps together; the outbox rides the file watcher's public push.
export function usePreviewTargets(active: Ref<boolean>) {
    const queryClient = useQueryClient();
    const { panels, loaded: panelsRead, start: startRepo, stop: stopRepo, invalidate: invalidatePanels } = usePanels();
    const { files: publicFiles, loaded: publicRead } = usePublicOutbox();
    // The ports the shell already reads for its exposure indicator (forwarded, and servers agents left for the person);
    // this adds no request.
    const { offered } = usePorts();

    const monorepos = computed(() => panels.value.filter((panel) => panel.monorepo).map((panel) => panel.repo));
    const { query: appsQuery } = useSandboxQuery({
        // Keyed on the monorepo list, held as one element so a single repo's read can never share the entry; a repo
        // appearing or vanishing refetches, matching the daemon's `apps` push.
        queryKey: computed(() => APPS.of([...monorepos.value])),
        queryFn: async () => {
            const lists = await Promise.all(
                monorepos.value.map(async (repo) => {
                    const { apps } = await sandboxRpc.workspace.appsList({ repo });
                    return { repo, apps };
                }),
            );
            return lists;
        },
        enabled: active,
    });

    const targets = computed<readonly PreviewTarget[]>(() =>
        mergeTargets(
            repoTargets(panels.value),
            (appsQuery.data.value ?? []).flatMap(({ repo, apps }) => appTargets(repo, apps)),
            portTargets(offered.value),
            publicTarget(publicFiles.value),
        ),
    );

    // One verb for every process kind; the public page has no process and falls through to nothing. A server an agent
    // left running for the person is stopped through its conversation, the one place that knows it as a job.
    const act = async (target: PreviewTarget, verb: `start` | `stop`): Promise<void> => {
        if (target.job !== undefined && verb === `stop`) {
            await stopJob(target.job.conversationId, target.job.jobId);
            await queryClient.invalidateQueries({ queryKey: rpcPrefix(`ports.list`) });
            return;
        }
        if (target.kind === `repo` && target.repo !== undefined) {
            await (verb === `start` ? startRepo(target.repo) : stopRepo(target.repo));
            return;
        }
        if (target.kind === `app` && target.repo !== undefined && target.app !== undefined) {
            const input = { repo: target.repo, app: target.app };
            await (verb === `start` ? sandboxRpc.workspace.startApp(input) : sandboxRpc.workspace.stopApp(input));
            await queryClient.invalidateQueries({ queryKey: APPS.every });
        }
    };
    const start = async (target: PreviewTarget): Promise<void> => act(target, `start`);
    const stop = async (target: PreviewTarget): Promise<void> => act(target, `stop`);

    // Forwards one port of a multi-port repo and returns the target it becomes, without leaving for the Ports view.
    // Waits for the refetch since the target doesn't exist until the ports read lands.
    const forward = async (port: number): Promise<string | undefined> => {
        const { previewUrl } = await sandboxRpc.ports.forward({ port });
        await queryClient.invalidateQueries({ queryKey: rpcPrefix(`ports.list`) });
        return previewUrl === undefined ? undefined : portTargetId(port);
    };

    // Fallback for a panel waiting on a start when the daemon's push frame drops (e.g. across a reconnect). Invalidates
    // rather than fetches, so it lands in the same shared query entries.
    const refresh = async (): Promise<void> => {
        await Promise.all([invalidatePanels(), queryClient.invalidateQueries({ queryKey: APPS.every })]);
    };

    return {
        targets,
        // Where the two always-on reads stand, as one: only their answer can say an app is gone or that nothing runs;
        // a failure is said as one. Apps fan-out is additive, never gating.
        listed: computed(() => allLoaded([panelsRead.value, publicRead.value])),
        start,
        stop,
        forward,
        refresh,
    };
}
