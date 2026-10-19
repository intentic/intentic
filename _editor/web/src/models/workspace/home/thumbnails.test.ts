// Where a picture is read from and in which encoding; a final refusal is nothing to draw, never a fetch that never ends.
import { nextTick, ref } from "vue";
import { STATE_DIR } from "@intentic/constants";
import { freshImport } from "@intentic/testing/bun";
import { SandboxHttpError } from "../../../client/sandbox/sandboxHttpError";

const blob = jest.fn<(path: string, init?: RequestInit) => Promise<Blob>>();
const daemonBase = ref<string | undefined>(`https://sandbox-1.example`);

// A daemon refusal, as the raw client throws it.
const refusal = (status: number): SandboxHttpError => new SandboxHttpError(status, `Request failed (${status}).`);

jest.mock("../../../client/sandbox/sandboxClient", () => ({ sandboxBlob: (path: string, init?: RequestInit) => blob(path, init) }));
jest.mock("../../../client/endpoint/useEndpoint", () => ({ useEndpoint: () => ({ daemonBase }) }));
// A video the daemon cannot cut a frame of is handed to a player, which streams it on a ticket.
const mediaTicket = jest.fn(async () => ({ ticket: `t-1`, expiresAt: 0 }));
jest.mock("../../../client/sandbox/sandboxRpc", () => ({ sandboxRpc: { workspace: { mediaTicket } } }));

type Pictures = typeof import("./thumbnails");
// Fresh per case: the caches and the AVIF answer live for a page, and each case is its own page.
const load = (): Promise<Pictures> => freshImport<Pictures>("./thumbnails", import.meta.url);

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
    globalThis.URL.createObjectURL = jest.fn(() => `blob:picture`);
});

afterEach(() => {
    Reflect.deleteProperty(HTMLImageElement.prototype, `decode`);
    Reflect.deleteProperty(HTMLImageElement.prototype, `naturalWidth`);
});

it(`draws a strip tile from the daemon's strip rendition, in WebP`, async () => {
    const { picture } = await load();
    expect(picture(`cnv-1`, SHOT, `strip`)).toBeUndefined();
    await settle();
    expect(asked()).toEqual([{ route: `/workspace/thumb?${query({ path: SHOT, size: `strip` })}`, accept: `image/webp` }]);
    expect(picture(`cnv-1`, SHOT, `strip`)).toEqual({ url: `blob:picture` });
});

it(`asks for the view in AVIF where this engine decodes it`, async () => {
    decodesAvif();
    const { picture } = await load();
    picture(undefined, SHOT, `view`);
    await settle();
    expect(asked()).toEqual([{ route: `/workspace/thumb?${query({ path: SHOT, size: `view` })}`, accept: `image/avif,image/webp` }]);
});

it(`asks for the view in WebP where this engine cannot say it decodes AVIF`, async () => {
    const { picture } = await load();
    picture(undefined, SHOT, `view`);
    await settle();
    expect(asked()).toEqual([{ route: `/workspace/thumb?${query({ path: SHOT, size: `view` })}`, accept: `image/webp` }]);
});

// An archived conversation's checkout is gone, and a scoped read of it answers 412 even for the shared state.
it(`reads the sandbox's shared state unscoped, and a checkout's own file in its scope`, async () => {
    const { picture } = await load();
    picture(`cnv-1`, SHOT, `view`);
    picture(`cnv-1`, REPO_SHOT, `view`);
    await settle();
    expect(asked().map(({ route }) => route)).toEqual([
        `/workspace/thumb?${query({ path: SHOT, size: `view` })}`,
        `/workspace/thumb?${query({ path: REPO_SHOT, agent: `cnv-1`, size: `view` })}`,
    ]);
});

it(`reads the original file only when asked for it`, async () => {
    const { picture } = await load();
    picture(`cnv-1`, REPO_SHOT, `original`);
    await settle();
    expect(asked()).toEqual([{ route: `/workspace/raw?${query({ path: REPO_SHOT, agent: `cnv-1` })}`, accept: null }]);
    expect(picture(`cnv-1`, REPO_SHOT, `original`)).toEqual({ url: `blob:picture` });
});

it(`draws a picture the daemon will not re-encode from the file itself`, async () => {
    const { picture } = await load();
    const svg = `${STATE_DIR}/records/artifacts/browser/sweep.svg`;
    blob.mockImplementation(async (route) => {
        if (route.startsWith(`/workspace/thumb`)) {
            throw refusal(415);
        }
        return new Blob([`<svg/>`]);
    });
    picture(undefined, svg, `view`);
    await settle();
    expect(asked().map(({ route }) => route.split(`?`)[0])).toEqual([`/workspace/thumb`, `/workspace/raw`]);
    expect(picture(undefined, svg, `view`)).toEqual({ url: `blob:picture` });
});

