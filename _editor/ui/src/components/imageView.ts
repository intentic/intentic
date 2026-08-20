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
