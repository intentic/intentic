import type { IntenticApi } from "./api.js";

// Per-extension host handle, ambient like `vscode.*`: `activate(api)` binds it once via `bindHost`, `host()` reads it.
// A factory, not a module-level slot: the web shell publishes one instance of this module to every extension's bundle,
// so a shared slot would be overwritten by whichever activates last.
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