it.each([400, 403, 404, 412, 413])(`a %i is nothing to draw, answered as such rather than left loading`, async (status) => {
    const { picture } = await load();
    blob.mockRejectedValue(refusal(status));
    picture(`cnv-1`, REPO_SHOT, `strip`);
    picture(`cnv-1`, REPO_SHOT, `view`);
    picture(`cnv-1`, REPO_SHOT, `original`);
    await settle();
    expect([picture(`cnv-1`, REPO_SHOT, `strip`), picture(`cnv-1`, REPO_SHOT, `view`), picture(`cnv-1`, REPO_SHOT, `original`)]).toEqual([
        { url: undefined },
        { url: undefined },
        { url: undefined },
    ]);
});

it(`downloads the original under its own name`, async () => {
    const { downloadOriginal } = await load();
    const clicked: { href: string; download: string }[] = [];
    const click = jest.fn(function (this: HTMLAnchorElement) {
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

describe(`what a home tile draws`, () => {
    const film = { name: `warcry.mp4`, path: `public/warcry.mp4`, type: `file` as const, size: 30_000_000 };
    const shot = { name: `after.png`, path: REPO_SHOT, type: `file` as const, size: 180_000 };
    const sizesAsked = (): (string | null)[] => asked().map(({ route }) => new URLSearchParams(route.split(`?`)[1]).get(`size`));

    it(`draws a video as the frame the daemon cut at the edge asked, never asking for the video itself`, async () => {
        const { tileArt } = await load();
        expect(await tileArt(film, `video`, 512)).toEqual({ url: `blob:picture`, as: `picture`, edge: 512, bytes: 1 });
        expect(asked()).toEqual([{ route: `/workspace/thumb?${query({ path: film.path, size: `e512` })}`, accept: `image/webp` }]);
        expect(mediaTicket).not.toHaveBeenCalled();
    });

    it.each([400, 415])(`hands a video to a player where the daemon answers %i for its frame`, async (status) => {
        const { tileArt } = await load();
        blob.mockRejectedValue(refusal(status));
        const art = await tileArt(film, `video`, 256);
        expect(art.as).toBe(`video`);
        expect(art.url).toContain(`/workspace/media?`);
        // Never the raw route, which would move the whole film to draw a tile.
        expect(asked().map(({ route }) => route.split(`?`)[0])).toEqual([`/workspace/thumb`]);
    });

    it(`asks a large box's edge in AVIF where this engine decodes it, and a tile's in WebP`, async () => {
        decodesAvif();
        const { tileArt } = await load();
        await tileArt(shot, `picture`, 1536);
        await tileArt(shot, `picture`, 256);
        expect(asked().map(({ accept }) => accept)).toEqual([`image/avif,image/webp`, `image/webp`]);
        expect(sizesAsked()).toEqual([`e1536`, `tile`]);
    });

    it(`takes the viewer's rendition, as the largest edge, where a sandbox does not know the edges`, async () => {
        const { tileArt } = await load();
        blob.mockImplementation(async (route) => {
            if (route.includes(`size=e768`)) {
                throw refusal(400);
            }
            return new Blob([`x`]);
        });
        expect(await tileArt(shot, `picture`, 768)).toEqual({ url: `blob:picture`, as: `picture`, edge: 2048, bytes: 1 });
        expect(sizesAsked()).toEqual([`e768`, `view`]);
    });

    it(`asks once for a burst of tiles wanting one picture at one edge, and again for another edge`, async () => {
        const { tileArt } = await load();
        await Promise.all([tileArt(shot, `picture`), tileArt(shot, `picture`), tileArt(shot, `picture`, 768)]);
        expect(sizesAsked()).toEqual([`tile`, `e768`]);
    });

    it(`keeps the largest picture on hand for a larger look to show while its own arrives`, async () => {
        const { tileArt, heldArt } = await load();
        let made = 0;
        globalThis.URL.createObjectURL = jest.fn(() => `blob:${(made += 1)}`);
        expect(heldArt(shot)).toBeUndefined();
        await tileArt(shot, `picture`, 768);
        await tileArt(shot, `picture`, 256);
        expect(heldArt(shot)).toMatchObject({ url: `blob:1`, edge: 768 });
    });

    it(`lets the least recently asked pictures go once they hold more than the budget`, async () => {
        const { tileArt, heldArt } = await load();
        let made = 0;
        globalThis.URL.createObjectURL = jest.fn(() => `blob:${(made += 1)}`);
        const revoked: string[] = [];
        globalThis.URL.revokeObjectURL = jest.fn((url: string) => void revoked.push(url));
        // Forty megabytes each, against a budget of ninety-six.
        blob.mockImplementation(async () => new Blob([new Uint8Array(40 * 1024 * 1024)]));
        const pictures = [`a`, `b`, `c`].map((name) => ({ name: `${name}.png`, path: `shots/${name}.png`, type: `file` as const, size: 1 }));
        await tileArt(pictures[0]!, `picture`, 2048);
        await tileArt(pictures[1]!, `picture`, 2048);
        // Asked again, so the first is the recent one and the second the one to go.
        await tileArt(pictures[0]!, `picture`, 2048);
        await tileArt(pictures[2]!, `picture`, 2048);
        await settle();
        expect(revoked).toEqual([`blob:2`]);
        expect(heldArt(pictures[1]!)).toBeUndefined();
        expect(heldArt(pictures[0]!)).toMatchObject({ url: `blob:1` });
    });
});
