/* THE BYTES THAT MAKE A TEXT FILE BINARY, named once for everything that polices them: the checkout gate
 * (_tools/checks/control-chars.mjs, every tracked file), and the daemon's per-edit reader (the `bytes-edit`
 * rule's script), which asks the same question of one file the moment it is written.
 *
 * A NUL typed straight into a string literal is invisible in an editor and decisive everywhere else: git, grep,
 * `file`, code review and every diff viewer sniff for one and call the whole file binary. The escape
 * (backslash-u-0000) is the same code point at runtime and leaves the file text, so every reader here asks for
 * it and nothing else. Hand-written JavaScript rather than compiled TypeScript so a pre-push hook on a clone
 * that never installed can import it by relative path. */

// What is allowed to hold arbitrary bytes. Extensions, not paths: an image is an image wherever it lands.
// Genuinely binary content is skipped by extension rather than by sniffing, because sniffing is exactly the
// thing that goes wrong here: a source file that LOOKS binary is the bug, not the exemption.
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

// C0 controls minus the three every text file legitimately contains (tab, newline, carriage return). DEL rides
// along: it is as invisible as the rest and has no business in source either.
export const isForbiddenByte = (byte) => byte <= 0x08 || byte === 0x0b || byte === 0x0c || (byte >= 0x0e && byte <= 0x1f) || byte === 0x7f;

// The first forbidden byte in a buffer as `{ offset, line, column, byte }`, or undefined for a clean file.
// One report per file is enough to send someone to it. Sliced only for a byte already known to be bad, so
// the clean file, the overwhelmingly common case, pays for one linear scan and nothing else.
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
