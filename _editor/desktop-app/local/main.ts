import type { LocalFace } from "@intentic/web/local";
import { installHost } from "../src/host";
import { registerDesktopCatalog } from "../src/i18n";
import { installPlatform, LOCAL_EMAIL, sandboxIdOf } from "./platform";
import { editorChunk, FACE_EVENT, faceArrives, warmModule } from "./warm";

// The local face's entry: what must be true before the editor's own entry runs, the way the demo prepares it
// (_site/demo/src/main.ts), with the app's intentic-files sidecar standing where the demo's fixture daemon stands. The
// window's credentials are written where the editor already reads them, never faked past it.

// A dev server has no app to inject the window's facts, so it takes them from the address instead
// (`/files/local?daemon=…&token=…&id=…&name=…&path=…[&file=…][&home=1]`), and keeps them for the tab's reloads, since
// the address is rewritten below; a build only ever reads the app's.
const DEV_FACE_KEY = `intentic.local.devFace`;
const devFace = (): LocalFace | undefined => {
    if (!import.meta.env.DEV) {
        return undefined;
    }
    const query = new URL(window.location.href).searchParams;
    const [daemonUrl, token, id, name, path] = [`daemon`, `token`, `id`, `name`, `path`].map((key) => query.get(key) ?? undefined);
    if (daemonUrl === undefined || token === undefined || id === undefined || name === undefined || path === undefined) {
        const kept = sessionStorage.getItem(DEV_FACE_KEY);
        // SAFETY: the tab's own storage, written below from a face this function built; a dev server's tab only.
        return kept === null ? undefined : (JSON.parse(kept) as LocalFace);
    }
    const face: LocalFace = { daemonUrl, token, id, name, path, file: query.get(`file`) ?? undefined, home: query.get(`home`) === `1` };
    sessionStorage.setItem(DEV_FACE_KEY, JSON.stringify(face));
    return face;
};

// The editor's entry, imported only once the window has a face. A function the boot calls rather than an import
// statement, so that a window still waiting for its face can name the editor's chunk without running it (warm.ts).
const loadEditor = async (): Promise<void> => {
    await import(`@intentic/web/main`);
};

// A dev server in a browser has no app behind it: the app's commands are answered by a stand-in (devDesktop.ts), so the
// shell and This device can be looked at. Never in a build, and never inside the app itself.
const standInForTheApp = async (): Promise<void> => {
    if (import.meta.env.DEV && !(`__TAURI_INTERNALS__` in window)) {
        const { installDevDesktop } = await import(`./devDesktop`);
        installDevDesktop();
    }
};

const boot = async (face: LocalFace): Promise<void> => {
    window.__INTENTIC_LOCAL__ = face;
    const id = sandboxIdOf(face);
    localStorage.setItem(`intentic.activeSandboxId`, id);
    localStorage.setItem(`intentic.session.${id}`, JSON.stringify({ token: face.token, expiresAt: Date.now() + 365 * 86_400_000, email: LOCAL_EMAIL }));
    // The loopback shortcut is for reaching a sandbox faster; the sidecar is already on loopback.
    localStorage.setItem(`intentic.localShortcut.declined.${id}`, `yes`);
    installPlatform(face);
    await standInForTheApp();
    // The app's own words (This device, the tile it adds), registered before the editor starts its languages, and its
    // half of the shell, on the window before the router reads it (src/host.ts).
    await registerDesktopCatalog();
    installHost(face);
    // The local page's one address, whatever the window was opened at: the app answers `files/local` with this page and
    // nothing below it. The screen the window was on rides the hash (the editor's router keeps its route there).
    window.history.replaceState(window.history.state, ``, `${import.meta.env.BASE_URL}local${window.location.hash}`);
    await loadEditor();
};

// While a window waits for its face, the webview can already fetch and compile the editor's chunk, so the face lands
// on a page with only the running left to do. A build only: the dev server names its modules by path, and serves them
// fast enough. Anything that goes wrong here is the warm-up's loss alone, never the window's.
const warmEditor = (): void => {
    if (import.meta.env.DEV) {
        console.warn(`This window has no folder yet. It waits for the app's ${FACE_EVENT}, or opens with ?daemon=…&token=…&id=…&name=…&path=…`);
        return;
    }
    try {
        const chunk = editorChunk(loadEditor.toString(), import.meta.url);
        if (chunk !== undefined) {
            warmModule(chunk, document);
        }
    } catch (error) {
        console.warn(`[local] the editor could not be warmed; it loads when the folder arrives:`, error);
    }
};

const given = window.__INTENTIC_LOCAL__ ?? devFace();
if (given === undefined) {
    warmEditor();
}
await boot(given ?? (await faceArrives(window)));
