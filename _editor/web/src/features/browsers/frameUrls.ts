/* THE PICTURE, OFF THE WIRE AND INTO AN <img>, for both screencast surfaces.
 *
 * Frames arrive as BINARY now rather than base64 inside JSON, and the change is worth more than the third of the
 * bytes it saves. A 1280x800 JPEG is 150-250 kB; base64 made every one of them a third bigger on a tunnel, and
 * the client then turned each into a `data:` URL, so a browsing agent allocated a fresh multi-hundred-kilobyte
 * STRING per frame and left it for the collector. A Blob costs a reference.
 *
 * The wire shape is one tag byte then the image (the daemon's encodeFrame writes it), because one socket carries
 * both kinds — a cheap JPEG while the page moves and a sharp WebP once it settles — and the decoder has to be
 * told which without a second message describing the first.
 *
 * WHY TWO URLS STAY ALIVE. An object URL has to be revoked or the blob is held for the life of the document, and
 * revoking the one just replaced is the obvious move — but `src` is assigned by Vue on the next tick, so at that
 * instant the <img> may still be decoding the picture being revoked. Keeping one generation of slack means the
 * URL let go of is one the element demonstrably moved on from two frames ago. Two blobs, never more. */

/* EVERY KIND OF PICTURE THIS SOCKET CARRIES, in one table, because the whole point of a tag byte is that the
 * client never has to be told separately what it is about to receive. Matches the daemon's own numbering
 * (screencast.ts for the images, videocast.ts for the coded frames):
 *
 *   0 jpeg, 1 webp — the frames path, one whole image per change.
 *   2 svg          — never encoded by the daemon; it is how the recorded demo plays drawn pages down this
 *                    same wire, which is only possible because the format travels WITH the frame.
 *   3 keyframe, 4 delta — the video path. Two tags rather than one plus a flag, because whether a frame can
 *                    start a decode is the single thing a VideoDecoder cannot work out for itself, and the tag
 *                    is where the client is already looking.
 */
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
            // An unknown tag is read as JPEG rather than dropped: a picture that decodes wrong is visibly wrong,
            // where a frame silently discarded looks exactly like a browser that has stopped painting.
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
