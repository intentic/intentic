import { AppsListSchema } from "@intentic-app/api-contract";
import type { PortForwardResult } from "@intentic/sandbox-contract";
import { useQueryClient } from "@tanstack/vue-query";
import { computed, type Ref } from "vue";
import { usePanels } from "../extensions/usePanels";
import { APPS, PORTS } from "../queryKeys";
import { jsonBody } from "../sandbox/jsonBody";
import { sandboxJson } from "../sandbox/sandboxClient";
import { usePorts } from "../sandbox/usePorts";
import { useSandboxQuery } from "../sandbox/useSandboxQuery";
import { usePublicOutbox } from "../workspace/usePublicOutbox";
import { addressTarget, appTargets, mergeTargets, portTargets, type PreviewTarget, portTargetId, publicTarget, repoTargets } from "./previewModel";
import { previewAddress } from "./previewSurface";

/* The live list. `active` gates the per-monorepo apps fan-out to while the preview panel is actually mounted,
 * the same economy useWorkspaceApps applies, while panels and the outbox ride reads the shell already holds.
 * No clock anywhere: the daemon's runtime push invalidates `panels` and `apps` together on every dev-server
 * change (contract runtime-state.ts), and the outbox rides the file watcher's `public` push. */
export function usePreviewTargets(active: Ref<boolean>) {
    const queryClient = useQueryClient();
    const { panels, settled: panelsSettled, start: startRepo, stop: stopRepo, invalidate: invalidatePanels } = usePanels();
    const { files: publicFiles, settled: publicSettled } = usePublicOutbox();
    // The forwarded ports the shell already reads for its exposure indicator, this adds no request.
    const { forwarded } = usePorts();

    const monorepos = computed(() => panels.value.filter((panel) => panel.monorepo).map((panel) => panel.repo));
    const { query: appsQuery } = useSandboxQuery({
        // Keyed on the monorepo list so a repo appearing or vanishing refetches; the key's `apps` prefix is
        // what the daemon's runtime push lands on.
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

    /* Forward one port of a repo that is answering on several, and answer with the target it just became. This
     * is the way out of the one state a repo-level preview address cannot express: `dev` fanned out across
     * packages that pinned their own ports, so the user has to say which of them they meant, and saying it
     * should not mean leaving for the Ports view. The wait for the refetch is deliberate, the target does not
     * exist until the ports read lands, and selecting an id that isn't in the list drops the panel onto
     * whatever pickTarget likes best in the meantime. */
    const forward = async (port: number): Promise<string | undefined> => {
        const { previewUrl } = await sandboxJson<PortForwardResult>(`/ports/forward`, jsonBody(`POST`, { port }));
        await queryClient.invalidateQueries({ queryKey: PORTS.every });
        return previewUrl === undefined ? undefined : portTargetId(port);
    };

    /* THE FALLBACK BEHIND THE PUSH. Both lists here are pushed by the daemon and polled by nobody, which is the
     * right steady state and the wrong only state: the panel that is WAITING on a start has one frame to wait
     * for, and a frame dropped across a reconnect (likelier on the throttled first boot the wait is about) left
     * "Preparing the preview…" standing over a server that had been serving for minutes. This is the ask-again
     * that wait falls back on; it invalidates rather than fetches so it lands in the same shared entries. */
    const refresh = async (): Promise<void> => {
        await Promise.all([invalidatePanels(), queryClient.invalidateQueries({ queryKey: APPS.every })]);
    };

    return {
        targets,
        // Both always-on reads have answered (or definitively failed), what the empty state waits on before
        // claiming there is nothing to preview. The apps fan-out is additive and never gates it.
        settled: computed(() => panelsSettled.value && publicSettled.value),
        start,
        stop,
        forward,
        refresh,
    };
}
