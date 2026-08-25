import type { Disposable } from "@intentic/extension-api";
import { computed, onMounted, onUnmounted, watch, type WatchStopHandle } from "vue";
import { useRouter } from "vue-router";
import { detectActivations, extensionPath } from "../../core-views/registry";
import { useCapabilities } from "../extensions/useCapabilities";
import { usePanels } from "../extensions/usePanels";
import { registerCommand } from "./useCommands";

/* A "GO TO …" COMMAND FOR EVERY AREA THE RAIL CAN SHOW, whether or not it is currently seated on it.
 *
 * The rail seats a tile while it has something to say and keeps the rest behind the More menu (registry.ts's
 * seat paragraphs). That trade is only honest if a quiet area is still one keystroke away, which for the core
 * surfaces it already was: `useShellCommands` hand-registers Workspace, Agents, Preview, Logs, Ports. Every
 * extension area had nothing, so a rail that hides Automations while nothing is pending would have hidden the
 * only way to reach it that does not involve a mouse.
 *
 * DERIVED FROM THE LIVE ACTIVATIONS rather than from a list written out here, for the reason the rail's own
 * order is: a list of areas maintained by hand next to a registry that produces them is a list that drifts. It
 * also means a third-party bundle's area is in the palette the moment it activates, without asking anything of
 * the extension.
 *
 * ONE COMMAND PER ACTIVATION, not per view: a Deployments tile per Komodo connection is two destinations, and
 * "Go to Deployments" that can only reach one of them is worse than either. The id carries the activation key
 * for exactly those cases and stays `view.<id>` for a singleton, which is the same collapse `extensionPath`
 * makes on the route. */
// One palette row: the command it is registered under, what it says, and where it goes.
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
        // Released first, so a view that re-registered under the same id (a hot reload, an extension being
        // switched back on) is not refused as a duplicate by its own previous command.
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
                // A third-party view id colliding with a command the shell already owns (`view.logs`, say). Its
                // tile and its More row still work; it is the palette row that cannot exist twice, and one
                // extension must not cost every other area its command.
                console.error(`command ${area.command}: already registered`, error);
                return [];
            }
        });
    };

    /* REGISTERED FROM `onMounted`, NOT FROM SETUP, which is where useShellCommands does it and for a reason that
     * only shows up in a running app: the shell is chosen by device (WorkspaceShell), so an instance whose setup
     * has run can still be discarded before it ever mounts. Registering during setup put a `view.*` command per
     * area into the singleton registry owned by a component that would never run an unmount hook to dispose
     * them, and the instance that DID mount then found every one of its own ids taken. Nothing is registered
     * until there is a mounted component to own the disposal. */
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
