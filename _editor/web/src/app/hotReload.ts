// Several composables here are per-window singletons (channel listeners in chat/chatChannel.ts, floating.ts,
// mainWindow.ts; the tab store in chat/useChat.ts; per-kind note readers in chat/summon.ts). Vite's hot update
// re-executes a changed module and everything up to the accepting boundary as new instances, while modules outside
// that chain keep the old ones — for a singleton that means a second channel or store in the same window, silently
// ignoring the first's messages.
//
// `hot.accept` only fires when this module is itself the boundary the update was routed to (the file was edited
// directly); it does not fire when the module is merely re-evaluated on the way to a boundary further up, which is
// the common case here since these singletons sit under most of the chat's components. So the invariant is checked
// rather than delegated: the window remembers (on `globalThis`, not module scope, since this module is itself
// re-evaluated by the updates it catches) which modules it has already run, and a second evaluation reloads the
// page immediately, whichever route the update took.
//
// Dev only: `import.meta.hot` is undefined in production and in tests, where a module runs once by construction.

declare global {
    // Lives on the window, not this module, since this module is itself re-evaluated by the updates it exists to
    // catch.
    // oxlint-disable-next-line eslint/no-var -- a `declare global` ambient must use var to reach globalThis
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
