import type { Disposable } from "@intentic/extension-api";
import { computed, onMounted, onUnmounted, watch, type WatchStopHandle } from "vue";
import { useRouter } from "vue-router";
import { detectActivations, extensionPath } from "../../core-views/registry";
import { useCapabilities } from "../../features/capabilities/connect/useCapabilities";
import { usePanels } from "../../features/extensions/usePanels";
import { registerCommand } from "./useCommands";

// Go-to command for every area the rail can show, including ones not currently seated. Derived from live
// activations, not a hardcoded list, so third-party areas appear automatically. One command per activation (not per
// view); id includes the activation key unless it is a singleton (`view.<id>`).
// One palette row: the command it registers, its title, and its destination route.
interface AreaCommand {
    readonly command: string;
    readonly title: string;
    readonly icon?: string | undefined;
    readonly to: string;
}

export function useAreaCommands(): void {
    const router = useRouter();
    const { panels } = usePanels();
    const { capabilities } = useCapabilities();

    const areas = computed<readonly AreaCommand[]>(() =>
        detectActivations(panels.value, capabilities.value)
            .filter(({ extension }) => extension.surface === `rail`)
            .map(({ extension, activation }) => ({
                command: activation.key === extension.id ? `view.${extension.id}` : `view.${extension.id}.${activation.key}`,
                title: `Go to ${activation.title}`,
                icon: activation.icon,
                to: extensionPath(extension, activation),
            })),
    );

    let disposables: readonly Disposable[] = [];
    const release = (): void => {
        for (const disposable of disposables) {
            disposable.dispose();
        }
        disposables = [];
    };

    const sync = (list: readonly AreaCommand[]): void => {
        // Release before re-registering, so a hot-reloaded view isn't refused as duplicate of its own previous command.
        release();
        disposables = list.flatMap((area) => {
            try {
                return [
                    registerCommand({
                        owner: `builtin`,
                        command: area.command,
                        title: area.title,
                        ...(area.icon === undefined ? {} : { icon: area.icon }),
                        handler: () => router.push(area.to),
                    }),
                ];
            } catch (error) {
                // A colliding third-party id: the tile still works, but the palette row is lost, not every other area's
                // command.
                console.error(`command ${area.command}: already registered`, error);
                return [];
            }
        });
    };

    // Registered from onMounted, not setup, since WorkspaceShell may discard an instance before it ever mounts.
    let stop: WatchStopHandle | undefined;

    onMounted(() => {
        stop = watch(areas, sync, { immediate: true });
    });

    onUnmounted(() => {
        stop?.();
        stop = undefined;
        release();
    });
}
