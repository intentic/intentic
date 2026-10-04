import { mediaNameOf } from "./media.js";
import type { WaMessageContent, WaRawMessage } from "./types.js";

/* A downloaded medium is saved under a name that says what it is, envelopes or not. */

const raw = (message: WaMessageContent): WaRawMessage => ({ key: { id: "M1" }, message });

test("a document keeps its own filename, other media are named by kind and mimetype", () => {
    expect(mediaNameOf(raw({ documentMessage: { fileName: "invoice.pdf" } }))).toBe("invoice.pdf");
    expect(mediaNameOf(raw({ documentMessage: { mimetype: "application/pdf" } }))).toBe("document.pdf");
    expect(mediaNameOf(raw({ imageMessage: { mimetype: "image/jpeg" } }))).toBe("photo.jpg");
    expect(mediaNameOf(raw({ audioMessage: { mimetype: "audio/ogg; codecs=opus", ptt: true } }))).toBe("voice.ogg");
    expect(mediaNameOf(raw({ stickerMessage: {} }))).toBe("sticker.bin");
});

test("media inside a disappearing or view-once envelope is found, and a message without media has no name", () => {
    expect(mediaNameOf(raw({ ephemeralMessage: { message: { viewOnceMessageV2: { message: { videoMessage: { mimetype: "video/mp4" } } } } } }))).toBe("video.mp4");
    expect(mediaNameOf(raw({ conversation: "just words" }))).toBeUndefined();
});
