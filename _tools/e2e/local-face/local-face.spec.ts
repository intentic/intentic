import { randomBytes } from "node:crypto";
import { readFileSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { repoRoot } from "@intentic/constants/node";
import { expect, type Page, test } from "@playwright/test";
import { type FaceServer, type LocalFace, type Sidecar, serveFace, startSidecar } from "./stack.js";

// A window on a folder, end to end: the built local face over a real sidecar, granted a temp folder. It fails on what an
// editor refactor breaks without touching this package: a boot that throws, a screen that no longer lists or saves,
// and an always-mounted composable reading a route the sidecar does not serve (a 404 the page shrugs off).

// The two labels the spec finds controls by, read from the editor's English catalogue rather than copied out of it, so
// a reworded label moves with the page. Asserted to be strings before anything is found by them.
interface Labels {
    readonly local: { readonly localFiles: { readonly toggleFolder: string } };
    readonly shared: { readonly files: string };
    readonly workspace: { readonly fileViewer: { readonly saveFile: string } };
}
// SAFETY: the editor's own catalogue, nested objects of strings; a key gone from it reads as undefined, which the first
// step's assertion names.
const EN = JSON.parse(readFileSync(join(repoRoot(import.meta.url), `_editor/web/src/app/i18n/locales/en.json`), `utf8`)) as Labels;
const TOGGLE_FOLDER = EN.local.localFiles.toggleFolder;
const FILES = EN.shared.files;
const SAVE_FILE = EN.workspace.fileViewer.saveFile;

const FOLDER = {
    "README.md": `# A folder on this computer\n\nOpened in the desktop app's local face.\n`,
    "docs/guide.md": `# Guide\n\nOne level down.\n`,
    "hello.txt": `hello from disk\n`,
} satisfies Readonly<Record<string, string>>;
const TYPED = `edited in the local face`;

// Console errors that are not the page's fault, each with why. Empty is the goal.
const ALLOWED_CONSOLE_ERRORS: readonly { readonly pattern: RegExp; readonly why: string }[] = [];

interface Answered {
    readonly method: string;
    readonly path: string;
    readonly status: number;
}

interface Seen {
    readonly sidecar: Answered[];
    readonly failed: string[];
    readonly foreign: string[];
    readonly errors: string[];
}

let scratch: string;
let folder: string;
let bundle: FaceServer;
let sidecar: Sidecar;
let local: LocalFace;

test.beforeAll(async () => {
    scratch = await mkdtemp(join(tmpdir(), `intentic-local-face-`));
    folder = join(scratch, `My Folder`);
    for (const [path, text] of Object.entries(FOLDER)) {
        await mkdir(dirname(join(folder, path)), { recursive: true });
        await writeFile(join(folder, path), text);
    }
    bundle = await serveFace();
    sidecar = await startSidecar(bundle.origin, scratch);
    // What the app does on opening a folder (local.rs): a random token and a stable id on the sidecar's stdin, then the
    // window's facts from what the sidecar granted.
    const token = randomBytes(24).toString(`base64url`);
    const id = `e2e-local-face`;
    const granted = await sidecar.grant({ token, id, path: folder, kind: `folder` });
    local = { daemonUrl: sidecar.url, token, id, name: granted.name, path: granted.root, sandbox: false };
});

test.afterAll(async () => {
    await sidecar?.stop();
    await bundle?.close();
    if (scratch !== undefined) {
        await rm(scratch, { recursive: true, force: true });
    }
});

// Everything the page asks of the network, split by who answers: the bundle's server, the sidecar, or anyone else.
const record = async (page: Page): Promise<Seen> => {
    const seen: Seen = { sidecar: [], failed: [], foreign: [], errors: [] };
    const ours = (url: URL): boolean => url.origin === bundle.origin || url.origin === sidecar.url || url.protocol === `data:` || url.protocol === `blob:`;
    // The fake platform origin (local/platform.ts) is answered inside the page's fetch and never reaches here, so any
    // other origin is a request that would leave the machine: recorded, and refused so the run stays hermetic.
    await page.context().route(
        (url) => !ours(url),
        async (route) => {
            seen.foreign.push(`${route.request().method()} ${route.request().url()}`);
            await route.abort(`blockedbyclient`);
        },
    );
    page.on(`websocket`, (socket) => {
        if (!ours(new URL(socket.url()))) {
            seen.foreign.push(`WEBSOCKET ${socket.url()}`);
        }
    });
    page.on(`response`, (response) => {
        const url = new URL(response.url());
        if (url.origin === sidecar.url) {
            seen.sidecar.push({ method: response.request().method(), path: url.pathname, status: response.status() });
        }
    });
    page.on(`requestfailed`, (request) => {
        const url = new URL(request.url());
        // ERR_ABORTED is the page letting go of a request (a superseded read, a stream closed on unload), not a refusal.
        if (url.origin === sidecar.url && request.failure()?.errorText !== `net::ERR_ABORTED`) {
            seen.failed.push(`${request.method()} ${url.pathname}: ${request.failure()?.errorText ?? `failed`}`);
        }
    });
    page.on(`pageerror`, (error) => seen.errors.push(`uncaught: ${error.stack ?? error.message}`));
    page.on(`console`, (message) => {
        if (message.type() === `error` && !ALLOWED_CONSOLE_ERRORS.some(({ pattern }) => pattern.test(message.text()))) {
            const { url, lineNumber } = message.location();
            seen.errors.push(`console: ${message.text()}${url === `` ? `` : ` (${url}:${lineNumber})`}`);
        }
    });
    return seen;
};

test(`a window on a folder lists it, opens, edits and saves a file, and asks the sidecar only for routes it serves`, async ({ page }) => {
    const seen = await record(page);
    // As local.rs writes it: before any of the page's scripts run.
    await page.addInitScript({ content: `window.__INTENTIC_LOCAL__ = Object.freeze(${JSON.stringify(local)});` });

    await test.step(`boots to the local shell, on the folder`, async () => {
        expect({ TOGGLE_FOLDER, FILES, SAVE_FILE }).toEqual({ TOGGLE_FOLDER: expect.any(String), FILES: expect.any(String), SAVE_FILE: expect.any(String) });
        await page.goto(bundle.page);
        await expect(page.getByRole(`button`, { name: TOGGLE_FOLDER })).toBeVisible();
        await expect(page.getByRole(`complementary`).getByText(local.name, { exact: true })).toBeVisible();
        // The shell's rail, as a sandbox's has it: the folder's own tile, lit. With no app behind this page there is no
        // This device tile (src/host.ts keeps the link-only host), and nothing else for it to be.
        await expect(page.getByRole(`navigation`).getByRole(`link`, { name: FILES, exact: true })).toBeVisible();
        // One address for the page, whatever screen it is on: the screen rides the hash (the web's router, a local window).
        expect(new URL(page.url()).pathname).toBe(`/files/local`);
        expect(new URL(page.url()).hash).toBe(`#/workspace`);
    });

    await test.step(`the tree lists the folder`, async () => {
        for (const name of [`README.md`, `docs`, `hello.txt`]) {
            await expect(page.getByRole(`treeitem`, { name, exact: true })).toBeVisible();
        }
        await page.getByRole(`treeitem`, { name: `docs`, exact: true }).click();
        await expect(page.getByRole(`treeitem`, { name: `guide.md`, exact: true })).toBeVisible();
    });

    const editor = page.locator(`.monaco-editor .view-lines`);
    await test.step(`opening the text file shows what is on disk`, async () => {
        await page.getByRole(`treeitem`, { name: `hello.txt`, exact: true }).click();
        await expect(editor).toContainText(`hello from disk`);
    });

    await test.step(`an edit saved from the page lands on disk`, async () => {
        await editor.click();
        await page.keyboard.press(`Control+End`);
        await page.keyboard.type(TYPED);
        const save = page.getByRole(`button`, { name: SAVE_FILE, exact: true });
        await expect(save).toBeEnabled();
        await save.click();
        await expect.poll(async () => readFile(join(folder, `hello.txt`), `utf8`)).toBe(`hello from disk\n${TYPED}\n`);
        await expect(save).toBeDisabled();
    });

    await test.step(`the page asked the sidecar only for what it serves, and nothing else of the network`, async () => {
        const unserved = [...new Set(seen.sidecar.filter(({ status }) => status === 404).map(({ method, path }) => `${method} ${path}`))];
        const refusals = sidecar
            .log()
            .split(`\n`)
            .filter((line) => line.includes(`no route for`) || line.includes(`is left out`));
        expect.soft(unserved, `the page asked the sidecar for routes it does not serve:\n${unserved.join(`\n`)}\n\nits log:\n${refusals.join(`\n`)}`).toEqual([]);
        expect.soft(seen.failed, `requests to the sidecar that failed`).toEqual([]);
        expect.soft(seen.foreign, `requests that would have left the machine`).toEqual([]);
        // A run that reached the sidecar at all, so the two checks above are about something.
        expect(seen.sidecar.length).toBeGreaterThan(0);
    });

    expect(seen.errors, `uncaught errors and console errors`).toEqual([]);
});
