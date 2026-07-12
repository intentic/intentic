import { watch } from "vue";
import { useCapabilities } from "../composables/extensions/useCapabilities";
import { usePanels } from "../composables/extensions/usePanels";
import { useSandbox } from "../composables/useSandbox";
import { loadExtensions } from "./loader";

let started = false;

// Boots third-party extensions once per app load, as soon as the active sandbox is reachable. Called from
// WorkspaceShell — the facts composables need its vue-query context, and the shell is the persistent post-login
// surface whose lifetime the loaded extensions share. Extensions stay loaded until a full page reload;
// switching the active sandbox mid-session keeps the previous sandbox's extensions registered (v1 caveat — a
// switch reloads the shell's data everywhere else too, and install/remove tells the user to reload).
export function useExtensionHost(): void {
    if (started) {
        return;
    }
    started = true;
    const { reachable } = useSandbox();
    const { panels } = usePanels();
    const { capabilities } = useCapabilities();
    const host = { repos: () => panels.value, capabilities: () => capabilities.value };
    let loading = false;
    watch(
        reachable,
        (value) => {
            if (value !== true || loading) {
                return;
            }
            loading = true;
            void loadExtensions(host);
        },
        { immediate: true },
    );
}
