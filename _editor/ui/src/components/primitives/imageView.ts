// Extensions <img> can paint; SVG is excluded on purpose, it's markup/text, not an opaque image.
const RENDERABLE_IMAGE_EXTS: ReadonlySet<string> = new Set(["png", "jpg", "jpeg", "gif", "webp", "avif", "bmp", "ico"]);

export const isRenderableImage = (path: string): boolean => {
    const name = path.slice(path.lastIndexOf("/") + 1).toLowerCase();
    const dot = name.lastIndexOf(".");
    return dot > 0 && RENDERABLE_IMAGE_EXTS.has(name.slice(dot + 1));
};

// What a view is showing, shared between panes that must agree (a binary diff). `fit` is its own state,
// not a computed scale, since two differently sized images fit at different percentages.
export type ImageViewState = { readonly fit: true } | { readonly fit: false; readonly scale: number; readonly x: number; readonly y: number };
