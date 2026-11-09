// THE LOGO A DEVICE REMEMBERS IS A THUMBNAIL (2026-11-09). A sandbox's logo is a data URL of up to 150 KB
// (api-contract ImageDataUrlSchema), and the device's memory of an account's sandboxes (deviceDirectory.ts) lives in
// localStorage, about 5 MB for the whole origin, whose writes over quota are dropped without a word. A few large logos
// across a couple of accounts were enough for the memory to stop being written at all, which is exactly what an outage
// then found missing. Every place the memory is drawn (the switcher, the outage screen, a desktop window's roster) draws
// it at 40 px or less, so a raster logo is kept at THUMB_PX on its longest side; a small one (any Stylize-logo SVG,
// whose markup SandboxLogo.vue reads) is kept exactly as it is.

/** A logo this small or smaller is remembered untouched. */
export const LOGO_KEEP_CHARS = 16_384;
/** The longest side of a remembered raster logo, in pixels: twice the largest place it is drawn from memory. */
const THUMB_PX = 96;

export type RenderThumbnail = (image: string) => Promise<string>;

// Decodes the logo and draws it again at THUMB_PX, WebP where the browser encodes it (PNG where it does not, as Safari).
const renderThumbnail: RenderThumbnail = async (image) => {
    const picture = new Image();
    picture.src = image;
    await picture.decode();
    const longest = Math.max(picture.naturalWidth, picture.naturalHeight, 1);
    const scale = Math.min(1, THUMB_PX / longest);
    const canvas = document.createElement(`canvas`);
    canvas.width = Math.max(1, Math.round(picture.naturalWidth * scale));
    canvas.height = Math.max(1, Math.round(picture.naturalHeight * scale));
    const context = canvas.getContext(`2d`);
    if (context === null) {
        throw new Error(`no 2d canvas to draw the logo on`);
    }
    context.drawImage(picture, 0, 0, canvas.width, canvas.height);
    return canvas.toDataURL(`image/webp`, 0.85);
};

/**
 * The logo as the device should remember it: null and small logos as they are, a large one as a thumbnail, or as it is
 * when the thumbnail would not be smaller or cannot be drawn (no canvas, an image the browser cannot decode).
 */
export const thumbnailOf = async (image: string | null, render: RenderThumbnail = renderThumbnail): Promise<string | null> => {
    if (image === null || image.length <= LOGO_KEEP_CHARS || !image.startsWith(`data:image/`)) {
        return image;
    }
    try {
        const thumbnail = await render(image);
        return thumbnail.startsWith(`data:image/`) && thumbnail.length < image.length ? thumbnail : image;
    } catch (error) {
        console.warn(`[directory] a logo could not be made smaller to remember:`, error);
        return image;
    }
};

// One thumbnail per logo for the page's life: every list the platform answers carries the same logos again.
// allow(module-state): a cache of pure results, keyed by their whole input
const made = new Map<string, Promise<string | null>>();

/** As thumbnailOf, made once per distinct logo. */
export const rememberedLogoOf = (image: string | null): Promise<string | null> => {
    if (image === null || image.length <= LOGO_KEEP_CHARS) {
        return Promise.resolve(image);
    }
    let pending = made.get(image);
    if (pending === undefined) {
        pending = thumbnailOf(image);
        made.set(image, pending);
    }
    return pending;
};
