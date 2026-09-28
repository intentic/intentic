import type { LocalFace } from "@intentic/web/local";
import { installPlatform, LOCAL_EMAIL, sandboxIdOf } from "./platform";

// The local face's entry: what must be true before the editor's own entry runs, the way the demo prepares it
// (_site/demo/src/main.ts), with the app's intentic-files sidecar standing where the demo's fixture daemon stands. The
// window's credentials are written where the editor already reads them, never faked past it.

// A dev server has no app to inject the window's facts, so it takes them from the address instead
// (`/files/local?daemon=…&token=…&id=…&name=…&path=…[&file=…]`), and keeps them for the tab's reloads, since the
// address is rewritten below; a build only ever reads the app's.
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
    const face: LocalFace = { daemonUrl, token, id, name, path, file: query.get(`file`) ?? undefined };
    sessionStorage.setItem(DEV_FACE_KEY, JSON.stringify(face));
    return face;
};

const face = window.__INTENTIC_LOCAL__ ?? devFace();
if (face === undefined) {
    throw new Error(`This window was opened without a folder.`);
}
window.__INTENTIC_LOCAL__ = face;

const id = sandboxIdOf(face);
localStorage.setItem(`intentic.activeSandboxId`, id);
localStorage.setItem(`intentic.session.${id}`, JSON.stringify({ token: face.token, expiresAt: Date.now() + 365 * 86_400_000, email: LOCAL_EMAIL }));
// The loopback shortcut is for reaching a sandbox faster; the sidecar is already on loopback.
localStorage.setItem(`intentic.localShortcut.declined.${id}`, `yes`);
installPlatform(face);

// The editor's one screen for a local window, whatever address the window was opened at.
window.history.replaceState(window.history.state, ``, `${import.meta.env.BASE_URL}local`);

await import(`@intentic/web/main`);
