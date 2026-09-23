// Where a conversation's pictures are read from and in which encoding: the daemon's strip tile and re-encoded view
// rather than the file, AVIF asked for only where this engine decodes it, the sandbox's shared state read unscoped,
// and every final refusal answered as nothing to draw rather than a fetch that never ends.
import { it, expect, beforeEach, afterEach, mock } from "bun:test";
import { nextTick, ref } from "vue";
import { STATE_DIR } from "@intentic/constants";
import { freshImport } from "@intentic/testing/bun";
import { SandboxHttpError } from "../../../sandbox/client/sandboxHttpError";

const blob = mock<(path: string, init?: RequestInit) => Promise<Blob>>();
const daemonBase = ref<string | undefined>(`https://sandbox-1.example`);

// A daemon refusal, as the raw client throws it.
const refusal = (status: number): SandboxHttpError => new SandboxHttpError(status, `Request failed (${status}).`);

mock.module("../../../sandbox/client/sandboxClient", () => ({ sandboxBlob: (path: string, init?: RequestInit) => blob(path, init) }));
mock.module("../../../sandbox/secrets/useEndpoint", () => ({ useEndpoint: () => ({ daemonBase }) }));

type Pictures = typeof import("./shotPictures");
// Fresh per case: the caches and the AVIF answer live for a page, and each case is its own page.
const load = (): Promise<Pictures> => freshImport<Pictures>("./shotPictures", import.meta.url);

const SHOT = `${STATE_DIR}/records/artifacts/browser/after.png`;
const REPO_SHOT = `intentic/.cache/shots/after.png`;

const settle = async (): Promise<void> => {
    await nextTick();
    for (let turn = 0; turn < 6; turn += 1) {
        await Promise.resolve();
    }
};

const asked = (): { route: string; accept: string | null }[] =>
    blob.mock.calls.map(([route, init]) => ({ route, accept: new Headers(init?.headers).get(`accept`) }));

const query = (params: Record<string, string>): string => new URLSearchParams(params).toString();

// jsdom decodes nothing, so a case about an engine that draws AVIF says so by standing in `decode` and its answer.
const decodesAvif = (): void => {
    Object.defineProperty(HTMLImageElement.prototype, `decode`, { configurable: true, value: () => Promise.resolve() });
    Object.defineProperty(HTMLImageElement.prototype, `naturalWidth`, { configurable: true, get: () => 1 });
};

beforeEach(() => {
    blob.mockReset();
    blob.mockResolvedValue(new Blob([`x`]));
    globalThis.URL.createObjectURL = mock(() => `blob:picture`);
});

afterEach(() => {
    Reflect.deleteProperty(HTMLImageElement.prototype, `decode`);
    Reflect.deleteProperty(HTMLImageElement.prototype, `naturalWidth`);
});

it(`draws a strip tile from the daemon's strip rendition, in WebP`, async () => {
    const { stripOf } = await load();
    expect(stripOf(`cnv-1`, SHOT)).toBeUndefined();
    await settle();
    expect(asked()).toEqual([{ route: `/workspace/thumb?${query({ path: SHOT, size: `strip` })}`, accept: `image/webp` }]);
    expect(stripOf(`cnv-1`, SHOT)).toEqual({ url: `blob:picture` });
});

it(`asks for the view in AVIF where this engine decodes it`, async () => {
    decodesAvif();
    const { viewOf } = await load();
    viewOf(undefined, SHOT);
    await settle();
    expect(asked()).toEqual([{ route: `/workspace/thumb?${query({ path: SHOT, size: `view` })}`, accept: `image/avif,image/webp` }]);
});

it(`asks for the view in WebP where this engine cannot say it decodes AVIF`, async () => {
    const { viewOf } = await load();
    viewOf(undefined, SHOT);
    await settle();
    expect(asked()).toEqual([{ route: `/workspace/thumb?${query({ path: SHOT, size: `view` })}`, accept: `image/webp` }]);
});

// An archived conversation's checkout is gone, and a scoped read of it answers 412 even for the shared state.
it(`reads the sandbox's shared state unscoped, and a checkout's own file in its scope`, async () => {
    const { viewOf } = await load();
    viewOf(`cnv-1`, SHOT);
    viewOf(`cnv-1`, REPO_SHOT);
    await settle();
    expect(asked().map(({ route }) => route)).toEqual([
        `/workspace/thumb?${query({ path: SHOT, size: `view` })}`,
        `/workspace/thumb?${query({ path: REPO_SHOT, agent: `cnv-1`, size: `view` })}`,
    ]);
});

it(`reads the original file only when asked for it`, async () => {
    const { originalOf } = await load();
    originalOf(`cnv-1`, REPO_SHOT);
    await settle();
    expect(asked()).toEqual([{ route: `/workspace/raw?${query({ path: REPO_SHOT, agent: `cnv-1` })}`, accept: null }]);
    expect(originalOf(`cnv-1`, REPO_SHOT)).toEqual({ url: `blob:picture` });
});

it(`draws a picture the daemon will not re-encode from the file itself`, async () => {
    const { viewOf } = await load();
    const svg = `${STATE_DIR}/records/artifacts/browser/sweep.svg`;
    blob.mockImplementation(async (route) => {
        if (route.startsWith(`/workspace/thumb`)) {
            throw refusal(415);
        }
        return new Blob([`<svg/>`]);
    });
    viewOf(undefined, svg);
    await settle();
    expect(asked().map(({ route }) => route.split(`?`)[0])).toEqual([`/workspace/thumb`, `/workspace/raw`]);
    expect(viewOf(undefined, svg)).toEqual({ url: `blob:picture` });
});

it.each([400, 403, 404, 412, 413])(`a %i is nothing to draw, answered as such rather than left loading`, async (status) => {
    const { stripOf, viewOf, originalOf } = await load();
    blob.mockRejectedValue(refusal(status));
    stripOf(`cnv-1`, REPO_SHOT);
    viewOf(`cnv-1`, REPO_SHOT);
    originalOf(`cnv-1`, REPO_SHOT);
    await settle();
    expect([stripOf(`cnv-1`, REPO_SHOT), viewOf(`cnv-1`, REPO_SHOT), originalOf(`cnv-1`, REPO_SHOT)]).toEqual([
        { url: undefined },
        { url: undefined },
        { url: undefined },
    ]);
});

it(`downloads the original under its own name`, async () => {
    const { downloadOriginal } = await load();
    const clicked: { href: string; download: string }[] = [];
    const click = mock(function (this: HTMLAnchorElement) {
        clicked.push({ href: this.href, download: this.download });
    });
    const original = HTMLAnchorElement.prototype.click;
    HTMLAnchorElement.prototype.click = click;
    try {
        await downloadOriginal(`cnv-1`, SHOT);
    } finally {
        HTMLAnchorElement.prototype.click = original;
    }
    expect(asked()).toEqual([{ route: `/workspace/raw?${query({ path: SHOT })}`, accept: null }]);
    expect(clicked).toEqual([{ href: `blob:picture`, download: `after.png` }]);
});
