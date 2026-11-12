import { collectPage } from "../../page/driver.js";
import { dropStaged, findFileInput, mediaOfRef, putFile, readStaged, receiveFileSlice, stageMedia } from "../../page/media-driver.js";
import { askConfirm } from "../../page/overlay.js";
import { handleMcpMessage } from "../mcp.js";
import { store } from "../store.js";
import { keptFromAddress, sniffType, toBase64, verifiedType } from "./media.js";
import { withCapturedDownloads } from "./media-downloads.js";

// The extension's half of moving files between a page and the sandbox: what is fetched where, what reaches the sandbox's
// doors and with what, what the person is asked, and what the agent reads. The page is stood in for by which injected
// function ran with what; the page side itself is page/media-driver.test.ts, the sandbox's doors its own route tests.

const SANDBOX = "https://sandbox-1.example.dev";
const PAGE = "https://chatgpt.com/c/1";
const PNG = Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13]);
// Where the sandbox says it put the file: opaque to the extension, which passes it on as it came.
const SAVED = `/shelf/chrome/Generated-image-1.png`;

interface Injected {
    readonly name: string;
    readonly args: unknown[];
}
interface Posted {
    readonly url: string;
    readonly headers: Record<string, string>;
    readonly body: Uint8Array;
}

const NAMES = new Map<unknown, string>([
    [mediaOfRef, "media"],
    [stageMedia, "stage"],
    [readStaged, "read"],
    [dropStaged, "drop"],
    [findFileInput, "find"],
    [receiveFileSlice, "slice"],
    [putFile, "put"],
    [askConfirm, "ask"],
    [collectPage, "snapshot"],
]);

let injected: Injected[] = [];
let posted: Posted[] = [];
// What the page answers each injected function with, by name.
let page = new Map<string, unknown>();
// What a URL fetched by the worker answers, by URL; the sandbox's doors included.
let web = new Map<string, () => Response>();
let allowed = true;
let downloadListener: ((item: chrome.DownloadItem) => void) | undefined;
let downloadCalls: string[] = [];

const realFetch = globalThis.fetch;

const area = (storage: Map<string, unknown>) => ({
    get: async (keys: string[]) => Object.fromEntries(keys.filter((key) => storage.has(key)).map((key) => [key, storage.get(key)])),
    set: async (items: Record<string, unknown>) => {
        for (const [key, value] of Object.entries(items)) {
            storage.set(key, value);
        }
    },
    remove: async (keys: string[]) => {
        for (const key of keys) {
            storage.delete(key);
        }
    },
});

const ran = (name: string): Injected[] => injected.filter((call) => call.name === name);

beforeEach(async () => {
    injected = [];
    posted = [];
    allowed = true;
    downloadListener = undefined;
    downloadCalls = [];
    page = new Map(Object.entries({
        media: { ok: true, url: "https://chatgpt.com/backend-api/estuary/content?id=1", kind: "image", name: "Generated image 1", message: "" },
        stage: { ok: true, bytes: PNG.byteLength, type: "image/png", message: "" },
        read: { ok: true, data: toBase64(PNG) },
        drop: true,
        find: { ok: true, message: "" },
        slice: true,
        put: { ok: true, message: "attached" },
        ask: true,
        snapshot: { url: PAGE, title: "Chat", truncated: false, loading: false, elements: [] },
    }));
    web = new Map([[`${SANDBOX}/system/webext/media`, () => Response.json({ ok: true, path: SAVED, bytes: PNG.byteLength, mimeType: "image/png" })]]);
    const storage = new Map<string, unknown>();
    // Window 1 is the agent's own (agent-window.ts), its tab 7 on ChatGPT.
    const session = new Map<string, unknown>([["agentWindows", { [SANDBOX]: 1 }]]);
    const tab = { id: 7, windowId: 1, active: true, url: PAGE, title: "Chat" };
    Object.assign(globalThis, {
        chrome: {
            storage: { local: area(storage), session: area(session) },
            tabs: { query: async () => [tab], get: async (id: number) => ({ ...tab, id }) },
            windows: {
                get: async (id: number) => ({ id, focused: true, state: "normal", tabs: [tab] }),
                update: async (id: number) => ({ id, focused: true }),
            },
            action: { setBadgeText: async () => undefined, setBadgeBackgroundColor: async () => undefined, setTitle: async () => undefined, openPopup: async () => undefined },
            permissions: { contains: async () => allowed },
            scripting: {
                executeScript: async (injection: { func: unknown; args?: unknown[] }) => {
                    const name = NAMES.get(injection.func) ?? "banner";
                    injected.push({ name, args: injection.args ?? [] });
                    return [{ frameId: 0, result: page.get(name) ?? true }];
                },
            },
            downloads: {
                search: async ({ id }: { id: number }) => [{ id, state: "complete" }],
                cancel: async () => undefined,
                removeFile: async (id: number) => void downloadCalls.push(`removeFile ${id}`),
                erase: async ({ id }: { id: number }) => {
                    downloadCalls.push(`erase ${id}`);
                    return [id];
                },
                onCreated: { addListener: (listener: (item: chrome.DownloadItem) => void) => (downloadListener = listener) },
                onChanged: { addListener: () => undefined },
            },
            runtime: { getManifest: () => ({ version: "0.1.0", name: "Intentic" }) },
        },
    });
    globalThis.fetch = Object.assign(
        async (url: string | URL | Request, init?: RequestInit) => {
            const body = init?.body instanceof Blob ? new Uint8Array(await init.body.arrayBuffer()) : new TextEncoder().encode(String(init?.body ?? ""));
            posted.push({ url: String(url), headers: Object.fromEntries(new Headers(init?.headers).entries()), body });
            const answer = web.get(String(url));
            if (answer === undefined) {
                throw new TypeError("Failed to fetch");
            }
            return answer();
        },
        { preconnect: realFetch.preconnect },
    );
    await store.addSandbox({ url: SANDBOX, token: "iwx_token" });
    await store.setScopes(SANDBOX, { read: "on", act: "on", screenshot: "off", cookies: "off", scripts: "off", confirm: "sensitive" });
    await store.setMode("https://chatgpt.com/*", "read");
});

