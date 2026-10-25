// Vite can re-evaluate a singleton below an HMR boundary while other modules retain the old instance, splitting state.
// hot.accept misses that path, so track evaluated modules on globalThis (which survives this module's re-evaluation)
// and reload on a second evaluation. Dev only: import.meta.hot is absent in production and tests.

declare global {
    // Lives on the window, not this module, since this module is itself re-evaluated by the updates it exists to
    // catch.
    // a `declare global` ambient must use var to reach globalThis
    var intenticSingletonModules: Set<string> | undefined;
}

// Strips Vite's `?t=<stamp>` from a re-executed module's url, so every evaluation of it still names the same
// module.
const moduleId = (url: string): string => url.split(`?`)[0] ?? url;

export const reloadOnHotUpdate = (meta: ImportMeta): void => {
    const hot = meta.hot;
    if (hot === undefined) {
        return;
    }
    // The boundary case: this file was edited, so the update is addressed to it.
    hot.accept(() => window.location.reload());
    // …and the chain case: this module was re-run to serve somebody else's update.
    const already = (globalThis.intenticSingletonModules ??= new Set<string>());
    const id = moduleId(meta.url);
    if (already.has(id)) {
        window.location.reload();
        return;
    }
    already.add(id);
};
