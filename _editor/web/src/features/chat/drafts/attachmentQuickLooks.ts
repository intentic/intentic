import { dropPartialFirst, dropPartialLast, type FileQuickLook, isAudioPath, isImagePath } from "./fileQuickLook";
import { lazyByPath } from "../../sandbox/client/lazyByPath";
import { readFileWindow } from "../../workspace/files/fileWindow";

// Head and tail windows per attachment path, shared by the composer chip, sent bubbles and session hover cards — the
// text twin of attachmentPreviews.ts, on the same terms (fetched on first ask, retried through the daemon's boot,
// parked on a refusal). Two windows rather than one read, because a log is attached for what is at its END, and a
// head-only preview shows the banner.

// Bytes per window. Small on purpose: this is a look, and the workspace viewer is one click from the chip.
const HEAD_BYTES = 8 * 1024;
const TAIL_BYTES = 8 * 1024;

// The byte no text file has, by code point rather than an escape: a literal one in this source would make git, grep
// and every diff viewer read this file as binary.
const NUL = String.fromCharCode(0);

const MISSING: FileQuickLook = { present: false, size: 0, head: ``, headBytes: 0, tailBytes: 0, binary: false };

const looks = lazyByPath(async (path: string): Promise<FileQuickLook> => {
    const head = await readFileWindow(path, { limit: HEAD_BYTES });
    if (!head.present) {
        return MISSING;
    }
    const binary = head.content.includes(NUL);
    const rest = head.size - head.bytes;
    if (binary || rest <= 0) {
        return { present: true, size: head.size, head: binary ? `` : head.content, headBytes: head.bytes, tailBytes: 0, binary };
    }
    // At most what the head didn't reach, so the two windows can never quote the same bytes twice.
    const want = Math.min(TAIL_BYTES, rest);
    const tail = await readFileWindow(path, { offset: -want, limit: want });
    return {
        present: true,
        size: head.size,
        head: dropPartialLast(head.content),
        headBytes: head.bytes,
        ...(tail.present ? { tail: dropPartialFirst(tail.content), tailBytes: tail.bytes } : { tailBytes: 0 }),
        binary: false,
    };
});

// The head and tail of an attachment, starting the read on first ask. Undefined while the windows are in flight, and
// never asked for at all where the bytes draw themselves (a thumbnail, a waveform): two windows of a decoded
// container are 16KB over the wire to render "Not text: nothing to preview here."
export const attachmentQuickLook = (path: string): FileQuickLook | undefined =>
    isImagePath(path) || isAudioPath(path) ? undefined : looks.get(path);
