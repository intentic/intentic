import { startI18n, t } from "@intentic/ui/i18n";
import { accountKey, sandboxKeys, storedValue, storeValue } from "@intentic/ui/storage";
import { invoke } from "@tauri-apps/api/core";
import { registerDesktopCatalog } from "../src/i18n";
import { installMachinePlatform, type MachineFace, openingSandbox, rowsOf, sandboxKeyOf, seedSessions } from "./machineFace";
import { LOCAL_PLATFORM_ORIGIN } from "./origin";

// The sandbox face's entry (machineFace.ts says what it is): what must be true before the editor's own entry runs, the
// way the folder face prepares it (main.ts), with this computer's sandboxes standing where a folder's sidecar stands.
// Unlike the folder face it never sets `__INTENTIC_LOCAL__`, so the editor runs whole: every route, every extension.

// The editor's own keys (its app/storage/browserStorage.ts and client/session/sandboxSession.ts), scoped as it scopes them.
const ACTIVE_KEY = accountKey(`intentic.activeSandboxId`);
const sessionKey = sandboxKeys(`intentic.session.`);

// Where the face writes what the editor reads: the shared storage layer, never the browser's own.
const STORAGE: Pick<Storage, `setItem`> = { setItem: (key, value) => storeValue(key, value) };

// The editor's sandbox client keeps its sessions per id and hears other windows' writes on this channel
// (client/session/sandboxSession.ts); a session minted after the editor started reaches it the same way.
const SESSION_CHANNEL = `intentic.sandbox-auth`;

// How often the face asks whether the online workspace answers again, and looks for a sandbox that woke since.
const EVERY_MS = 30_000;

// A daemon that keeps refusing a fresh session (a new owner bound, browser access removed) is not asked again sooner.
const RENEW_AGAIN_MS = 5 * 60_000;

const loadEditor = async (): Promise<void> => {
    await import(`@intentic/web/main`);
};

const machineFace = (): Promise<MachineFace> => invoke(`machine_face`);

// A plain page in the editor's place when no sandbox here can be opened: the editor would only send the reader to a
// setup that needs the internet. Its words are the desktop catalog's, in the reader's language.
const sayNothingHere = async (): Promise<void> => {
    await startI18n();
    const main = document.createElement(`main`);
    main.setAttribute(`style`, `max-width:28rem;margin:20vh auto;padding:2rem;font:15px/1.5 system-ui,sans-serif;display:grid;gap:.75rem`);
    const title = document.createElement(`h1`);
    title.setAttribute(`style`, `font-size:1.125rem;font-weight:600;margin:0`);
    title.textContent = t(`desktop.machineFace.nothingHere`);
    const body = document.createElement(`p`);
    body.setAttribute(`style`, `margin:0;opacity:.75`);
    body.textContent = t(`desktop.machineFace.nothingHereBody`);
    main.append(title, body);
    document.body.replaceChildren(main);
};

// The online workspace answers again: offered, never imposed, since the reader may be in the middle of something here.
// It appears only once the editor is up, so it wears the editor's own look: the theme's role tokens for the surface
// (inline, since Tailwind does not scan this directory) and the app's button tiers (_editor/ui primeng.css), which follow
// every skin and the light/dark switch.
const offerWorkspace = (appUrl: string): void => {
    if (document.getElementById(`intentic-back-online`) !== null) {
        return;
    }
    const bar = document.createElement(`div`);
    bar.id = `intentic-back-online`;
    bar.setAttribute(`role`, `status`);
    bar.setAttribute(
        `style`,
        [
            `position:fixed`,
            `left:50%`,
            `bottom:calc(var(--spacing) * 4)`,
            `transform:translateX(-50%)`,
            `z-index:2147483647`,
            `box-sizing:border-box`,
            `max-width:min(48rem, calc(100vw - var(--spacing) * 8))`,
            `display:flex`,
            `flex-wrap:wrap`,
            `gap:calc(var(--spacing) * 3)`,
            `align-items:center`,
            `padding:calc(var(--spacing) * 3) calc(var(--spacing) * 4)`,
            `border:1px solid var(--color-line)`,
            `border-radius:var(--ui-radius)`,
            `background:var(--color-overlay)`,
            `color:var(--color-content)`,
            `font-family:var(--font-sans)`,
            `font-size:var(--text-sm)`,
            `line-height:var(--text-sm--line-height)`,
            `box-shadow:var(--shadow-lg)`,
        ].join(`;`),
    );
    const words = document.createElement(`p`);
    words.setAttribute(`style`, `margin:0;flex:1 1 18rem;min-width:0`);
    const title = document.createElement(`strong`);
    title.setAttribute(`style`, `font-weight:var(--font-weight-semibold)`);
    title.textContent = t(`desktop.machineFace.backOnline`);
    const body = document.createElement(`span`);
    body.setAttribute(`style`, `color:var(--color-muted)`);
    body.textContent = ` ${t(`desktop.machineFace.backOnlineBody`)}`;
    words.append(title, body);
    const actions = document.createElement(`div`);
    actions.setAttribute(`style`, `display:flex;gap:calc(var(--spacing) * 2);margin-inline-start:auto`);
    const open = document.createElement(`button`);
    open.type = `button`;
    open.className = `p-button p-component ui-button-loud`;
    open.textContent = t(`desktop.machineFace.openWorkspace`);
    open.addEventListener(`click`, () => window.location.assign(appUrl));
    const later = document.createElement(`button`);
    later.type = `button`;
    later.className = `p-button p-component p-button-secondary`;
    later.textContent = t(`desktop.machineFace.notNow`);
    later.addEventListener(`click`, () => bar.remove());
    actions.append(open, later);
    bar.append(words, actions);
    document.body.append(bar);
};

