import { randomBytes } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import type { BrowserEngine } from "./browser-engine.js";
import { createListener, type Listener, type ListenerSessions } from "./listener.js";
import type { Session, Sessions } from "./sessions.js";

// THE ONE LISTENER every folder's browser engine is served by on the user's own computer (local-office.ts), on the port
// it had last run. The editor's files go out cacheable for a year under the listener's origin, so a second window, and
// the first one after the app restarts, loads them from the browser's cache with their compiled code instead of reading,
// sending and compiling the whole editor again. _(2026-11-09) A listener per window on a fresh port made every window a
// new origin with nothing cached._

/** A folder's engine and the sessions it opened, as the listener finds them. */
export interface FolderEngine {
    readonly engine: BrowserEngine;
    readonly sessions: Sessions;
}

export interface FolderListenerDeps {
    // The engines whose start finished: where a session's own engine is found.
    readonly engines: () => Iterable<FolderEngine>;
    // Where the port is remembered across runs.
    readonly portFile: string;
    readonly log: (line: string) => void;
}

export interface FolderListener {
    // Where the browser reaches the listener, opened on first ask; a listener that could not open is tried again by the
    // next ask rather than remembered.
    readonly origin: () => Promise<string>;
    readonly close: () => Promise<void>;
}

// The port the listener had last run, or 0 (any) when none is remembered or the file says something else.
const rememberedPort = async (file: string): Promise<number> => {
    try {
        const port = Number((await readFile(file, "utf8")).trim());
        return Number.isInteger(port) && port > 0 && port < 65_536 ? port : 0;
    } catch {
        // allow(silent-catch): a first run, or a file that cannot be read, takes any port, as nothing was remembered.
        return 0;
    }
};

export const createFolderListener = (deps: FolderListenerDeps): FolderListener => {
    const ownerOf = (token: string): FolderEngine | undefined => [...deps.engines()].find(({ sessions }) => sessions.session(token) !== undefined);
    // Every folder's sessions as the listener asks for them. No document server runs here, so nothing asks for a key.
    const sessions: ListenerSessions = {
        session: (token) => ownerOf(token)?.sessions.session(token),
        document: () => undefined,
        saved: () => undefined,
        closed: () => undefined,
    };

    const open = async (): Promise<{ listener: Listener; origin: string }> => {
        const listener = createListener({
            // Nothing signs callbacks here, since no document server runs; a secret nobody holds refuses any that arrive.
            secret: randomBytes(32).toString("hex"),
            sessions,
            host: "127.0.0.1",
            documentServerPort: () => undefined,
            // The listener asks only for a session it found among the engines, so its engine is there.
            pageFor: async (session: Session) => {
                const owner = ownerOf(session.token);
                if (owner === undefined) {
                    throw new Error("that document's window has closed");
                }
                return owner.engine.page(session);
            },
            refresh: async () => undefined,
            readDocument: async () => undefined,
            saveDocument: async () => {
                throw new Error("no document server runs on this computer");
            },
            // A session's file goes to its own engine; the editor's files are the same bundle whichever engine serves them.
            browser: async (req, res, url) => {
                const token = url.searchParams.get("s");
                const owner = (token === null ? undefined : ownerOf(token)) ?? deps.engines()[Symbol.iterator]().next().value;
                return owner === undefined ? false : owner.engine.routes(req, res, url);
            },
            log: (line) => deps.log(`[office listener] ${line}`),
        });
        const wanted = await rememberedPort(deps.portFile);
        const port = await listener.listen(wanted);
        if (port !== wanted) {
            await writeFile(deps.portFile, `${port}\n`).catch((error: Error) => deps.log(`[office] the listener's port could not be remembered: ${error.message}`));
        }
        return { listener, origin: `http://127.0.0.1:${port}` };
    };

    let opened: ReturnType<typeof open> | undefined;
    const ensure = (): ReturnType<typeof open> => {
        if (opened === undefined) {
            const opening = open();
            opened = opening;
            opening.catch(() => {
                if (opened === opening) {
                    opened = undefined;
                }
            });
        }
        return opened;
    };

    return {
        origin: async () => (await ensure()).origin,
        close: async () => {
            const closing = opened;
            opened = undefined;
            // allow(silent-catch): a listener that never opened has nothing to close, and closing is all that is left to do.
            await closing?.then(({ listener }) => listener.close()).catch(() => undefined);
        },
    };
};
