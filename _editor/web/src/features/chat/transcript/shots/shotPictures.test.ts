// Where a conversation's pictures are read from and what a final refusal turns into: the conversation's own scope,
// the daemon's tile first with the file as the fallback for what it won't downscale, and "nothing there" as a state a
// tile can draw rather than a fetch that never ends.
import { it, expect, beforeEach, mock } from "bun:test";
import { nextTick, ref } from "vue";
import { STATE_DIR } from "@intentic/constants";

const blob = mock<(path: string) => Promise<Blob>>();
const daemonBase = ref<string | undefined>(`https://sandbox-1.example`);

class HttpError extends Error {
    constructor(readonly status: number) {
        super(`http ${status}`);
    }
}

mock.module("../../../sandbox/client/sandboxClient", () => ({ sandboxBlob: (path: string) => blob(path), SandboxHttpError: HttpError }));
mock.module("../../../sandbox/secrets/useEndpoint", () => ({ useEndpoint: () => ({ daemonBase }) }));

const { pictureAt, tileOf } = await import("./shotPictures");

// Both caches live for the page, so each case asks about a path of its own.
let counter = 0;
const freshPath = (): string => `${STATE_DIR}/records/artifacts/browser/shot-${++counter}.png`;

const settle = async (): Promise<void> => {
    await nextTick();
    for (let turn = 0; turn < 4; turn += 1) {
        // oxlint-disable-next-line eslint/no-await-in-loop -- each pass lets one more chained .then run
        await Promise.resolve();
    }
};

beforeEach(() => {
    blob.mockReset();
    globalThis.URL.createObjectURL = mock(() => `blob:picture`);
});

it(`reads the picture itself in the conversation's own scope`, async () => {
    const path = freshPath();
    blob.mockResolvedValue(new Blob([`x`]));

    expect(pictureAt(`cnv-1`, path)).toBeUndefined();
    await settle();

    expect(blob).toHaveBeenCalledWith(`/workspace/raw?${new URLSearchParams({ path, agent: `cnv-1` }).toString()}`);
    expect(pictureAt(`cnv-1`, path)).toEqual({ url: `blob:picture` });
});

it(`reads the shared tree when the conversation has no checkout of its own, and keeps the two apart`, async () => {
    const path = freshPath();
    blob.mockResolvedValue(new Blob([`x`]));

    pictureAt(undefined, path);
    pictureAt(`cnv-2`, path);
    await settle();

    expect(blob.mock.calls.map(([asked]) => asked)).toEqual([
        `/workspace/raw?${new URLSearchParams({ path }).toString()}`,
        `/workspace/raw?${new URLSearchParams({ path, agent: `cnv-2` }).toString()}`,
    ]);
});

it(`draws a tile from the daemon's downscaled copy`, async () => {
    const path = freshPath();
    blob.mockResolvedValue(new Blob([`x`]));

    tileOf(undefined, path);
    await settle();

    expect(blob.mock.calls.map(([asked]) => asked)).toEqual([`/workspace/thumb?${new URLSearchParams({ path }).toString()}`]);
    expect(tileOf(undefined, path)).toEqual({ url: `blob:picture` });
});

it(`draws a tile the daemon won't downscale from the file itself`, async () => {
    const path = `${STATE_DIR}/records/artifacts/browser/sweep-${++counter}.svg`;
    blob.mockImplementation(async (asked) => {
        if (asked.startsWith(`/workspace/thumb`)) {
            throw new HttpError(415);
        }
        return new Blob([`<svg/>`]);
    });

    tileOf(undefined, path);
    await settle();

    expect(blob.mock.calls.map(([asked]) => asked.split(`?`)[0])).toEqual([`/workspace/thumb`, `/workspace/raw`]);
    expect(tileOf(undefined, path)).toEqual({ url: `blob:picture` });
});

it.each([400, 403, 404, 413])(`a %i is nothing to draw, answered as such rather than left loading`, async (status) => {
    const path = freshPath();
    blob.mockRejectedValue(new HttpError(status));

    pictureAt(undefined, path);
    tileOf(undefined, path);
    await settle();

    expect([pictureAt(undefined, path), tileOf(undefined, path)]).toEqual([{ url: undefined }, { url: undefined }]);
});
