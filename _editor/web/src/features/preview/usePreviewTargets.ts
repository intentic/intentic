import { AppsListSchema } from "@intentic/api-contract";
import type { PortForwardResult } from "@intentic/sandbox-contract";
import { useQueryClient } from "@tanstack/vue-query";
import { computed, type Ref } from "vue";
import { usePanels } from "../extensions/usePanels";
import { APPS, PORTS } from "../../lib/queryKeys";
import { jsonBody } from "../sandbox/client/jsonBody";
import { sandboxJson } from "../sandbox/client/sandboxClient";
import { usePorts } from "../sandbox/environment/usePorts";
import { useSandboxQuery } from "../sandbox/client/useSandboxQuery";
import { usePublicOutbox } from "../workspace/push/usePublicOutbox";
import { addressTarget, appTargets, mergeTargets, portTargets, type PreviewTarget, portTargetId, publicTarget, repoTargets } from "./previewModel";
import { previewAddress } from "./previewSurface";

// The live list. `active` gates the per-monorepo apps fan-out while the panel is mounted (same economy as
// useWorkspaceApps); panels/outbox ride reads the shell holds. No clock: the daemon's runtime push invalidates panels
// and apps together; the outbox rides the file watcher's public push.
export function usePreviewTargets(active: Ref<boolean>) {
    const queryClient = useQueryClient();
    const { panels, settled: panelsSettled, start: startRepo, stop: stopRepo, invalidate: invalidatePanels } = usePanels();
    const { files: publicFiles, settled: publicSettled } = usePublicOutbox();
    // The forwarded ports the shell already reads for its exposure indicator, this adds no request.
    const { forwarded } = usePorts();

    const monorepos = computed(() => panels.value.filter((panel) => panel.monorepo).map((panel) => panel.repo));
    const { query: appsQuery } = useSandboxQuery({
        // Keyed on the monorepo list; a repo appearing or vanishing refetches, matching the daemon's `apps` push.
        queryKey: computed(() => APPS.of(...monorepos.value)),
        queryFn: async () => {
            const lists = await Promise.all(
                monorepos.value.map(async (repo) => {
                    const { apps } = AppsListSchema.parse(await sandboxJson(`/workspace/repos/${encodeURIComponent(repo)}/apps`));
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
            portTargets(forwarded.value),
            publicTarget(publicFiles.value),
            addressTarget(previewAddress.value),
        ),
    );

    // One verb for both process kinds; the public page has no process and falls through to nothing.
    const act = async (target: PreviewTarget, verb: `start` | `stop`): Promise<void> => {
        if (target.kind === `repo` && target.repo !== undefined) {
            await (verb === `start` ? startRepo(target.repo) : stopRepo(target.repo));
            return;
        }
        if (target.kind === `app` && target.repo !== undefined && target.app !== undefined) {
            await sandboxJson(`/workspace/repos/${encodeURIComponent(target.repo)}/apps/${encodeURIComponent(target.app)}/${verb}`, {
                method: `POST`,
            });
            await queryClient.invalidateQueries({ queryKey: APPS.every });
        }
    };
    const start = async (target: PreviewTarget): Promise<void> => act(target, `start`);
    const stop = async (target: PreviewTarget): Promise<void> => act(target, `stop`);

    // Forwards one port of a multi-port repo and returns the target it becomes, without leaving for the Ports view.
    // Waits for the refetch since the target doesn't exist until the ports read lands.
    const forward = async (port: number): Promise<string | undefined> => {
        const { previewUrl } = await sandboxJson<PortForwardResult>(`/ports/forward`, jsonBody(`POST`, { port }));
        await queryClient.invalidateQueries({ queryKey: PORTS.every });
        return previewUrl === undefined ? undefined : portTargetId(port);
    };

    // Fallback for a panel waiting on a start when the daemon's push frame drops (e.g. across a reconnect). Invalidates
    // rather than fetches, so it lands in the same shared query entries.
    const refresh = async (): Promise<void> => {
        await Promise.all([invalidatePanels(), queryClient.invalidateQueries({ queryKey: APPS.every })]);
    };

    return {
        targets,
        // Both always-on reads settled; the empty state waits on this. Apps fan-out is additive, never gating.
        settled: computed(() => panelsSettled.value && publicSettled.value),
        start,
        stop,
        forward,
        refresh,
    };
}
