// Frames arrive as one tag byte plus binary image data (see the tag table below) and become object URLs for the
// <img>, avoiding a `data:` URL's giant string allocation per frame. Two URLs are kept alive at once, not one:
// `src` is assigned on Vue's next tick, so the just-replaced blob may still be decoding when it would otherwise be
// revoked.

// Every picture kind this socket carries (matches the daemon's screencast.ts/videocast.ts numbering):
// 0 jpeg, 1 webp — one whole image per change (frames path)
// 2 svg — the recorded demo's drawn pages, format travels with the frame
// 3 keyframe, 4 delta — video path; two tags so the client, not the VideoDecoder, knows what can start a decode
const MEDIA_TYPES = [`image/jpeg`, `image/webp`, `image/svg+xml`] as const;
export const FRAME_H264_KEY = 3;
export const FRAME_H264_DELTA = 4;

export interface FrameUrls {
    // The URL for this frame, or undefined for a message too short to be one.
    readonly from: (data: ArrayBuffer) => string | undefined;
    // Teardown: let go of everything still held. Safe to call twice.
    readonly release: () => void;
}

export const frameUrls = (): FrameUrls => {
    // The URL the element is showing (or about to), and the one before it, which it has certainly left.
    let showing: string | undefined;
    let previous: string | undefined;
    const drop = (url: string | undefined): void => {
        if (url !== undefined) {
            URL.revokeObjectURL(url);
        }
    };
    return {
        from: (data) => {
            const bytes = new Uint8Array(data);
            // One tag byte and at least one byte of picture. Anything shorter is not a frame.
            if (bytes.byteLength < 2) {
                return undefined;
            }
            // Unknown tags decode as JPEG rather than being dropped: a bad decode is visibly wrong, not a silent stall.
            const type = MEDIA_TYPES[bytes[0] ?? 0] ?? MEDIA_TYPES[0];
            const url = URL.createObjectURL(new Blob([bytes.subarray(1)], { type }));
            drop(previous);
            previous = showing;
            showing = url;
            return url;
        },
        release: () => {
            drop(previous);
            drop(showing);
            previous = undefined;
            showing = undefined;
        },
    };
};
