import { AppsListSchema } from "@intentic-app/api-contract";
import { useQueryClient } from "@tanstack/vue-query";
import { computed, type Ref } from "vue";
import { usePanels } from "../extensions/usePanels";
import { APPS } from "../queryKeys";
import { sandboxJson } from "../sandbox/sandboxClient";
import { usePorts } from "../sandbox/usePorts";
import { useSandboxQuery } from "../sandbox/useSandboxQuery";
import { usePublicOutbox } from "../workspace/usePublicOutbox";
import { addressTarget, appTargets, mergeTargets, portTargets, type PreviewTarget, publicTarget, repoTargets } from "./previewModel";
import { previewAddress } from "./previewSurface";

/* The live list. `active` gates the per-monorepo apps fan-out to while the preview panel is actually mounted —
 * the same economy useWorkspaceApps applies — while panels and the outbox ride reads the shell already holds.
 * No clock anywhere: the daemon's runtime push invalidates `panels` and `apps` together on every dev-server
 * change (contract runtime-state.ts), and the outbox rides the file watcher's `public` push. */
export function usePreviewTargets(active: Ref<boolean>) {
    const queryClient = useQueryClient();
    const { panels, settled: panelsSettled, start: startRepo, stop: stopRepo } = usePanels();
    const { files: publicFiles, settled: publicSettled } = usePublicOutbox();
    // The forwarded ports the shell already reads for its exposure indicator — this adds no request.
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

    return {
        targets,
        // Both always-on reads have answered (or definitively failed) — what the empty state waits on before
        // claiming there is nothing to preview. The apps fan-out is additive and never gates it.
        settled: computed(() => panelsSettled.value && publicSettled.value),
        start,
        stop,
    };
}
