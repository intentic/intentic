import type { LocalOffice } from "@intentic/ext-onlyoffice/local-office";
import { unstubbed } from "@intentic/testing";
import type { Grants } from "./grants.js";
import { createLocalFilesServer, type LocalFilesServer, type ServerDeps } from "./server.js";
import { Watches } from "./watch.js";

// The HTTP face stood up the way cli.ts stands it up, for suites that drive it as the editor does.

export const PORT = 47001;
export const APP = `tauri://localhost`;

// Office routes are the extension's own (onlyoffice/src/server/local-office.ts); all a suite here reaches of it is the
// release of a window's editor when its grant goes.
const office = unstubbed<LocalOffice>(`office`, { release: async () => undefined });

export const localServer = (grants: Grants, overrides: Pick<ServerDeps, `writeCap`> = {}): LocalFilesServer =>
    createLocalFilesServer({
        grants,
        office,
        context: { watches: new Watches(() => undefined), build: `test`, startedAt: 0 },
        origins: new Set([APP]),
        log: () => undefined,
        ...overrides,
    });

export interface Ask extends RequestInit {
    readonly token?: string;
    readonly host?: string;
    readonly origin?: string;
}

// A request as a window's editor sends it: to this port, with the window's bearer and page origin when given.
export const askerOf =
    (server: LocalFilesServer) =>
    (path: string, init: Ask = {}): Promise<Response> => {
        const headers = new Headers(init.headers);
        headers.set(`host`, init.host ?? `127.0.0.1:${PORT}`);
        if (init.token !== undefined) {
            headers.set(`authorization`, `Bearer ${init.token}`);
        }
        if (init.origin !== undefined) {
            headers.set(`origin`, init.origin);
        }
        return server.fetch(new Request(`http://127.0.0.1:${PORT}${path}`, { ...init, headers }), PORT);
    };
