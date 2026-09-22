// The two reads behind a file chip, focused on what they must never do: quote the same bytes twice, spend a second
// request on a file the first one already finished, or decode something that isn't text and draw it as lines.
import { it, expect, beforeEach, mock } from "bun:test";
import { nextTick, ref } from "vue";
import type { WorkspaceFileResponse } from "@intentic/api-contract";

const readWindow = mock<(path: string, opts?: { offset?: number; limit?: number }) => Promise<WorkspaceFileResponse>>();
const daemonBase = ref<string | undefined>(`https://sandbox-1.example`);

mock.module("../../workspace/files/fileWindow", () => ({ readFileWindow: (path: string, opts?: object) => readWindow(path, opts) }));
mock.module("../../sandbox/client/sandboxClient", () => ({ SandboxHttpError: class extends Error {} }));
mock.module("../../sandbox/secrets/useEndpoint", () => ({ useEndpoint: () => ({ daemonBase }) }));

const { attachmentPeek } = await import("./attachmentPeeks");

// The module caches per path for the life of the page, so each case needs a path of its own.
let counter = 0;
const freshPath = (extension = `log`): string => `.intentic/records/artifacts/attachments/u${++counter}/run.${extension}`;

// Both awaits in the loader, plus the ref write the chip re-renders from.
const settle = async (): Promise<void> => {
    await nextTick();
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();
    await nextTick();
};

const served = (content: string, size: number, offset = 0): WorkspaceFileResponse => ({
    present: true,
    path: `x`,
    content,
    size,
    offset,
    bytes: content.length,
    shared: true,
});

beforeEach(() => {
    readWindow.mockReset();
});

it("reads the head and the tail of a file too big to read whole", async () => {
    const path = freshPath();
    const size = 12_000;
    const head = `${`head line\n`.repeat(819)}part`; // The 8KB head window, ending mid-line as a byte-cut window does.
    readWindow.mockResolvedValueOnce(served(head, size)).mockResolvedValueOnce(served(`f a line\n21:41 ERROR gave up`, size, size - 27));

    expect(attachmentPeek(path)).toBeUndefined();
    await settle();

    const peek = attachmentPeek(path);
    expect(peek?.size).toBe(size);
    // Neither end shows the fragment its window cut.
    expect(peek?.head.endsWith(`head line`)).toBe(true);
    expect(peek?.tail).toBe(`21:41 ERROR gave up`);
    // Disjoint by construction: the tail asks for what the head didn't reach, never for bytes it already has.
    const rest = size - head.length;
    expect(readWindow.mock.calls[1]?.[1]).toEqual({ offset: -rest, limit: rest });
});

it("caps the tail rather than asking for every byte the head missed", async () => {
    const path = freshPath();
    readWindow.mockResolvedValueOnce(served(`x`.repeat(8_192), 4_000_000)).mockResolvedValueOnce(served(`\nlast`, 4_000_000));

    attachmentPeek(path);
    await settle();

    expect(readWindow.mock.calls[1]?.[1]).toEqual({ offset: -8_192, limit: 8_192 });
});

// A file the first window finished has no second half to fetch, and a "not shown" rule over it would be a lie.
it("spends one read on a file the head window already finished", async () => {
    const path = freshPath();
    readWindow.mockResolvedValue(served(`one\ntwo`, 7));

    attachmentPeek(path);
    await settle();

    expect(readWindow).toHaveBeenCalledTimes(1);
    const peek = attachmentPeek(path);
    expect(peek?.head).toBe(`one\ntwo`);
    expect(peek?.tail).toBeUndefined();
});

it("draws no lines from bytes that aren't text", async () => {
    const path = freshPath(`zip`);
    readWindow.mockResolvedValue(served(`PK${String.fromCharCode(0)}${String.fromCharCode(0)}`, 900_000));

    attachmentPeek(path);
    await settle();

    const peek = attachmentPeek(path);
    expect(peek?.binary).toBe(true);
    expect(peek?.head).toBe(``);
    // Nothing to gain from a second window of the same non-text.
    expect(readWindow).toHaveBeenCalledTimes(1);
});

it("answers that an attachment is gone rather than leaving the chip reading forever", async () => {
    const path = freshPath();
    readWindow.mockResolvedValue({ present: false, path });

    attachmentPeek(path);
    await settle();

    expect(attachmentPeek(path)?.present).toBe(false);
    expect(readWindow).toHaveBeenCalledTimes(1);
});

// A picture already has a thumbnail; reading its bytes as text would cost a request to draw mojibake.
it("never reads an image", () => {
    expect(attachmentPeek(freshPath(`png`))).toBeUndefined();
    expect(readWindow).not.toHaveBeenCalled();
});
