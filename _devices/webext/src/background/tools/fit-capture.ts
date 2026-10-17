import { fitSize } from "@intentic/base/image-fit";

// A captured tab shrunk to what a model reads whole (@intentic/base/image-fit), the size the desktop agent sends its
// screens at. captureVisibleTab captures device pixels, so a retina or 4K tab is three to seven times that many pixels,
// as many more bytes over the socket as base64, and the model API shrinks it back anyway. Still PNG: page text stays
// crisp, as the desktop agent's do.

const PNG_DATA_URL = /^data:image\/png;base64,/u;

const base64Of = (bytes: Uint8Array): string => {
    let binary = "";
    // In slices: String.fromCharCode takes its bytes as arguments, and a whole screenshot overflows the call stack.
    for (let at = 0; at < bytes.length; at += 0x8000) {
        binary += String.fromCharCode(...bytes.subarray(at, at + 0x8000));
    }
    return btoa(binary);
};

/** The capture's PNG as base64, shrunk to fit; as captured when it already fits or the browser cannot draw it. */
export const fitCapture = async (dataUrl: string): Promise<string> => {
    const captured = dataUrl.replace(PNG_DATA_URL, "");
    const bitmap = await createImageBitmap(await (await fetch(dataUrl)).blob());
    const size = fitSize(bitmap.width, bitmap.height);
    const canvas = size.width === bitmap.width && size.height === bitmap.height ? undefined : new OffscreenCanvas(size.width, size.height);
    const context = canvas?.getContext("2d") ?? null;
    if (canvas === undefined || context === null) {
        bitmap.close();
        return captured;
    }
    context.imageSmoothingQuality = "high";
    context.drawImage(bitmap, 0, 0, size.width, size.height);
    bitmap.close();
    return base64Of(new Uint8Array(await (await canvas.convertToBlob({ type: "image/png" })).arrayBuffer()));
};