afterEach(() => {
    globalThis.fetch = realFetch;
});

const call = async (name: string, args: Record<string, unknown>) => {
    const answer = await handleMcpMessage({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name, arguments: args } }, SANDBOX);
    // SAFETY: a tools/call is always answered with a result envelope (peer-mcp-server.ts), a failure as isError.
    const result = (answer as { result: { content: { text: string }[]; isError: boolean } }).result;
    return { text: result.content.map((block) => block.text).join("\n"), isError: result.isError };
};

test("the bytes decide what a file is, and a web page or a contradicted claim is refused", () => {
    expect(sniffType(PNG)).toBe("image/png");
    expect(sniffType(Uint8Array.from([0xff, 0xd8, 0xff, 0xe0]))).toBe("image/jpeg");
    expect(sniffType(new TextEncoder().encode("\x00\x00\x00\x18ftypmp42"))).toBe("video/mp4");
    expect(sniffType(new TextEncoder().encode("RIFF\x00\x00\x00\x00WEBPVP8 "))).toBe("image/webp");
    expect(sniffType(new TextEncoder().encode("  <!DOCTYPE html><html>"))).toBe("text/html");
    expect(verifiedType(PNG, "application/octet-stream")).toBe("image/png");
    expect(verifiedType(new TextEncoder().encode("plain words"), "text/plain; charset=utf-8")).toBe("text/plain");
    expect(() => verifiedType(new TextEncoder().encode("<html><body>Sign in</body></html>"), "image/png")).toThrow(/web page/);
    expect(() => verifiedType(new TextEncoder().encode("%PDF-1.7"), "image/png")).toThrow(/its bytes are application\/pdf/);
    expect(() => verifiedType(new TextEncoder().encode("not a png"), "image/png")).toThrow(/its bytes are not one/);
});

test("save_media by ref fetches in the page, reads it out, and hands the raw bytes to the sandbox's own door", async () => {
    const saved = await call("save_media", { ref: "e129" });
    expect(saved.isError).toBe(false);
    expect(saved.text).toContain(`Saved 12 bytes (image/png) to ${SAVED}`);
    expect(ran("media").map((each) => each.args)).toEqual([["e129"]]);
    const [url, slot, cap] = ran("stage")[0]?.args ?? [];
    expect(url).toBe("https://chatgpt.com/backend-api/estuary/content?id=1");
    expect(cap).toBe(50 * 1024 * 1024);
    expect(ran("read").map((each) => each.args[0])).toEqual([slot]);
    expect(ran("drop").map((each) => each.args)).toEqual([[slot]]);
    // On this browser's token, as the raw body, the page's name for it beside.
    expect(posted).toHaveLength(1);
    expect(posted[0]?.url).toBe(`${SANDBOX}/system/webext/media`);
    expect(posted[0]?.headers).toMatchObject({ authorization: "Bearer iwx_token", "content-type": "image/png", "x-intentic-name": "Generated%20image%201", "x-intentic-source": "chatgpt.com" });
    expect(posted[0]?.body).toEqual(PNG);
});

