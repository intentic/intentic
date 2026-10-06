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

// One `srcset` candidate: an address and, after whitespace, the width or density it is for (`a.png 2x`).
const CANDIDATE = /^(\S+)(\s+.*)?$/su;

/**
 * What a surface answers for a picture's workspace path: its address, `null` for a file with nothing to draw, or
 * undefined while its bytes are on their way.
 */
export type DrawPicture = (path: string) => string | null | undefined;

// What a picture on its way draws in the meantime: one transparent pixel, which asks nothing of anyone and, unlike an
// empty `src`, is not a broken image the browser would put its glyph on. The stylesheet sizes and paints the placeholder.
export const PENDING_PICTURE = `data:image/gif;base64,R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7`;

// A `<source>`'s candidates, each relative address resolved like an `<img>`'s; a candidate with nothing to draw yet is
// left out, and a set left with none is empty, which the browser skips for the next source or the `<img>`.
const resolveSrcset = (srcset: string, dir: string, draw: DrawPicture): string =>
    srcset
        .split(`,`)
        .map((candidate) => candidate.trim())
        .flatMap((candidate) => {
            const match = CANDIDATE.exec(candidate);
            const url = match?.[1] ?? ``;
            if (url === `` || ADDRESSED.test(url)) {
                return candidate === `` ? [] : [candidate];
            }
            const path = picturePathIn(dir, url);
            const drawn = path === undefined ? undefined : draw(path);
            return drawn === undefined || drawn === null ? [] : [`${drawn}${match?.[2] ?? ``}`];
        })
        .join(`, `);

// `<source media="(prefers-color-scheme: dark)">`, the way a README offers a dark picture.
const SCHEME_QUERY = /^\s*\(\s*prefers-color-scheme\s*:\s*(light|dark)\s*\)\s*$/iu;

/**
 * Points every relative picture in a sanitized document at what `draw` answers for its workspace path, in place.
 * `dir` is the document's folder. While `draw` has nothing yet the `src` is empty, which asks nothing of anyone; a
 * picture that climbs out of the workspace keeps it empty, and `draw` is never asked about it. One still on its way is
 * marked `data-md-pending`, which the stylesheet draws as a loading placeholder in the picture's place. A `<picture>`'s
 * `<source srcset>` resolves the same way, and one offered for a colour scheme answers to `scheme`, the app's look,
 * rather than to the operating system's: a dark app shows a README's dark picture on a light desktop, as GitHub's
 * own theme does.
 */
export const resolvePictures = (
    fragment: DocumentFragment,
    dir: string,
    draw: DrawPicture,
    scheme?: `light` | `dark`,
): void => {
    for (const image of fragment.querySelectorAll(`img`)) {
        const src = image.getAttribute(`src`);
        if (src === null || src === `` || ADDRESSED.test(src)) {
            continue;
        }
        const path = picturePathIn(dir, src);
        const drawn = path === undefined ? null : draw(path);
        image.setAttribute(`src`, drawn === undefined ? PENDING_PICTURE : (drawn ?? ``));
        image.toggleAttribute(`data-md-pending`, drawn === undefined);
    }
    for (const source of fragment.querySelectorAll(`picture > source`)) {
        const srcset = source.getAttribute(`srcset`);
        if (srcset !== null) {
            source.setAttribute(`srcset`, resolveSrcset(srcset, dir, draw));
        }
        const wants = SCHEME_QUERY.exec(source.getAttribute(`media`) ?? ``)?.[1]?.toLowerCase();
        if (scheme !== undefined && wants !== undefined) {
            source.setAttribute(`media`, wants === scheme ? `all` : `not all`);
        }
    }
};
