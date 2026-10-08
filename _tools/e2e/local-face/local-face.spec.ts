import { randomBytes } from "node:crypto";
import { readFileSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { repoRoot } from "@intentic/constants/node";
import { expect, type Page, test } from "@playwright/test";
import { type FaceServer, type LocalFace, type Sidecar, serveFace, startSidecar } from "./local-stack.js";

// A window on a folder, end to end: the built local face over a real sidecar, granted a temp folder. It fails on what an
// editor refactor breaks without touching this package: a boot that throws, a screen that no longer lists or saves,
// and an always-mounted composable reading a route the sidecar does not serve (a 404 the page shrugs off).

// The two labels the spec finds controls by, read from the editor's English catalogue rather than copied out of it, so
// a reworded label moves with the page. Asserted to be strings before anything is found by them.
interface Labels {
    readonly local: { readonly localFiles: { readonly toggleFolder: string } };
    readonly shared: { readonly files: string };
    readonly workspace: { readonly fileViewer: { readonly saveFile: string } };
    readonly shell: { readonly notificationSources: { readonly fasterSandboxRunsOn: string } };
}
// SAFETY: the editor's own catalogue, nested objects of strings; a key gone from it reads as undefined, which the first
// step's assertion names.
const EN = JSON.parse(readFileSync(join(repoRoot(import.meta.url), `_editor/web/src/app/i18n/locales/en.json`), `utf8`)) as Labels;
const TOGGLE_FOLDER = EN.local.localFiles.toggleFolder;
const FILES = EN.shared.files;
const SAVE_FILE = EN.workspace.fileViewer.saveFile;
// The offer of a faster way to a sandbox on this device, which a folder, on loopback already, is never made.
const LOOPBACK_OFFER = EN.shell.notificationSources.fasterSandboxRunsOn;

const FOLDER = {
    "README.md": `# A folder on this computer\n\nOpened in the desktop app's local face.\n`,
    "docs/guide.md": `# Guide\n\nOne level down.\n`,
    "hello.txt": `hello from disk\n`,
} satisfies Readonly<Record<string, string>>;
const TYPED = `edited in the local face`;
// A second folder, for the window to be pointed at in the first one's place.
const OTHER_FOLDER = {
    "notes.md": `# Notes\n`,
    "src/main.ts": `export {};\n`,
} satisfies Readonly<Record<string, string>>;

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
let other: LocalFace;

// What the app's local.rs `face_pointed` runs in a window pointed at another folder: the face kept for the window's
// reloads, offered to the page, and reloaded onto only when the page does not take it. Answers whether it was taken.
const pointAt = (face: LocalFace): boolean => {
    try {
        window.sessionStorage.setItem(`intentic.local.face`, JSON.stringify(face));
    } catch {
        // allow(silent-catch): local.rs swallows a refused storage the same way.
    }
    const taken = !window.dispatchEvent(new CustomEvent(`intentic:repoint`, { cancelable: true, detail: face }));
    if (!taken) {
        window.history.replaceState(null, ``, `${window.location.pathname}#/workspace`);
        window.location.reload();
    }
    return taken;
};

// One painted frame, as a reader would see it: the rail, the folder named at the head of the explorer, its tree's rows,
// and whether a sandbox's loopback offer was up.
interface Frame {
    readonly rail: boolean;
    readonly folder: string;
    readonly rows: number;
    readonly offer: boolean;
}
declare global {
    interface Window {
        __frames?: Frame[];
        __sameLoad?: boolean;
    }
}

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

    const otherFolder = join(scratch, `Other Folder`);
    for (const [path, text] of Object.entries(OTHER_FOLDER)) {
        await mkdir(dirname(join(otherFolder, path)), { recursive: true });
        await writeFile(join(otherFolder, path), text);
    }
    const otherToken = randomBytes(24).toString(`base64url`);
    const otherGranted = await sidecar.grant({ token: otherToken, id: `e2e-other-folder`, path: otherFolder, kind: `folder` });
    other = { daemonUrl: sidecar.url, token: otherToken, id: `e2e-other-folder`, name: otherGranted.name, path: otherGranted.root, sandbox: false };
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
    const ours = (url: URL): boolean =>
        url.origin === bundle.origin || url.origin === sidecar.url || url.protocol === `data:` || url.protocol === `blob:`;
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
        expect
            .soft(unserved, `the page asked the sidecar for routes it does not serve:\n${unserved.join(`\n`)}\n\nits log:\n${refusals.join(`\n`)}`)
            .toEqual([]);
        expect.soft(seen.failed, `requests to the sidecar that failed`).toEqual([]);
        expect.soft(seen.foreign, `requests that would have left the machine`).toEqual([]);
        // A run that reached the sidecar at all, so the two checks above are about something.
        expect(seen.sidecar.length).toBeGreaterThan(0);
    });

    expect(seen.errors, `uncaught errors and console errors`).toEqual([]);
});