test("save_media takes exactly one of ref and url, and refuses a site the agent may not read before touching it", async () => {
    expect((await call("save_media", {})).isError).toBe(true);
    expect((await call("save_media", { ref: "e1", url: "https://x" })).text).toContain(`not both`);
    allowed = false;
    const refused = await call("save_media", { url: "/a.png" });
    expect(refused.isError).toBe(true);
    expect(injected).toEqual([]);
    expect(posted).toEqual([]);
});

test("a file the page could not fetch from another site is fetched by this browser only from a site the agent may work on", async () => {
    page.set("stage", { ok: false, reason: "fetch", bytes: 0, type: "", message: "Failed to fetch" });
    await store.setMode("https://chatgpt.com/*", "act");
    await store.setMode("https://files.example.com/*", "read");
    web.set("https://files.example.com/a.png", () => new Response(PNG, { headers: { "content-type": "image/png" } }));
    expect((await call("save_media", { url: "https://files.example.com/a.png" })).isError).toBe(false);
    expect(posted.map((each) => each.url)).toEqual(["https://files.example.com/a.png", `${SANDBOX}/system/webext/media`]);

    posted = [];
    const refused = await call("save_media", { url: "https://cdn.elsewhere.example/a.png" });
    expect(refused.text).toContain("ask_access for cdn.elsewhere.example");
    expect(posted).toEqual([]);
});

test("save_media by url needs act on the site, since the address is fetched with its sign-in; a ref needs only read", async () => {
    const refused = await call("save_media", { url: "/a.png" });
    expect(refused.isError).toBe(true);
    expect(refused.text).toContain("Saving by url needs act on the site");
    expect(injected).toEqual([]);
    expect(posted).toEqual([]);
    expect((await call("save_media", { ref: "e129" })).isError).toBe(false);
});

test("only media, documents, archives and downloads come in from an address: never an API's JSON or a page's text", () => {
    for (const kept of ["image/png", "video/mp4", "audio/mpeg", "application/pdf", "application/zip", "application/vnd.openxmlformats-officedocument.wordprocessingml.document"]) {
        expect(() => keptFromAddress(kept, false)).not.toThrow();
    }
    for (const refused of ["application/json", "text/plain", "text/csv", "application/javascript", "application/octet-stream", "application/xml"]) {
        expect(() => keptFromAddress(refused, false)).toThrow(/aim at it by its ref/);
    }
    // A file the site itself hands out as a download is whatever it is.
    expect(() => keptFromAddress("text/csv", true)).not.toThrow();
});

test("a url answering with JSON saves nothing, a download or a document saves, and a ref may save text it points at", async () => {
    await store.setMode("https://chatgpt.com/*", "act");
    const json = new TextEncoder().encode(JSON.stringify({ email: "person@example.com" }));
    page.set("stage", { ok: true, bytes: json.byteLength, type: "application/json", attachment: false, message: "" });
    page.set("read", { ok: true, data: toBase64(json) });
    const refused = await call("save_media", { url: "/backend-api/me" });
    expect(refused.isError).toBe(true);
    expect(refused.text).toContain("answered with application/json");
    expect(posted).toEqual([]);

    // The same bytes served as an attachment are a file the site hands out.
    page.set("stage", { ok: true, bytes: json.byteLength, type: "application/json", attachment: true, message: "" });
    expect((await call("save_media", { url: "/export.json" })).isError).toBe(false);
    expect(posted.map((each) => each.headers["content-type"])).toEqual(["application/json"]);

    posted = [];
    const pdf = new TextEncoder().encode("%PDF-1.7 body");
    page.set("stage", { ok: true, bytes: pdf.byteLength, type: "application/octet-stream", attachment: false, message: "" });
    page.set("read", { ok: true, data: toBase64(pdf) });
    expect((await call("save_media", { url: "/report" })).isError).toBe(false);
    expect(posted.map((each) => each.headers["content-type"])).toEqual(["application/pdf"]);

    // A ref the agent aimed at (a link to a text file on the page) keeps what it points at.
    posted = [];
    const words = new TextEncoder().encode("plain notes");
    page.set("stage", { ok: true, bytes: words.byteLength, type: "text/plain", attachment: false, message: "" });
    page.set("read", { ok: true, data: toBase64(words) });
    expect((await call("save_media", { ref: "e40" })).isError).toBe(false);
    expect(posted.map((each) => each.headers["content-type"])).toEqual(["text/plain"]);
});

