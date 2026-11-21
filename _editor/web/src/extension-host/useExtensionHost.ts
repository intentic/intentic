import { activeLocale } from "@intentic/ui/i18n";
import { watch } from "vue";
import { useCapabilities } from "../models/capabilities/useCapabilities";
import { useExtensions } from "../models/extensions/useExtensions";
import { usePanels } from "../models/extensions/usePanels";
import { activeSandboxId } from "../app/storage/activeSandbox";
import { useSandbox } from "../client/sandbox/useSandbox";
import type { HostBindings } from "./apiImpl";
import { extensionHostStarted } from "../workbench/views/extensionStatuses";
import { extensionsLoaded, extensionsReconciling, loadedListAt, loadedWorkspace, loadExtensions, retireExtensions } from "./loader";
import { workspaceDrifted } from "./workspaceDrift";

let started = false;
// Host bindings, captured at boot so a later reconcile can rerun the loader without rebuilding them.
let bindings: HostBindings | undefined;

// Re-reads the daemon's extension list and converges the shell onto it.
// Called by the Extensions tab after a switch is flipped; the loader activates, supersedes, or retires each extension
// accordingly.
export async function reloadExtensions(): Promise<void> {
    if (bindings === undefined) {
        throw new Error(`the extension host has not booted`);
    }
    await loadExtensions(bindings);
}

// Boots extensions once the active sandbox is reachable; a switch does a full re-scope (retire, then reload) rather
// than carrying the previous box's state across.
// The two watches are separate on purpose: retiring fires the instant the id changes even if the new box isn't
// reachable yet, while loading waits for reachability and also fires on a plain reconnect.
export function useExtensionHost(): void {
    if (started) {
        return;
    }
    started = true;
    extensionHostStarted.value = true;
    const { reachable } = useSandbox();
    const { panels } = usePanels();
    const { capabilities } = useCapabilities();
    bindings = {
        repos: () => panels.value,
        capabilities: () => capabilities.value,
    };

    // Which sandbox the on-screen extensions belong to; loading can't say, once a switch invalidates the pass.
    let loadedFor: string | undefined;
    let loading = false;

    watch(activeSandboxId, (id, previous) => {
        if (id === previous) {
            return;
        }
        retireExtensions();
        loadedFor = undefined;
        loading = false;
    });

    // A contribution's label is a string an extension handed us inside `activate`, not a binding we can re-read, so
    // the only way it follows a language change is to run `activate` again. Safe to do bluntly: `activeLocale` moves
    // only once the new language's messages are already loaded, so the pass below re-registers into a tree that is
    // complete, and a reader changes language about once.
    watch(activeLocale, () => {
        retireExtensions();
        loadedFor = undefined;
        loading = true;
        void reloadExtensions().finally(() => {
            loading = false;
            loadedFor = activeSandboxId.value;
        });
    });

    // A land that turned on, changed or removed one of the workspace's own extensions shows without a reload: the list
    // moves (the file push for its folder, the grants push for its approval) and the host loads again. Only a list read
    // after the last pass speaks for what came since; a hydrated one is from a previous visit.
    const { extensions, listedAt } = useExtensions();
    watch(extensions, (listed) => {
        const behind = extensionsLoaded.value && !extensionsReconciling.value && loadedFor === activeSandboxId.value && listedAt.value > loadedListAt.value;
        if (loading || !behind || !workspaceDrifted(loadedWorkspace.value, listed)) {
            return;
        }
        loading = true;
        void reloadExtensions().finally(() => {
            loading = false;
        });
    });

    watch(
        [reachable, activeSandboxId] as const,
        ([isReachable, id]) => {
            if (isReachable !== true || loading || loadedFor === id) {
                return;
            }
            loading = true;
            loadedFor = id;
            void reloadExtensions().finally(() => {
                loading = false;
            });
        },
        { immediate: true },
    );
}
