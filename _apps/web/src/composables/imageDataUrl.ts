// Downscale a picked image file to a small centered square and return it as a data URL — avatars and
// sandbox logos are stored inline as strings (no upload infrastructure). WebP where the browser encodes
// it; others fall back to PNG, still far under the API's 150 kB cap at this size.
export const fileToSquareDataUrl = async (file: File, size = 128): Promise<string> => {
    const bitmap = await createImageBitmap(file);
    const side = Math.min(bitmap.width, bitmap.height);
    const canvas = document.createElement(`canvas`);
    canvas.width = size;
    canvas.height = size;
    const context = canvas.getContext(`2d`);
    if (context === null) {
        throw new Error(`Canvas is unavailable in this browser.`);
    }
    context.drawImage(bitmap, (bitmap.width - side) / 2, (bitmap.height - side) / 2, side, side, 0, 0, size, size);
    bitmap.close();
    return canvas.toDataURL(`image/webp`, 0.8);
};
