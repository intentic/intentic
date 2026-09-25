// The two reads behind a file chip, focused on what they must never do: quote the same bytes twice, spend a second
// request on a file the first one already finished, or decode something that isn't text and draw it as lines.
import { nextTick, ref } from "vue";
import type { WorkspaceFileResponse } from "@intentic/api-contract";

const readWindow = jest.fn<(path: string, opts?: { offset?: number; limit?: number }) => Promise<WorkspaceFileResponse>>();
const daemonBase = ref<string | undefined>(`https://sandbox-1.example`);

jest.mock("../../workspace/files/fileWindow", () => ({ readFileWindow: (path: string, opts?: object) => readWindow(path, opts) }));
jest.mock("../../sandbox/secrets/useEndpoint", () => ({ useEndpoint: () => ({ daemonBase }) }));

const { attachmentQuickLook } = await import("./attachmentQuickLooks");

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

    expect(attachmentQuickLook(path)).toBeUndefined();
    await settle();

    const look = attachmentQuickLook(path);
    expect(look?.size).toBe(size);
    // Neither end shows the fragment its window cut.
    expect(look?.head.endsWith(`head line`)).toBe(true);
    expect(look?.tail).toBe(`21:41 ERROR gave up`);
    // Disjoint by construction: the tail asks for what the head didn't reach, never for bytes it already has.
    const rest = size - head.length;
    expect(readWindow.mock.calls[1]?.[1]).toEqual({ offset: -rest, limit: rest });
});

it("caps the tail rather than asking for every byte the head missed", async () => {
    const path = freshPath();
    readWindow.mockResolvedValueOnce(served(`x`.repeat(8_192), 4_000_000)).mockResolvedValueOnce(served(`\nlast`, 4_000_000));

    attachmentQuickLook(path);
    await settle();

    expect(readWindow.mock.calls[1]?.[1]).toEqual({ offset: -8_192, limit: 8_192 });
});

// A file the first window finished has no second half to fetch, and a "not shown" rule over it would be a lie.
it("spends one read on a file the head window already finished", async () => {
    const path = freshPath();
    readWindow.mockResolvedValue(served(`one\ntwo`, 7));

    attachmentQuickLook(path);
    await settle();

    expect(readWindow).toHaveBeenCalledTimes(1);
    const look = attachmentQuickLook(path);
    expect(look?.head).toBe(`one\ntwo`);
    expect(look?.tail).toBeUndefined();
});

it("draws no lines from bytes that aren't text", async () => {
    const path = freshPath(`zip`);
    readWindow.mockResolvedValue(served(`PK${String.fromCharCode(0)}${String.fromCharCode(0)}`, 900_000));

    attachmentQuickLook(path);
    await settle();

    const look = attachmentQuickLook(path);
    expect(look?.binary).toBe(true);
    expect(look?.head).toBe(``);
    // Nothing to gain from a second window of the same non-text.
    expect(readWindow).toHaveBeenCalledTimes(1);
});

it("answers that an attachment is gone rather than leaving the chip reading forever", async () => {
    const path = freshPath();
    readWindow.mockResolvedValue({ present: false, path });

    attachmentQuickLook(path);
    await settle();

    expect(attachmentQuickLook(path)?.present).toBe(false);
    expect(readWindow).toHaveBeenCalledTimes(1);
});

// A picture already has a thumbnail; reading its bytes as text would cost a request to draw mojibake.
it("never reads an image", () => {
    expect(attachmentQuickLook(freshPath(`png`))).toBeUndefined();
    expect(readWindow).not.toHaveBeenCalled();
});
