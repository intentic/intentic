import { watch } from "vue";
import { useCapabilities } from "../features/capabilities/connect/useCapabilities";
import { usePanels } from "../features/extensions/usePanels";
import { activeSandboxId } from "../features/sandbox/overview/activeSandbox";
import { useSandbox } from "../features/sandbox/client/useSandbox";
import type { HostBindings } from "./apiImpl";
import { loadExtensions, retireExtensions } from "./loader";

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
