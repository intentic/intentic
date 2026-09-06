/* A MODULE THAT MUST EXIST ONCE PER WINDOW, told to the dev server's hot updater.
 *
 * Several composables here are singletons by construction: one BroadcastChannel listening for the app's other
 * windows (chat/chatChannel.ts, floating.ts, mainWindow.ts), one tab store the whole window renders from
 * (chat/useChat.ts), one reader per note kind (chat/summon.ts and its siblings). Vite's hot update re-executes
 * a changed module, and everything between it and the nearest accepting boundary, as NEW module instances,
 * while every module outside that path keeps importing the old ones. For a stateless module that is invisible.
 * For these it is a second channel and a second store in the same window: the browser's message listener still
 * belongs to the first instance and feeds readers of the first store, while the panel, re-imported along the
 * same path, renders the second. Every note from the other windows then lands on a store nobody is looking at,
 * which from the outside is a popped-out chat that ignores the board until somebody reloads it. The board's own
 * symptom was an injection key minted twice, "a chat surface was mounted outside a ChatPane": a pane providing
 * one useChat's symbol to children reading another's.
 *
 * So these modules answer a hot update by RELOADING THE PAGE, the only update a singleton can honestly apply.
 *
 * TWO WAYS THE UPDATE ARRIVES, AND ACCEPTING ONLY COVERS ONE. `hot.accept` fires when this module is the
 * BOUNDARY the update was routed to, which is the case when the file itself was edited. It does not fire when
 * the module is merely re-evaluated ON THE WAY to a boundary further up, which is what Vite does to the whole
 * chain between a changed dependency and the component that accepts for it: the body runs again, a second
 * instance exists, and no callback of ours is ever called. That is the case this file used to miss, and it is
 * the common one — the singletons here sit under half the chat's components, so almost every edit in the panel
 * re-evaluates them on its way to an SFC. The two symptoms above were both observed on a build carrying the
 * accept.
 *
 * So the invariant is checked rather than delegated: the window remembers which of these modules it has already
 * run, and a second evaluation of one reloads on the spot, whatever route the update took to get here. The
 * record lives on the window and not in this module, because this module is re-evaluated by the very updates it
 * exists to catch — a module-level Set would be duplicated along with everything else and would remember
 * nothing.
 *
 * Dev only: `import.meta.hot` is undefined in a production build and in tests, where a module runs once by
 * construction and there is nothing to guard. */

declare global {
    // Set on the window itself: see above for why it cannot live in this module. `var` is what puts it on
    // globalThis rather than in a module scope.
    // oxlint-disable-next-line eslint/no-var -- a `declare global` ambient must use var to reach globalThis
    var intenticSingletonModules: Set<string> | undefined;
}

// The module, without the `?t=<stamp>` Vite hangs on a re-executed one: with the stamp left on, every
// evaluation would name a different module and the record would never match.
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
