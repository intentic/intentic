// Attachment thumbnail re-fetch, focused on the case where the first ask fails before the sandbox's address is
// known. Pins which failures are worth retrying and which are final: the difference between a screenshot that
// comes back and a permanent `image.png` chip.
import { it, expect, beforeEach, mock, jest } from "bun:test";
import { advanceTimersByTimeAsync } from "@intentic/testing/bun";
import { nextTick, ref } from "vue";
import { STATE_DIR } from "@intentic/constants";

const blob = mock<(path: string) => Promise<Blob>>();
// The resolved daemon address, exactly as useEndpoint hands it out: undefined until sandbox.list lands.
const daemonBase = ref<string | undefined>(undefined);

class HttpError extends Error {
    constructor(readonly status: number) {
        super(`http ${status}`);
    }
}

mock.module("../../sandbox/client/sandboxClient", () => ({ sandboxBlob: (path: string) => blob(path), SandboxHttpError: HttpError }));
mock.module("../../sandbox/secrets/useEndpoint", () => ({ useEndpoint: () => ({ daemonBase }) }));

const { attachmentAudio, attachmentPreview, forgetMedia, rememberMedia } = await import("./attachmentPreviews");

// The module caches per path for the life of the page, so each case needs a path of its own.
let counter = 0;
const freshPath = (): string => `${STATE_DIR}/records/artifacts/attachments/u${++counter}/shot.png`;
const freshSound = (): string => `${STATE_DIR}/records/artifacts/attachments/u${++counter}/voice.m4a`;

// Let the address watcher flush and the pending .then callbacks run, without advancing the retry timers.
const settle = async (): Promise<void> => {
    await nextTick();
    await Promise.resolve();
    await Promise.resolve();
};

beforeEach(() => {
    blob.mockReset();
    daemonBase.value = undefined;
    jest.useFakeTimers();
    globalThis.URL.createObjectURL = mock(() => `blob:thumb`);
});

it("re-mints a thumbnail from the workspace bytes on first ask", async () => {
    const path = freshPath();
    blob.mockResolvedValue(new Blob([`x`]));

    expect(attachmentPreview(path)).toBeUndefined();
    await settle();

    expect(blob).toHaveBeenCalledWith(`/workspace/raw?path=${encodeURIComponent(path)}`);
    expect(attachmentPreview(path)).toBe(`blob:thumb`);
});

it("fetches once for a path however many bubbles ask", async () => {
    const path = freshPath();
    blob.mockResolvedValue(new Blob([`x`]));

    attachmentPreview(path);
    attachmentPreview(path);
    attachmentPreview(path);
    await settle();

    expect(blob).toHaveBeenCalledTimes(1);
});

// A chip can paint before there is an address to fetch from; that first failure must not be final.
it("recovers the thumbnail once an address resolves after the first ask failed unreachable", async () => {
    const path = freshPath();
    blob.mockRejectedValueOnce(new Error(`Your sandbox isn't reachable yet`));

    expect(attachmentPreview(path)).toBeUndefined();
    await settle();
    expect(attachmentPreview(path)).toBeUndefined();

    blob.mockResolvedValue(new Blob([`x`]));
    daemonBase.value = `https://sandbox-1.example`;
    await settle();

    expect(attachmentPreview(path)).toBe(`blob:thumb`);
});

it("retries a daemon that is still booting until it answers", async () => {
    const path = freshPath();
    blob.mockRejectedValueOnce(new HttpError(502)).mockResolvedValue(new Blob([`x`]));

    attachmentPreview(path);
    await settle();
    expect(attachmentPreview(path)).toBeUndefined();

    await advanceTimersByTimeAsync(200);
    await settle();

    expect(blob).toHaveBeenCalledTimes(2);
    expect(attachmentPreview(path)).toBe(`blob:thumb`);
});