test("a page that answers with a sign-in page instead of the picture saves nothing", async () => {
    const html = "<!doctype html><title>Log in</title>";
    page.set("stage", { ok: true, bytes: html.length, type: "image/png", message: "" });
    page.set("read", { ok: true, data: btoa(html) });
    const refused = await call("save_media", { ref: "e1" });
    expect(refused.text).toContain("answered with a web page");
    expect(posted).toEqual([]);
});

test("upload_file collects the file for its ticket, asks the person with its name and size, then puts it in", async () => {
    web.set(`${SANDBOX}/system/webext/file`, () => new Response(PNG, { headers: { "content-type": "image/png", "x-intentic-name": "frame%201.png" } }));
    await store.setMode("https://chatgpt.com/*", "act");
    // Never through the sandbox, so no ticket: nothing is collected.
    expect((await call("upload_file", { ref: "e3", path: "/work/x.png" })).text).toContain("only through its sandbox");
    expect(posted).toEqual([]);

    const attached = await call("upload_file", { ref: "e3", path: "/work/x.png", ticket: "tkt" });
    expect(attached.isError).toBe(false);
    expect(attached.text).toContain("Attached “frame 1.png” (12 bytes) to the file input on chatgpt.com");
    expect(posted.map((each) => [each.url, each.headers["authorization"], new TextDecoder().decode(each.body)])).toEqual([
        [`${SANDBOX}/system/webext/file`, "Bearer iwx_token", JSON.stringify({ ticket: "tkt" })],
    ]);
    const [pin] = ran("find")[0]?.args.slice(1) ?? [];
    expect(ran("find")[0]?.args).toEqual(["e3", pin, "frame 1.png", "image/png"]);
    expect(ran("ask")[0]?.args[0]).toBe("Your agent wants to give chatgpt.com the file “frame 1.png” (12 bytes) from its sandbox. Allow it?");
    expect(ran("slice").map((each) => each.args)).toEqual([[pin, toBase64(PNG)]]);
    expect(ran("put").map((each) => each.args)).toEqual([[pin, "frame 1.png", "image/png"]]);
});

test("a person's no to an upload attaches nothing, whatever their switches say", async () => {
    web.set(`${SANDBOX}/system/webext/file`, () => new Response(PNG, { headers: { "content-type": "image/png", "x-intentic-name": "frame.png" } }));
    await store.setMode("https://chatgpt.com/*", "act");
    await store.setScopes(SANDBOX, { read: "on", act: "on", screenshot: "off", cookies: "off", scripts: "off", confirm: "never" });
    page.set("ask", false);
    const refused = await call("upload_file", { ref: "e3", path: "/work/x.png", ticket: "tkt" });
    expect(refused.text).toContain("The person said no");
    expect(ran("slice")).toEqual([]);
    expect(ran("put")).toEqual([]);
});

test("a download the agent's call starts in its window is copied into the sandbox, taken out of Downloads, and told", async () => {
    const message = { jsonrpc: "2.0", id: 4, method: "tools/call", params: { name: "click", arguments: { ref: "e9" } } };
    // The listener is attached by the first call that finds the permission on; this one starts nothing.
    await withCapturedDownloads(SANDBOX, message, async () => ({ jsonrpc: "2.0", id: 3, result: { content: [], isError: false } }));
    injected = [];
    // The person's own download, long after any call of the agent's, is never looked at.
    const later = Date.now() + 60_000;
    const realNow = Date.now;
    Date.now = () => later;
    try {
        downloadListener?.({ id: 32, url: "https://chatgpt.com/file.png", filename: "", state: "in_progress" });
        await new Promise((resolve) => setTimeout(resolve, 10));
    } finally {
        Date.now = realNow;
    }
    expect(injected).toEqual([]);

    const answer = await withCapturedDownloads(SANDBOX, message, async () => {
        downloadListener?.({ id: 31, url: "blob:https://chatgpt.com/0d9c", filename: "", state: "in_progress" });
        return { jsonrpc: "2.0", id: 4, result: { content: [{ type: "text", text: "Clicked." }], isError: false } };
    });
    expect(JSON.stringify(answer)).toContain(`A download your action started was saved to ${SAVED}`);
    expect(ran("stage")[0]?.args[0]).toBe("blob:https://chatgpt.com/0d9c");
    expect(downloadCalls).toEqual(["removeFile 31", "erase 31"]);
});
