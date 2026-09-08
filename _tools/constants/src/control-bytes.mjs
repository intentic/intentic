// Bytes that make a text file binary, checked once here for the checkout gate and the daemon's per-edit reader. A NUL
// reads as binary everywhere (git, grep, diff viewers); its backslash-u-0000 escape is the same code point at runtime
// but stays text.

// Extensions allowed arbitrary bytes, skipped by name not sniffed: binary-looking source is the bug.
export const BINARY_EXTENSIONS = new Set([
    "png",
    "jpg",
    "jpeg",
    "gif",
    "webp",
    "avif",
    "ico",
    "icns",
    "pdf",
    "woff",
    "woff2",
    "ttf",
    "otf",
    "eot",
    "zip",
    "gz",
    "tgz",
    "br",
    "wasm",
    "mp4",
    "webm",
    "mp3",
    "wav",
    "bin",
    "node",
    "keystore",
    "jks",
]);

export const isBinaryPath = (path) => BINARY_EXTENSIONS.has(path.split(".").pop()?.toLowerCase() ?? "");

// C0 controls minus tab/newline/CR; DEL rides along, equally invisible and out of place in source.
export const isForbiddenByte = (byte) => byte <= 0x08 || byte === 0x0b || byte === 0x0c || (byte >= 0x0e && byte <= 0x1f) || byte === 0x7f;

// First forbidden byte as {offset, line, column, byte}, or undefined if none; slices only once a bad byte is found, so
// a clean file costs one linear scan.
export const firstForbiddenByte = (bytes) => {
    for (let at = 0; at < bytes.length; at++) {
        if (isForbiddenByte(bytes[at])) {
            const upto = bytes.subarray(0, at).toString("utf8");
            return { offset: at, line: upto.split("\n").length, column: upto.length - upto.lastIndexOf("\n"), byte: bytes[at] };
        }
    }
    return undefined;
};

// How a byte is named in a report, and how it should be spelled in the file instead.
export const byteName = (byte) => (byte === 0x00 ? "NUL" : `0x${byte.toString(16).padStart(2, "0")}`);
export const escapeFor = (byte) => `\\u${byte.toString(16).padStart(4, "0")}`;
