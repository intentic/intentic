import { watch } from "vue";
import { useCapabilities } from "../composables/extensions/useCapabilities";
import { usePanels } from "../composables/extensions/usePanels";
import { useSandbox } from "../composables/sandbox/useSandbox";
import type { HostBindings } from "./apiImpl";
import { loadExtensions } from "./loader";

let started = false;
// The live host bindings, captured at boot so a later reconcile can re-run the loader without rebuilding them
// — they close over composables that need the shell's vue-query context, which only this file runs inside.
let bindings: HostBindings | undefined;

// Re-read the daemon's extension list and converge the shell onto it: the Extensions tab calls this after
// flipping a switch, and the loader activates, supersedes or retires each extension accordingly.
export async function reloadExtensions(): Promise<void> {
    if (bindings === undefined) {
        throw new Error(`the extension host has not booted`);
    }
    await loadExtensions(bindings);
}

// Boots every extension once per app load, as soon as the active sandbox is reachable — including the
// first-party ones compiled into this bundle, because which extensions exist and which the owner left on is
// the daemon's list to answer (loader.ts). That waits one local round-trip before the rail gains its extension
// tiles, and it is the right wait: each of those views is a daemon client, and a list that fails still lands
// them via the loader's unlisted path. Called from WorkspaceShell — the facts composables need its vue-query
// context, and the shell is the persistent post-login surface whose lifetime the loaded extensions share.
// Extensions stay loaded until a full page reload; switching the active sandbox mid-session keeps the previous
// sandbox's extensions registered (v1 caveat — a switch reloads the shell's data everywhere else too, and
// install/remove tells the user to reload).
export function useExtensionHost(): void {
    if (started) {
        return;
    }
    started = true;
    const { reachable } = useSandbox();
    const { panels } = usePanels();
    const { capabilities } = useCapabilities();
    bindings = { repos: () => panels.value, capabilities: () => capabilities.value };
    let loading = false;
    watch(
        reachable,
        (value) => {
            if (value !== true || loading) {
                return;
            }
            loading = true;
            void reloadExtensions();
        },
        { immediate: true },
    );
}
