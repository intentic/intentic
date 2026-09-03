/* A MODULE THAT MUST EXIST ONCE PER WINDOW, told to the dev server's hot updater.
 *
 * Several composables here are singletons by construction: one BroadcastChannel listening for the app's other
 * windows (chat/chatChannel.ts, floating.ts), one tab store the whole window renders from (chat/useChat.ts).
 * Vite's hot update re-executes a changed module, and everything between it and the nearest component that
 * accepts updates, as NEW module instances, while every module outside that path keeps importing the old ones.
 * For a stateless module that is invisible. For these it is a second channel and a second store in the same
 * window: the browser's message listener still belongs to the first instance and feeds readers of the first
 * store, while the panel, re-imported along the same path, renders the second. Every note from the other windows
 * then lands on a store nobody is looking at, which from the outside is a popped-out chat that ignores the board
 * until somebody reloads it. The board's own symptom was an injection key minted twice, "a chat surface was
 * mounted outside a ChatPane": a pane providing one useChat's symbol to children reading another's.
 *
 * So these modules accept their own hot updates by RELOADING THE PAGE, the only update a singleton can honestly
 * apply. Accepting also makes the module a boundary for whatever it imports, so a change to a dependency reloads
 * too rather than propagating past it to a component that would swap in a half-new graph. Dev only:
 * `import.meta.hot` is undefined in a production build and in tests, and this is a no-op there. */
export const reloadOnHotUpdate = (hot: ImportMeta["hot"]): void => {
    hot?.accept(() => window.location.reload());
};
