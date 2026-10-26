// THE APP'S SERVICE WORKER, registered on every load of the hosted editor (2026-10-26). One worker at `/sw.js`, scope `/`,
// does two jobs: web push (workbench/push/webPush.ts), and the editor's own copy of itself, which answers a navigation
// when app.intentic.dev cannot (public/sw.js, README "Offline copy"). It used to be registered only when push was
// switched on, so the copy never existed for the readers who need it most: the ones who never asked for notifications.

export const APP_WORKER_URL = `/sw.js`;

/** Where this page was loaded, and what kind of build and window it is. */
export interface WorkerPlace {
    readonly protocol: string;
    readonly hostname: string;
    /** `window.isSecureContext`: a worker registers only in one (https, or a loopback address). */
    readonly secure: boolean;
    /** A production build: the dev server's modules are no shell to keep. */
    readonly production: boolean;
    /** The desktop app's own window on a folder or this computer's sandboxes (`window.__INTENTIC_LOCAL__`). */
    readonly localWindow: boolean;
}

/**
 * Whether this load keeps the editor's offline copy: a production build served over the web, never the desktop app's
 * own bundle (`tauri://localhost`, `http(s)://tauri.localhost`), which is the copy already and has no network to fall
 * back from. Pure.
 */
export const keepsOfflineCopy = (place: WorkerPlace): boolean =>
    place.production &&
    place.secure &&
    !place.localWindow &&
    (place.protocol === `https:` || place.protocol === `http:`) &&
    place.hostname !== `tauri.localhost`;

/**
 * The registration, once its worker is active: what push subscribes through, and what the copy is kept by. Registered
 * with `updateViaCache: none` everywhere, push included, since a second register() naming another mode would start an
 * update of its own.
 */
export const appWorker = async (): Promise<ServiceWorkerRegistration> => {
    await navigator.serviceWorker.register(APP_WORKER_URL, { updateViaCache: `none` });
    return navigator.serviceWorker.ready;
};

const placeOfThisPage = (): WorkerPlace => ({
    protocol: location.protocol,
    hostname: location.hostname,
    secure: window.isSecureContext,
    production: import.meta.env.PROD === true,
    localWindow: window.__INTENTIC_LOCAL__ !== undefined,
});

/** Registers the worker once the page has loaded, so its install never competes with the first start for the network. */
export const installOfflineCopy = (): void => {
    if (!(`serviceWorker` in navigator) || !keepsOfflineCopy(placeOfThisPage())) {
        return;
    }
    const register = async (): Promise<void> => {
        try {
            await appWorker();
        } catch (error) {
            // Said and left: the editor runs as it did before there was a copy, and the next load tries again.
            console.warn(`[offline] the app's service worker could not be registered:`, error);
        }
    };
    if (document.readyState === `complete`) {
        void register();
    } else {
        window.addEventListener(`load`, () => void register(), { once: true });
    }
};
