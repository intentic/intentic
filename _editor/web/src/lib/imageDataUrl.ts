// The square every inline picture (avatars, sandbox logos, no upload path) downscales to: 128px, WebP with a PNG
// fallback, under the API's data-URL cap. `fit` is required, not defaulted, since the right crop depends on the
// subject:
// - cover: fill the square, centre-crop the overflow; right for a face.
// - contain: fit the whole source inside the square, padded; right for a logo, where cropping loses the name.
const SIDE = 128;

export const fileToSquareDataUrl = async (file: File, fit: `cover` | `contain`): Promise<string> => {
    const bitmap = await createImageBitmap(file);
    const canvas = document.createElement(`canvas`);
    canvas.width = SIDE;
    canvas.height = SIDE;
    const context = canvas.getContext(`2d`);
    if (context === null) {
        throw new Error(`Canvas is unavailable in this browser.`);
    }
    if (fit === `cover`) {
        const source = Math.min(bitmap.width, bitmap.height);
        context.drawImage(bitmap, (bitmap.width - source) / 2, (bitmap.height - source) / 2, source, source, 0, 0, SIDE, SIDE);
    } else {
        const scale = SIDE / Math.max(bitmap.width, bitmap.height);
        const width = bitmap.width * scale;
        const height = bitmap.height * scale;
        context.drawImage(bitmap, 0, 0, bitmap.width, bitmap.height, (SIDE - width) / 2, (SIDE - height) / 2, width, height);
    }
    bitmap.close();
    return canvas.toDataURL(`image/webp`, 0.8);
};
