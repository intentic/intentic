/* Where a WINDOW's own state lives between page loads, the open chat tabs, the workspace's editor tabs, the
 * file tree's expanded folders. All of it answers "what was this window showing", which is why it is stored the
 * same way everywhere:
 *
 *   · sessionStorage, this window's own state. Per browser tab, and it survives a reload (including the dev
 *     server's live-reload and a crash restore), which is exactly the lifetime a window's view has. This is the
 *     authority: what this window restores is what this window last showed.
 *   · localStorage, the same blob as a SEED, read only by a window that has never held this state. It is how
 *     "open the app, everything is still there" survives closing the browser.
 *
 * One shared key for both roles is what the split fixes. Every open window rewrites its state on every change,
 * so with several windows open the last writer won and a window came back from a reload wearing another
 * window's tabs and another window's open folders. Windows are supposed to differ, the daemon multiplexes
 * attach streams and the presence roster counts viewers per connection precisely so two windows can sit on
 * different work, and their view state differs with them. The seed write stays last-writer-wins, which is
 * harmless: no window ever reads it back while it is open.
 *
 * Storage can be missing entirely (private mode, disabled site data) and merely TOUCHING it throws there, so
 * both accessors are guarded: a read degrades to "no state" and a write to a no-op, which leaves exactly the
 * in-memory state this window already holds. */

const readFrom = (storage: () => Storage, key: string): string | null => {
    try {
        return storage().getItem(key);
    } catch {
        return null;
    }
};

const writeTo = (storage: () => Storage, key: string, json: string): void => {
    try {
        storage().setItem(key, json);
    } catch {
        // Unavailable or over quota; the in-memory state still holds for the life of the window.
    }
};

// This window's state, else the last window's (the seed) when this one has never held it. `parse` owns what a
// usable blob is and is tried against each store in turn, so a session blob this build can no longer read falls
// through to the seed rather than starting the window empty.
export const readWindowState = <T>(key: string, parse: (raw: string) => T | undefined): T | undefined => {
    // Thunks, not values: naming `sessionStorage` at all is what throws where site data is off, so each access
    // has to happen inside readFrom's try.
    for (const storage of [(): Storage => sessionStorage, (): Storage => localStorage]) {
        const raw = readFrom(storage, key);
        const parsed = raw === null ? undefined : parse(raw);
        if (parsed !== undefined) {
            return parsed;
        }
    }
    return undefined;
};

// Persist this window's state, and re-seed the next fresh window with it. Takes the serialized JSON because
// every caller watches that string: it is what makes "anything changed" a single cheap comparison, so
// re-serializing here would only repeat it.
export const writeWindowState = (key: string, json: string): void => {
    writeTo(() => sessionStorage, key, json);
    writeTo(() => localStorage, key, json);
};
