import type { IntenticApi } from "./api.js";

/* THE AMBIENT HOST HANDLE, one slot per extension. `activate(api)` binds it once, before any view renders, so
 * the extension's composables reach the authenticated daemon transport, cache scoping and workspace facts
 * through `host()`, the way `vscode.*` is ambient to a VSCode extension. Not app internals: everything flows
 * through the public IntenticApi.
 *
 * A FACTORY rather than a module-level slot here, and that is the whole reason this lives in the API package
 * instead of being one shared `host()`. The web shell publishes ONE instance of this module to every bundle
 * (extension-host/hostModules.ts), so a slot held at module scope would be a single global that the last
 * extension to activate silently takes over. Each extension calls this once and keeps its own closure:
 *
 *     export const { bindHost, host } = hostSlot(`ext-activity`);
 *
 * The names come back already spelled the way call sites use them, so nothing downstream renames anything. */
export const hostSlot = (extension: string): { bindHost: (api: IntenticApi) => void; host: () => IntenticApi } => {
    let current: IntenticApi | undefined;
    return {
        bindHost: (api) => {
            current = api;
        },
        host: () => {
            if (current === undefined) {
                throw new Error(`${extension}: host() called before activate()`);
            }
            return current;
        },
    };
};
