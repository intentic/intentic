// A shown page's video and audio as the chat's frame draws them: each `intentic-media:<n>` reference becomes an address
// under a ticket minted for that one page, and the page's seal opens `media-src` to exactly those addresses.
import { nextTick, ref } from "vue";
import { STATE_DIR } from "@intentic/constants";
import { intoHead, PAGE_FALLBACK_THEMES, pageMediaScript, SEALED_PAGE_POLICY, sealedPagePolicy } from "@intentic/sandbox-contract/text/pages";
import { freshImport } from "@intentic/testing/bun";

const stored = new Map<string, string>();
const daemonBase = ref<string | undefined>(`https://sandbox-1.example`);
let minted = 0;
const mediaTicket = jest.fn(async (_input: { page: string }) => ({ ticket: `t/${++minted}`, expiresAt: Date.now() + 8 * 60 * 60 * 1000 }));
// What the daemon answers a ticket check with (`mediaFailed`), and the window's connection and session.
const checked = jest.fn(async (_path: string) => new Response(null, { status: 401 }));
const reachable = ref(true);
const presentedEmail = ref<string | undefined>(`ada@example.com`);

jest.mock("../../../../client/sandbox/sandboxClient", () => ({
    sandboxBlob: async (path: string) => {
        const page = new URLSearchParams(path.slice(path.indexOf(`?`) + 1)).get(`path`) ?? ``;
        const text = stored.get(page);
        if (text === undefined) {
            throw new Error(`no such file`);
        }
        return new Blob([text]);
    },
    sandboxRequest: (path: string) => checked(path),
}));
jest.mock("../../../../client/sandbox/useSandbox", () => ({ useSandbox: () => ({ reachable }) }));
jest.mock("../../../../client/session/sandboxSession", () => ({ useSandboxSession: () => ({ presentedEmail }) }));
jest.mock("../../../../client/endpoint/useEndpoint", () => ({ useEndpoint: () => ({ daemonBase }) }));
jest.mock("../../../../client/sandbox/sandboxRpc", () => ({ sandboxRpc: { pages: { mediaTicket } } }));

type PageDocument = typeof import("./pageDocument");
const load = (): Promise<PageDocument> => freshImport<PageDocument>("./pageDocument", import.meta.url);

const PAGES = `${STATE_DIR}/records/artifacts/pages/c1`;
const TAKE = { path: `/work/shots/take1.mp4`, type: `video/mp4`, size: 12_000_000, mtimeMs: 1 };
const policyOf = (html: string): string | undefined => new DOMParser().parseFromString(html, `text/html`).querySelector(`meta[http-equiv="Content-Security-Policy"]`)?.getAttribute(`content`) ?? undefined;

beforeEach(() => {
    stored.clear();
    mediaTicket.mockClear();
    checked.mockClear();
    minted = 0;
    reachable.value = true;
    presentedEmail.value = `ada@example.com`;
});

test("a page that streams takes plays them from addresses under its own ticket, and its seal admits only those", async () => {
    const path = `${PAGES}/a1b2c3d4e5.r0.html`;
    stored.set(
        path,
        intoHead(
            `<video src="intentic-media:0" controls></video><video src="intentic-media:1"></video><script>const t=["intentic-media:1"]</script>`,
            pageMediaScript({ files: [TAKE, { ...TAKE, path: `/work/shots/take2.mp4` }], signature: `s` }),
        ),
    );
    const { buildPageDocument } = await load();
    const built = await buildPageDocument({ id: `a1b2c3d4e5`, title: `Takes`, path }, PAGE_FALLBACK_THEMES.dark);
    const first = `https://sandbox-1.example/pages/media/t%2F1/0`;
    const second = `https://sandbox-1.example/pages/media/t%2F1/1`;
    expect(mediaTicket).toHaveBeenCalledTimes(1);
    expect(mediaTicket).toHaveBeenCalledWith({ page: path });
    expect(built.html).toContain(`<video src="${first}" controls=""></video><video src="${second}"></video>`);
    expect(built.html).toContain(`const t=["${second}"]`);
    expect(policyOf(built.html)).toBe(sealedPagePolicy([first, second]));
});

test("a page that names no media mints nothing and keeps the plain seal", async () => {
    const path = `${PAGES}/f0f0f0f0f0.r0.html`;
    stored.set(path, `<p>a chart</p>`);
    const { buildPageDocument } = await load();
    const built = await buildPageDocument({ id: `f0f0f0f0f0`, title: `Chart`, path }, PAGE_FALLBACK_THEMES.dark);
    expect(mediaTicket).not.toHaveBeenCalled();
    expect(policyOf(built.html)).toBe(SEALED_PAGE_POLICY);
});

test("a page whose ticket cannot be minted still draws, its players empty and its seal shut", async () => {
    const path = `${PAGES}/0a0a0a0a0a.r0.html`;
    stored.set(path, intoHead(`<video src="intentic-media:0"></video>`, pageMediaScript({ files: [TAKE], signature: `s` })));
    mediaTicket.mockImplementationOnce(async () => {
        throw new Error(`refused`);
    });
    const { buildPageDocument } = await load();
    const built = await buildPageDocument({ id: `0a0a0a0a0a`, title: `Takes`, path }, PAGE_FALLBACK_THEMES.dark);
    expect(built.html).toContain(`<video src="intentic-media:0"></video>`);
    expect(policyOf(built.html)).toBe(SEALED_PAGE_POLICY);
});

test("a kept ticket is reused, and let go when the sandbox comes back online, the session's person changes, or the daemon refuses it", async () => {
    const path = `${PAGES}/1b1b1b1b1b.r0.html`;
    stored.set(path, intoHead(`<video src="intentic-media:0"></video>`, pageMediaScript({ files: [TAKE], signature: `s` })));
    const { buildPageDocument, mediaFailed } = await load();
    const draw = async (): Promise<string> => (await buildPageDocument({ id: `1b1b1b1b1b`, title: `Takes`, path }, PAGE_FALLBACK_THEMES.dark)).html;
    const ticketIn = (html: string): string | undefined => /pages\/media\/t%2F(\d+)\/0/.exec(html)?.[1];

    expect(ticketIn(await draw())).toBe(`1`);
    expect(ticketIn(await draw())).toBe(`1`);

    reachable.value = false;
    await nextTick();
    reachable.value = true;
    await nextTick();
    expect(ticketIn(await draw())).toBe(`2`);

    presentedEmail.value = `bo@example.com`;
    await nextTick();
    expect(ticketIn(await draw())).toBe(`3`);

    // A player that failed on a ticket the daemon still takes keeps it; one it refuses (401) is let go.
    checked.mockImplementationOnce(async () => new Response(null, { status: 409 }));
    await mediaFailed(path);
    expect(checked).toHaveBeenCalledWith(`/pages/media/t%2F3/0`);
    expect(ticketIn(await draw())).toBe(`3`);
    await mediaFailed(path);
    expect(ticketIn(await draw())).toBe(`4`);
});