test(`another folder pointed at in the window's place takes it in place: no reload, and no frame blank or half drawn`, async ({ page }) => {
    const seen = await record(page);
    await page.addInitScript({ content: `window.__INTENTIC_LOCAL__ = Object.freeze(${JSON.stringify(local)});` });
    const row = (name: string) => page.getByRole(`treeitem`, { name, exact: true });
    await page.goto(bundle.page);
    await expect(row(`hello.txt`)).toBeVisible();

    // Every frame painted from here on, and a mark only this load of the page carries: a reload would drop both.
    const watchFrames = async (): Promise<void> =>
        page.evaluate((offer) => {
            const frames: Frame[] = [];
            window.__frames = frames;
            window.__sameLoad = true;
            const paint = (): void => {
                frames.push({
                    rail: document.querySelector(`nav.icon-rail`) !== null,
                    folder: document.querySelector(`aside [aria-haspopup="menu"]`)?.textContent?.trim() ?? ``,
                    rows: document.querySelectorAll(`[role="treeitem"]`).length,
                    offer: document.body.textContent?.includes(offer) === true,
                });
                requestAnimationFrame(paint);
            };
            requestAnimationFrame(paint);
        }, LOOPBACK_OFFER);
    // The frames since `watchFrames`, checked: the shell in every one, and the arriving folder never named over an empty tree.
    const expectNoBlankFrame = async (arriving: string): Promise<void> => {
        expect(await page.evaluate(() => window.__sameLoad), `the page was reloaded`).toBe(true);
        const frames = (await page.evaluate(() => window.__frames)) ?? [];
        expect(frames.filter((frame) => !frame.rail), `frames painted without the shell's rail`).toEqual([]);
        const arrived = frames.filter((frame) => frame.folder === arriving);
        expect(arrived.length).toBeGreaterThan(0);
        expect(arrived.filter((frame) => frame.rows === 0), `frames naming ${arriving} over an empty tree`).toEqual([]);
        // Nothing a sandbox has that a folder does not: a folder is on loopback already, so no faster way is offered.
        expect(frames.filter((frame) => frame.offer), `frames offering ${arriving} a faster way to a sandbox`).toEqual([]);
    };

    await test.step(`the page takes the folder the app points it at`, async () => {
        await watchFrames();
        expect(await page.evaluate(pointAt, other)).toBe(true);
    });

    await test.step(`its files take the first folder's place, on the folder's own screen and title`, async () => {
        await expect(row(`notes.md`)).toBeVisible();
        await expect(row(`src`)).toBeVisible();
        await expect(row(`hello.txt`)).toHaveCount(0);
        await expect(page.getByRole(`complementary`).getByText(other.name, { exact: true })).toBeVisible();
        await expect(page).toHaveTitle(new RegExp(other.name));
        expect(new URL(page.url()).hash).toBe(`#/workspace`);
    });

    await test.step(`with no reload, the shell in every frame, and no frame of the new folder half drawn`, async () => {
        // Long enough for anything the folder's arrival sets off to have drawn (a sandbox's loopback offer came at ~50 ms).
        await page.waitForTimeout(500);
        await expectNoBlankFrame(other.name);
    });

    await test.step(`and back, with motion off: a cut rather than a crossfade, still between two whole pages`, async () => {
        await page.emulateMedia({ reducedMotion: `reduce` });
        await watchFrames();
        expect(await page.evaluate(pointAt, local)).toBe(true);
        await expect(row(`hello.txt`)).toBeVisible();
        await expect(row(`notes.md`)).toHaveCount(0);
        await expectNoBlankFrame(local.name);
    });

    expect.soft(seen.failed, `requests to the sidecar that failed`).toEqual([]);
    expect(seen.errors, `uncaught errors and console errors`).toEqual([]);
});
