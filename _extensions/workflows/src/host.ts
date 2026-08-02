import type { IntenticApi } from "@intentic/extension-api";

/* The activated host handle. `activate(api)` binds it once, before any view renders, so the extension's
 * composables reach the authenticated daemon transport, cache scoping and capability facts through `host()` —
 * the ambient handle, the way `vscode.*` is ambient to a VSCode extension. Not app internals: everything flows
 * through the public IntenticApi. */
let current: IntenticApi | undefined;

export const bindHost = (api: IntenticApi): void => {
    current = api;
};

export const host = (): IntenticApi => {
    if (current === undefined) {
        throw new Error(`ext-workflows: host() called before activate()`);
    }
    return current;
};
