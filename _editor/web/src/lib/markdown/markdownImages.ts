import { resolveIn } from "./markdownFileLinks";

// A picture a markdown document names by a relative path (`![flow](img/flow.png)`) is a file beside the document, which
// the browser cannot fetch by that name: the page's address is the app's route, not the document's folder. Each one is
// resolved against the document's folder into a workspace path, and drawn from whatever the surface hands over for that
// path (the workspace's own bytes, as a cached object URL). A surface that reads a reactive cache there redraws the
// document once the bytes land: the kit parses in a computed, which tracks what the decorator read. Anything with an
// address of its own is left as written.

// An address of its own: a scheme (http:, data:, blob:, mailto:), protocol-relative or absolute (`/`), or a fragment.
const ADDRESSED = /^(?:[a-z][a-z0-9+.-]*:|\/|#)/i;

// The part of a `src` that names a file: before any query or fragment (`img/a.png?raw=1#dark`), percent-decoded, since
// the parser writes a space in a path as `%20`. Undefined for an escape that doesn't decode.
const fileNamed = (src: string): string | undefined => {
    try {
        return decodeURIComponent(src.split(/[?#]/u, 1)[0] ?? ``);
    } catch {
        // allow(silent-catch): a malformed escape names no file, so the picture is drawn as nothing rather than guessed at.
        return undefined;
    }
};

// Whether `path` climbs above the workspace's root from `dir`. resolveIn keeps such a path at the top, which would name
// another file than the one written; a picture is drawn from exactly its own file or not at all.
const climbsOut = (dir: string, path: string): boolean => {
    let depth = dir.split(`/`).filter((segment) => segment !== ``).length;
    for (const segment of path.split(`/`)) {
        if (segment === `..`) {
            depth -= 1;
            if (depth < 0) {
                return true;
            }
        } else if (segment !== `` && segment !== `.`) {
            depth += 1;
        }
    }
    return false;
};

/**
 * The workspace path a picture's `src` names from a document in `dir` (`docs/`, or `` at the root): undefined for a
 * `src` with an address of its own, and for one that climbs out of the workspace.
 */
export const picturePathIn = (dir: string, src: string): string | undefined => {
    if (src === `` || ADDRESSED.test(src)) {
        return undefined;
    }
    const path = fileNamed(src);
    if (path === undefined || climbsOut(dir, path)) {
        return undefined;
    }
    // At the root resolveIn takes a path as written; `/` is the root as a folder, so `./a.png` still means `a.png`.
    const resolved = resolveIn(dir === `` ? `/` : dir, path);
    return resolved === `` ? undefined : resolved;
};

/**
 * Points every relative picture in a sanitized document at what `draw` answers for its workspace path, in place.
 * `dir` is the document's folder. While `draw` has nothing yet the `src` is empty, which asks nothing of anyone; a
 * picture that climbs out of the workspace keeps it empty, and `draw` is never asked about it.
 */
export const resolvePictures = (fragment: DocumentFragment, dir: string, draw: (path: string) => string | undefined): void => {
    for (const image of fragment.querySelectorAll(`img`)) {
        const src = image.getAttribute(`src`);
        if (src === null || src === `` || ADDRESSED.test(src)) {
            continue;
        }
        const path = picturePathIn(dir, src);
        image.setAttribute(`src`, path === undefined ? `` : (draw(path) ?? ``));
    }
};
