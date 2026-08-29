// The extensions a browser's <img> can paint, and therefore the ones ImageView is any use for. A browser fact,
// not a workspace one, which is why it lives beside the component rather than in either caller: the file viewer
// asks it through the viewers extension's manifest, and the binary-diff panes ask it directly to decide between
// two pictures and a "no visual form to compare" caption.
//
// SVG is deliberately absent. It renders through an <img> perfectly well, but it is also TEXT, it diffs by
// line and reads as markup, so the surfaces that show it pair the picture with a source view rather than
// treating it as an opaque image.
const RENDERABLE_IMAGE_EXTS: ReadonlySet<string> = new Set(["png", "jpg", "jpeg", "gif", "webp", "avif", "bmp", "ico"]);

export const isRenderableImage = (path: string): boolean => {
    const name = path.slice(path.lastIndexOf("/") + 1).toLowerCase();
    const dot = name.lastIndexOf(".");
    return dot > 0 && RENDERABLE_IMAGE_EXTS.has(name.slice(dot + 1));
};

/* WHAT AN IMAGE VIEW IS SHOWING, when more than one pane has to show the same thing: the two sides of a binary
 * diff. Passed in and emitted back out (`view` / `update:view`), so the parent owns one state and both panes
 * follow it, rather than each keeping a private magnification nothing can line up.
 *
 * `fit` is a state of its own rather than a computed scale, because "the whole picture" means a different
 * number in each pane the moment the two images differ in size, which is exactly the case this exists for: a
 * 2560px capture and a 2644px one both fit, at 27.1% and 27.0%, and each pane must be free to use its own.
 * Every other view is an explicit magnification and corner, and those DO transfer: comparing two screenshots
 * means looking at the same square inch of each. */
export type ImageViewState = { readonly fit: true } | { readonly fit: false; readonly scale: number; readonly x: number; readonly y: number };
