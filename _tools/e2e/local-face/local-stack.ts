import { type ChildProcessWithoutNullStreams, spawn } from "node:child_process";
import { createReadStream, statSync } from "node:fs";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { extname, join, normalize, sep } from "node:path";
import { createInterface } from "node:readline";
import { repoRoot } from "@intentic/constants/node";

// What a desktop window on a folder stands on, minus Tauri: the app's bundle served the way its asset protocol serves
// it, and the intentic-files sidecar started and granted a folder the way src-tauri/src/local.rs does.

const REPO = repoRoot(import.meta.url);
export const FACE_PACKAGE = join(REPO, `_editor/desktop-app`);
const FACE_DIR = join(FACE_PACKAGE, `dist/files`);
export const FACE_BUILD = join(FACE_DIR, `local.html`);
const SIDECAR_CLI = join(REPO, `_devices/local-files/src/cli.ts`);

// The window's facts as local.rs `face_of` writes them into `window.__INTENTIC_LOCAL__`: the editor's `LocalFace`
// (_editor/web/src/app/environments/local.ts), which this package does not depend on.
export interface LocalFace {
    readonly daemonUrl: string;
    readonly token: string;
    readonly id: string;
    readonly name: string;
    readonly path: string;
    readonly file?: string;
    readonly sandbox?: boolean;
}

// The bundle is built under `/files/` (vite.local.config.ts `base`), where the app serves it.
const BASE = `/files/`;

const TYPES = new Map([
    [`.html`, `text/html; charset=utf-8`],
    [`.js`, `text/javascript; charset=utf-8`],
    [`.mjs`, `text/javascript; charset=utf-8`],
    [`.css`, `text/css; charset=utf-8`],
    [`.json`, `application/json`],
    [`.webmanifest`, `application/manifest+json`],
    [`.wasm`, `application/wasm`],
    [`.svg`, `image/svg+xml`],
    [`.png`, `image/png`],
    [`.ico`, `image/x-icon`],
    [`.woff`, `font/woff`],
    [`.woff2`, `font/woff2`],
    [`.ttf`, `font/ttf`],
]);

export interface FaceServer {
    readonly origin: string;
    // Where the app opens a window on a folder (windows.rs `show_files_window`).
    readonly page: string;
    readonly close: () => Promise<void>;
}

// A file of the bundle at `path`, resolved as Tauri's asset protocol resolves one (tauri-utils `get_asset`): the path,
// then `<path>.html` (which is how `files/local` opens `files/local.html`), then `<path>/index.html`.
const bundled = (path: string): string | undefined => {
    if (!path.startsWith(BASE)) {
        return undefined;
    }
    const relative = normalize(path.slice(BASE.length)).replace(/\/$/u, ``);
    return [relative, `${relative}.html`, join(relative, `index.html`)]
        .map((candidate) => join(FACE_DIR, candidate))
        .find((candidate) => candidate.startsWith(`${FACE_DIR}${sep}`) && statSync(candidate, { throwIfNoEntry: false })?.isFile() === true);
};

// `dist/files` as the app's asset protocol answers it. Where the protocol finds nothing it answers the bundle's own
// page with a 200, never a 404 (the page reads `/build.json` there, and gets HTML it ignores), and so does this, with
// the one page this run builds (`local.html`, the build's `onePage` answer to any document request).
export const serveFace = async (): Promise<FaceServer> => {
    const server = createServer((request, response) => {
        const file = bundled(decodeURIComponent(new URL(request.url ?? `/`, `http://127.0.0.1`).pathname)) ?? FACE_BUILD;
        response.writeHead(200, { "content-type": TYPES.get(extname(file)) ?? `application/octet-stream`, "cache-control": `no-store` });
        createReadStream(file).pipe(response);
    });
    await new Promise<void>((resolve) => server.listen(0, `127.0.0.1`, resolve));
    // SAFETY: a TCP listener's address is an AddressInfo; only one on a pipe or socket path is a string.
    const origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    return {
        origin,
        page: `${origin}${BASE}local`,
        close: async () => {
            server.closeAllConnections();
            await new Promise((resolve) => server.close(resolve));
        },
    };
};

