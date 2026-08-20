import { watch } from "vue";
import { useCapabilities } from "../composables/extensions/useCapabilities";
import { usePanels } from "../composables/extensions/usePanels";
import { activeSandboxId } from "../composables/sandbox/activeSandbox";
import { useSandbox } from "../composables/sandbox/useSandbox";
import type { HostBindings } from "./apiImpl";
import { loadExtensions, retireExtensions } from "./loader";

let started = false;
// The live host bindings, captured at boot so a later reconcile can re-run the loader without rebuilding them
//, they close over composables that need the shell's vue-query context, which only this file runs inside.
let bindings: HostBindings | undefined;

// Re-read the daemon's extension list and converge the shell onto it: the Extensions tab calls this after
// flipping a switch, and the loader activates, supersedes or retires each extension accordingly.
export async function reloadExtensions(): Promise<void> {
    if (bindings === undefined) {
        throw new Error(`the extension host has not booted`);
    }
    await loadExtensions(bindings);
}

/* Boots every extension as soon as the active sandbox is reachable, including the first-party ones compiled
 * into this bundle, because which extensions exist and which the owner left on is the daemon's list to answer
 * (loader.ts). That waits one local round-trip before the rail gains its extension tiles, and it is the right
 * wait: each of those views is a daemon client, and a list that fails still lands them via the loader's
 * unlisted path. Called from WorkspaceShell, the facts composables need its vue-query context, and the shell
 * is the persistent post-login surface whose lifetime the loaded extensions share.
 *
 * PER SANDBOX, NOT PER PAGE LOAD, and that used to be the other way around. The extensions a box has installed,
 * which of them its owner switched on, and everything each one has read are all one sandbox's answers, so
 * carrying them across a switch put the previous box's tiles in the rail, its numbers on their badges and its
 * document icons on this box's file tree, none of which corrected until a poll happened to come round (ten
 * minutes, for the slowest). The switch is therefore a full re-scope: retire, then load against the new list.
 *
 * The two watches are deliberately separate. Retiring must happen the INSTANT the id changes, whether or not
 * the new box is reachable yet, a stale tile is worse than an absent one, and a box that never connects must
 * not leave the previous one's rail standing in its place. Loading has to wait for reachability, and also has
 * to fire on a plain reconnect (the initial load, an outage recovering), which is not a switch at all. */
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

    // Which sandbox the extensions currently on screen belong to. `loading` alone can't answer that: it means
    // "a pass has been started", and after a switch the pass that was started is the wrong sandbox's.
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
