// The square every inline picture in the app is stored as: 128px, WebP where the browser encodes it (others
// fall back to PNG), far under the API's 150 kB data-URL cap either way. Avatars and sandbox logos have no
// upload path — they are strings on a row — so the downscale happens here, in the browser, on the picked file.
//
// The square itself is not negotiable: every surface that draws one of these is a square or circular tile. So
// the only real question is what a NON-square source loses, and the honest answer differs by subject — which is
// why `fit` is required rather than defaulted. A caller has to know which kind of picture it is asking for.
//
//   cover     fill the square, centre-crop the overflow. Right for a FACE: the subject is in the middle and
//             the edges are background.
//   contain   fit the whole source inside the square, transparent padding around it. Right for a LOGO, where a
//             crop is destructive rather than tidy — a wide wordmark cropped to a square keeps its middle few
//             letters and loses the name, which is the one thing the mark exists to say.
//
// Transparency is why contain needs no fill colour: WebP and PNG both carry alpha, so the padding is whatever
// tile the mark is drawn on, in either theme.
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