// What the sidecar says on stdout (_devices/local-files/src/control.ts `ControlEvent`).
type SidecarEvent =
    | { readonly event: `ready`; readonly port: number }
    | { readonly event: `granted`; readonly token: string; readonly root: string; readonly name: string; readonly file?: string }
    | { readonly event: `refused`; readonly token: string; readonly error: string }
    | { readonly event: `revoked`; readonly token: string };

// The folder served and its name, which the app writes into the window's face.
export interface Granted {
    readonly root: string;
    readonly name: string;
}

export interface Sidecar {
    readonly url: string;
    // Writes a grant line on the sidecar's stdin and resolves with what it answered.
    readonly grant: (ask: {
        readonly token: string;
        readonly id: string;
        readonly path: string;
        readonly kind: `folder` | `file`;
    }) => Promise<Granted>;
    // Everything it wrote to stderr: the "no route for" and "is left out" lines name what it did not serve.
    readonly log: () => string;
    readonly stop: () => Promise<void>;
}

// Hang bound for the process to listen and for a grant's answer; either takes well under a second when it works.
const SIDECAR_WAIT_MS = 30_000;

// The real CLI from source, as the package's own suites run it (the app bundles the same entry compiled by
// stage-local-files.sh). `origin` is the one page origin it answers, as the app passes its own.
export const startSidecar = async (origin: string, scratch: string): Promise<Sidecar> => {
    const child: ChildProcessWithoutNullStreams = spawn(
        `bun`,
        [
            `--conditions=@intentic/src`,
            SIDECAR_CLI,
            `serve`,
            `--origin`,
            origin,
            `--cache`,
            join(scratch, `office-cache`),
            `--office-page`,
            join(scratch, `office-page`),
        ],
        { cwd: join(REPO, `_devices/local-files`), stdio: [`pipe`, `pipe`, `pipe`] },
    );
    let stderr = ``;
    child.stderr.on(`data`, (chunk: Buffer) => {
        stderr += chunk.toString();
    });
    const listeners = new Set<(event: SidecarEvent) => void>();
    createInterface({ input: child.stdout }).on(`line`, (line) => {
        // SAFETY: the sidecar writes nothing to stdout but `controlLine(event)`, one ControlEvent per line (control.ts).
        const event = JSON.parse(line) as SidecarEvent;
        listeners.forEach((listener) => listener(event));
    });
    const exited = new Promise<void>((resolve) => child.once(`exit`, () => resolve()));

    const next = <Picked extends SidecarEvent>(pick: (event: SidecarEvent) => event is Picked, what: string): Promise<Picked> =>
        new Promise((resolve, reject) => {
            const timer = setTimeout(
                () => settle(new Error(`the sidecar did not ${what} within ${SIDECAR_WAIT_MS / 1000}s:\n${stderr}`)),
                SIDECAR_WAIT_MS,
            );
            const onExit = (code: number | null): void =>
                settle(new Error(`the sidecar exited (${String(code)}) before it would ${what}:\n${stderr}`));
            const listener = (event: SidecarEvent): void => {
                if (pick(event)) {
                    settle(event);
                }
            };
            const settle = (outcome: Picked | Error): void => {
                clearTimeout(timer);
                listeners.delete(listener);
                child.off(`exit`, onExit);
                if (outcome instanceof Error) {
                    reject(outcome);
                } else {
                    resolve(outcome);
                }
            };
            listeners.add(listener);
            child.once(`exit`, onExit);
        });

    const ready = await next((event): event is Extract<SidecarEvent, { event: `ready` }> => event.event === `ready`, `say where it listens`);
    return {
        url: `http://127.0.0.1:${ready.port}`,
        grant: async (ask) => {
            const answer = next(
                (event): event is Extract<SidecarEvent, { event: `granted` | `refused` }> =>
                    (event.event === `granted` || event.event === `refused`) && event.token === ask.token,
                `answer the grant for ${ask.path}`,
            );
            child.stdin.write(`${JSON.stringify({ op: `grant`, ...ask })}\n`);
            const answered = await answer;
            if (answered.event === `refused`) {
                throw new Error(`the sidecar refused ${ask.path}: ${answered.error}`);
            }
            return { root: answered.root, name: answered.name };
        },
        log: () => stderr,
        // Closing stdin is how the app lets go of it: the process exits on its own (cli.ts).
        stop: async () => {
            if (child.exitCode === null) {
                child.stdin.end();
                await exited;
            }
        },
    };
};