it("stops asking for an attachment the daemon says is gone", async () => {
    const path = freshPath();
    blob.mockRejectedValue(new HttpError(404));

    attachmentPreview(path);
    await settle();

    // Neither a later render nor a resolved address re-opens a question already answered.
    attachmentPreview(path);
    daemonBase.value = `https://sandbox-1.example`;
    await advanceTimersByTimeAsync(30_000);
    await settle();

    expect(blob).toHaveBeenCalledTimes(1);
    expect(attachmentPreview(path)).toBeUndefined();
});

it("leaves an attachment that is neither picture nor sound as a name chip without touching the daemon", () => {
    expect(attachmentPreview(`${STATE_DIR}/records/artifacts/attachments/u9/notes.pdf`)).toBeUndefined();
    expect(attachmentAudio(`${STATE_DIR}/records/artifacts/attachments/u9/notes.pdf`)).toBeUndefined();
    expect(blob).not.toHaveBeenCalled();
});

// One cache, two elements: the kind is what decides which of them a path answers, so a fetched sound can never be
// handed to an `<img>` (which would draw a broken picture) and a picture is never fed to a player.
it("hands a fetched sound to the player and nothing to the thumbnail", async () => {
    const path = freshSound();
    blob.mockResolvedValue(new Blob([`x`]));

    expect(attachmentPreview(path)).toBeUndefined();
    expect(attachmentAudio(path)).toBeUndefined();
    await settle();

    expect(blob).toHaveBeenCalledTimes(1);
    expect(attachmentAudio(path)).toBe(`blob:thumb`);
    expect(attachmentPreview(path)).toBeUndefined();
});

// The composer types staged bytes by MIME, not by name, so a `.bin` the browser called audio/* still plays — and
// the kind travels with the URL rather than being re-guessed from the path at every render.
it("keeps a staged file's kind, whatever the path is named", () => {
    const path = `${STATE_DIR}/records/artifacts/attachments/u9/clip.bin`;
    rememberMedia(path, `audio`, `blob:just-recorded`);

    expect(attachmentAudio(path)).toBe(`blob:just-recorded`);
    expect(attachmentPreview(path)).toBeUndefined();
    expect(blob).not.toHaveBeenCalled();
});

it("gives up on a chain that never lands, without a chip that polls forever", async () => {
    const path = freshPath();
    blob.mockRejectedValue(new Error(`network down`));

    attachmentPreview(path);
    await advanceTimersByTimeAsync(60_000);
    await settle();

    // The five backed-off tries after the first, and then silence.
    expect(blob).toHaveBeenCalledTimes(6);
});

// The bytes this window uploaded are already here, so nothing is asked of the daemon for them: staging a file
// makes an object URL that answers for every bubble the message goes on to produce.
it("answers from the composer's own object URL, without asking the daemon at all", () => {
    const path = freshPath();
    rememberMedia(path, `image`, `blob:just-pasted`);

    expect(attachmentPreview(path)).toBe(`blob:just-pasted`);
    expect(blob).not.toHaveBeenCalled();
});

// Forgetting has to reach the refusal too: a path asked about before its bytes existed is parked on a 404, and a
// cache that only drops the value would keep answering from that parking rather than fetching the file that is
// there now.
it("asks again for a path that was refused before it was forgotten", async () => {
    const path = freshPath();
    blob.mockRejectedValue(new HttpError(404));
    attachmentPreview(path);
    await settle();
    expect(blob).toHaveBeenCalledTimes(1);

    forgetMedia(path);
    blob.mockReset();
    blob.mockResolvedValue(new Blob([`x`]));

    expect(attachmentPreview(path)).toBeUndefined();
    await settle();

    expect(blob).toHaveBeenCalledTimes(1);
    expect(attachmentPreview(path)).toBe(`blob:thumb`);
});

// A staged file's URL is revoked on removal; the cache must drop it too or hand out a dead thumb.
it("drops a staged file's URL when the chip is removed", async () => {
    const path = freshPath();
    rememberMedia(path, `image`, `blob:staged`);
    forgetMedia(path);
    blob.mockResolvedValue(new Blob([`x`]));

    expect(attachmentPreview(path)).toBeUndefined();
    await settle();

    expect(attachmentPreview(path)).toBe(`blob:thumb`);
});
