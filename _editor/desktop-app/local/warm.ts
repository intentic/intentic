import type { LocalFace } from "@intentic/web/local";

// A WINDOW OPENED AHEAD OF NEED. The app keeps one local window built and hidden (src-tauri windows.rs, its spare) so
// the next folder opens into a page that has already loaded. Nobody has chosen that folder yet, so the page starts
// without a face: it waits for the one the app hands it, which the app sets on the window first and then announces
// with this event. Until then nothing runs that reads the face, and the editor above all stays unimported, since its
// modules read the face and the session while they evaluate.

export const FACE_EVENT = `intentic:face`;

/** Where the face is set and announced: the window, or a stand-in for one in a test. */
export interface FaceHost extends Pick<EventTarget, `addEventListener` | `removeEventListener`> {
    __INTENTIC_LOCAL__?: LocalFace;
}

/** The face the app hands this window; an announcement with no face set yet is not one, and waiting goes on. */
export const faceArrives = (host: FaceHost): Promise<LocalFace> =>
    new Promise((resolve) => {
        const take = (): void => {
            const face = host.__INTENTIC_LOCAL__;
            if (face === undefined) {
                return;
            }
            host.removeEventListener(FACE_EVENT, take);
            resolve(face);
        };
        host.addEventListener(FACE_EVENT, take);
    });

// A dynamic import's specifier, as a bundler writes it in any of the three quotes. Relative or rooted only: a bare
// name is a module the build never resolved, and there is no file behind it to fetch. No `$` either, since a template
// with a hole in it names a module only once it runs.
const DYNAMIC_IMPORT = /\bimport\(\s*(["'`])((?:\.{1,2})?\/[^"'`$]+)\1\s*\)/;

/**
 * The address of the chunk a loader imports, read off the loader's own source without calling it: the chunk's name
 * carries a content hash only the build knows. Undefined when the source says anything else, which costs the warm-up
 * and nothing more.
 */
export const editorChunk = (loaderSource: string, base: string): string | undefined => {
    const specifier = DYNAMIC_IMPORT.exec(loaderSource)?.[2];
    return specifier === undefined ? undefined : new URL(specifier, base).href;
};

/** Has the webview fetch and compile a module now, and run it only when it is imported. */
export const warmModule = (href: string, page: Document): void => {
    const link = page.createElement(`link`);
    link.rel = `modulepreload`;
    // As vite's own preload helper asks for a chunk, and as the page's entry script is fetched.
    link.crossOrigin = ``;
    link.href = href;
    page.head.append(link);
};