// Sessions the editor does not hold yet (a sandbox that woke, one minted again) go to it the way another window's would.
const tellTheEditor = (face: MachineFace, told: Set<string>): void => {
    const channel = new BroadcastChannel(SESSION_CHANNEL);
    for (const sandbox of face.sandboxes) {
        const id = sandboxKeyOf(sandbox);
        if (sandbox.session !== null && sandbox.localPort !== null && !told.has(`${id}:${sandbox.session.token}`)) {
            told.add(`${id}:${sandbox.session.token}`);
            storeValue(sessionKey(id), JSON.stringify(sandbox.session));
            // oxlint-disable-next-line unicorn/require-post-message-target-origin -- BroadcastChannel has no targetOrigin.
            channel.postMessage({ kind: `write`, sandboxId: id, session: sandbox.session });
        }
    }
    channel.close();
};

// A session the editor threw away because its daemon refused it is minted again, once in a while per sandbox.
const renewRefused = (face: () => MachineFace, told: Set<string>): void => {
    const asked = new Map<string, number>();
    const channel = new BroadcastChannel(SESSION_CHANNEL);
    channel.addEventListener(`message`, (event: MessageEvent<{ readonly kind?: string; readonly sandboxId?: string }>) => {
        const sandbox = face().sandboxes.find((candidate) => sandboxKeyOf(candidate) === event.data.sandboxId);
        if (event.data.kind !== `invalidate` || sandbox === undefined || Date.now() - (asked.get(sandbox.slug) ?? 0) < RENEW_AGAIN_MS) {
            return;
        }
        asked.set(sandbox.slug, Date.now());
        void invoke<NonNullable<MachineFace[`sandboxes`][number][`session`]>>(`machine_face_renew`, { slug: sandbox.slug })
            .then((session) => tellTheEditor({ ...face(), sandboxes: [{ ...sandbox, session }] }, told))
            .catch((error: Error) => console.warn(`[machine face] no fresh session for ${sandbox.slug}:`, error));
    });
};

const boot = async (): Promise<void> => {
    let face = await machineFace();
    await registerDesktopCatalog();
    const told = new Set<string>();
    for (const id of seedSessions(face, STORAGE)) {
        const sandbox = face.sandboxes.find((candidate) => sandboxKeyOf(candidate) === id);
        if (sandbox !== undefined && sandbox.session !== null) {
            told.add(`${id}:${sandbox.session.token}`);
        }
    }
    installMachinePlatform(() => face, LOCAL_PLATFORM_ORIGIN);
    renewRefused(() => face, told);
    setInterval(() => {
        void invoke<boolean>(`machine_face_online`).then((online) => {
            if (online) {
                offerWorkspace(face.appUrl);
            }
        });
        void machineFace().then((next) => {
            face = next;
            tellTheEditor(next, told);
        });
    }, EVERY_MS);
    if (rowsOf(face, new Date()).length === 0) {
        await sayNothingHere();
        return;
    }
    const opening = openingSandbox(face, storedValue(ACTIVE_KEY) ?? null);
    if (opening !== undefined) {
        storeValue(ACTIVE_KEY, opening);
    }
    // The router keeps this page's route in the hash (the web's app/environments/local.ts `sandboxFace`), and the page
    // has one address, whatever the window was opened at: the app answers `files/sandbox` with this page alone.
    window.__INTENTIC_SANDBOX_FACE__ = true;
    window.history.replaceState(window.history.state, ``, `${import.meta.env.BASE_URL}sandbox${window.location.hash}`);
    await loadEditor();
};

await boot();
