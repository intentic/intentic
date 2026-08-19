// The thumbnail a restored transcript re-mints for itself, and specifically its behaviour when the first ask
// CANNOT work: these chips render on the first frame, before the app knows the sandbox's address, so "the fetch
// failed" is the ordinary case here rather than the exceptional one. What is pinned is which failures are worth
// another go and which are final — the difference between a screenshot that comes back and a permanent
// `image.png` chip.
import { beforeEach, expect, it, vi } from "vitest";
import { nextTick, ref } from "vue";

const blob = vi.fn<(path: string) => Promise<Blob>>();
// The resolved daemon address, exactly as useEndpoint hands it out: undefined until sandbox.list lands.
const daemonBase = ref<string | undefined>(undefined);

class HttpError extends Error {
    constructor(readonly status: number) {
        super(`http ${status}`);
    }
}

vi.mock("../sandbox/sandboxClient", () => ({ sandboxBlob: (path: string) => blob(path), SandboxHttpError: HttpError }));
vi.mock("../sandbox/useEndpoint", () => ({ useEndpoint: () => ({ daemonBase }) }));

const { attachmentPreview } = await import("./attachmentPreviews");

// The module caches per path for the life of the page, so each case needs a path of its own.
let counter = 0;
const freshPath = (): string => `.intentic/records/artifacts/attachments/u${++counter}/shot.png`;

// Let the address watcher flush and the pending .then callbacks run, without advancing the retry timers.
const settle = async (): Promise<void> => {
    await nextTick();
    await Promise.resolve();
    await Promise.resolve();
};

beforeEach(() => {
    blob.mockReset();
    daemonBase.value = undefined;
    vi.useFakeTimers();
    globalThis.URL.createObjectURL = vi.fn(() => `blob:thumb`);
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

// THE REPORTED BUG. The chips paint before there is anywhere to send the request, and the answer used to park
// the path for good — a killed and restarted dev server showed `image.png` where the screenshot had been.
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

    await vi.advanceTimersByTimeAsync(200);
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
    await vi.advanceTimersByTimeAsync(30_000);
    await settle();

    expect(blob).toHaveBeenCalledTimes(1);
    expect(attachmentPreview(path)).toBeUndefined();
});

it("leaves a non-image attachment as a name chip without touching the daemon", () => {
    expect(attachmentPreview(`.intentic/records/artifacts/attachments/u9/notes.pdf`)).toBeUndefined();
    expect(blob).not.toHaveBeenCalled();
});

it("gives up on a chain that never lands, without a chip that polls forever", async () => {
    const path = freshPath();
    blob.mockRejectedValue(new Error(`network down`));

    attachmentPreview(path);
    await vi.advanceTimersByTimeAsync(60_000);
    await settle();

    // The five backed-off tries after the first, and then silence.
    expect(blob).toHaveBeenCalledTimes(6);
});
