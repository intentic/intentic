import type { IntenticApi } from "@intentic/extension-api";

/* The activated host handle. `activate(api)` binds it once, before any view can render, a view is registered
 * during activate and mounted later, so the composables below reach the authenticated daemon transport and the
 * per-sandbox cache scoping through `host()`, the way `vscode.*` is ambient to a VSCode extension.
 *
 * There is no global to reach for instead: the host hands the api in as an argument precisely so an extension
 * cannot acquire more reach than the manifest it was approved under. */
let current: IntenticApi | undefined;

export const bindHost = (api: IntenticApi): void => {
    current = api;
};

export const host = (): IntenticApi => {
    if (current === undefined) {
        throw new Error(`intentic.example: host() called before activate()`);
    }
    return current;
};
