import type { WebExtCookie, WebExtSessionExportResult } from "@intentic/sandbox-contract/webext";
import { askConfirm } from "../../page/overlay.js";
import { handleMcpMessage } from "../mcp.js";
import { store } from "../store.js";
import { writableFor } from "./site-cookies.js";

// connect_site and lend_site as this browser runs them: which cookies leave for the sandbox, and which of the ones it
// sends back are written. "The site" is the tab's host and what this browser sends it, never everything under its last
// two labels, which read every *.co.uk cookie for bbc.co.uk and every other github.io site's for one of them.

const SANDBOX = "https://sandbox-1.example.dev";
const PAGE = "https://www.bbc.co.uk/news";

// A cookie as Chrome stores it; `domain` is Chrome's spelling, a leading dot for one that covers subdomains.
const cookie = (name: string, domain: string, path = "/"): chrome.cookies.Cookie => ({
    name,
    value: `${name}-value`,
    domain,
    path,
    secure: true,
    httpOnly: true,
    sameSite: "lax",
    session: true,
});

// The jar, matched as Chrome matches it: `url` by host (host-only exact, a dotted domain on the host or a parent),
// path prefix and https; `domain` by the cookie's domain being that one or under it.
let jar: chrome.cookies.Cookie[] = [];
let written: string[] = [];
const bare = (domain: string): string => domain.replace(/^\./, "");
const getAll = async (details: { url?: string; domain?: string }): Promise<chrome.cookies.Cookie[]> => {
    if (details.domain !== undefined) {
        const wanted = details.domain;
        return jar.filter((each) => bare(each.domain) === wanted || bare(each.domain).endsWith(`.${wanted}`));
    }
    const url = new URL(details.url ?? "");
    return jar.filter((each) => {
        const onHost = each.domain.startsWith(".")
            ? url.hostname === bare(each.domain) || url.hostname.endsWith(each.domain)
            : url.hostname === each.domain;
        const onPath = each.path === "/" || url.pathname === each.path || url.pathname.startsWith(`${each.path}/`);
        return onHost && onPath && (url.protocol === "https:" || !each.secure);
    });
};

// The tab the agent is on, in front of its own window (window 1).
let tab = { id: 7, windowId: 1, active: true, url: PAGE };
let confirmAnswer = true;
let posted: { url: string; body: unknown }[] = [];
let door: WebExtSessionExportResult = { ok: false, message: "No answer set." };
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

beforeEach(async () => {
    jar = [];
    written = [];
    confirmAnswer = true;
    posted = [];
    door = { ok: false, message: "No answer set." };
    tab = { id: 7, windowId: 1, active: true, url: PAGE };
    Object.assign(globalThis, {
        chrome: {
            storage: { local: area(new Map()), session: area(new Map([["agentWindows", { [SANDBOX]: 1 }]])) },
            tabs: { query: async () => [tab], get: async () => tab, reload: async () => undefined, update: async () => tab },
            windows: {
                get: async (id: number) => ({ id, focused: true, state: "normal", tabs: [tab] }),
                update: async (id: number) => ({ id, focused: true }),
            },
            action: {
                setBadgeText: async () => undefined,
                setBadgeBackgroundColor: async () => undefined,
                setTitle: async () => undefined,
                openPopup: async () => undefined,
            },
            permissions: { contains: async () => true },
            scripting: {
                executeScript: async (injection: { func: unknown }) => [
                    { frameId: 0, result: injection.func === askConfirm ? confirmAnswer : undefined },
                ],
            },
            cookies: {
                getAll,
                set: async (details: { name: string; domain?: string; url: string }) => {
                    written.push(`${details.name} on ${details.domain ?? new URL(details.url).hostname}`);
                    return cookie(details.name, details.domain ?? new URL(details.url).hostname);
                },
            },
            runtime: { getManifest: () => ({ version: "0.1.0", name: "Intentic" }) },
        },
    });
    globalThis.fetch = Object.assign(
        async (url: string | URL | Request, init?: RequestInit) => {
            posted.push({ url: String(url), body: JSON.parse(String(init?.body)) });
            return new Response(JSON.stringify(door), { status: 200, headers: { "content-type": "application/json" } });
        },
        { preconnect: realFetch.preconnect },
    );
    await store.addSandbox({ url: SANDBOX, token: "iwx_token" });
    await store.setScopes(SANDBOX, { read: "on", act: "on", screenshot: "off", cookies: "on", scripts: "off", confirm: "sensitive" });
    await store.setMode("https://www.bbc.co.uk/*", "read");
});

afterEach(() => {
    globalThis.fetch = realFetch;
});

const call = async (name: "connect_site" | "lend_site") => {
    const answer = await handleMcpMessage({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name, arguments: { account: "work" } } }, SANDBOX);
    // SAFETY: a tools/call is always answered with a result envelope (peer-mcp-server.ts), a failure as isError.
    const result = (answer as { result: { content: { text: string }[]; isError: boolean } }).result;
    return { text: result.content[0]?.text ?? "", isError: result.isError };
};

const handedOver = (): string[] =>
    // SAFETY: the one body connect_site posts is the session import it built from WebExtCookie values.
    ((posted[0]?.body as { cookies?: WebExtCookie[] } | undefined)?.cookies ?? []).map((each) => `${each.name} on ${each.domain}${each.path}`);

test("the hand-over takes what the browser sends the site, never its neighbours under the same last two labels", async () => {
    jar = [
        cookie("host", "www.bbc.co.uk"),
        cookie("parent", ".bbc.co.uk"),
        cookie("api", "www.bbc.co.uk", "/api"),
        cookie("bank", ".barclays.co.uk"),
        cookie("sibling", "shop.bbc.co.uk"),
        cookie("child", "img.www.bbc.co.uk"),
    ];
    const handed = await call("connect_site");
    expect(handed.isError).toBe(false);
    // Its own cookies on another path go too; a bank's, a sibling's and a subdomain's never do.
    expect(handedOver().sort()).toEqual(["api on www.bbc.co.uk/api", "host on www.bbc.co.uk/", "parent on .bbc.co.uk/"]);
    expect(posted[0]?.body).toMatchObject({ account: "work", origin: "www.bbc.co.uk" });
});

test("a github.io site hands over its own session, not every other github.io site's", async () => {
    await store.setMode("https://foo.github.io/*", "read");
    tab = { id: 7, windowId: 1, active: true, url: "https://foo.github.io/" };
    jar = [cookie("mine", "foo.github.io"), cookie("theirs", "bar.github.io")];
    expect((await call("connect_site")).isError).toBe(false);
    expect(handedOver()).toEqual(["mine on foo.github.io/"]);
});

test("lending writes only the site's own cookies and the domains its cookies here already use", async () => {
    jar = [cookie("parent", ".bbc.co.uk")];
    const lent = (name: string, domain: string): WebExtCookie => ({
        name,
        value: "v",
        domain,
        path: "/",
        httpOnly: true,
        secure: true,
        sameSite: "Lax",
    });
    door = {
        ok: true,
        message: "Lent.",
        cookies: [
            lent("host", "www.bbc.co.uk"),
            lent("covering", ".www.bbc.co.uk"),
            lent("parent", ".bbc.co.uk"),
            lent("bank", ".barclays.co.uk"),
            lent("suffix", ".co.uk"),
            lent("sibling", "shop.bbc.co.uk"),
        ],
    };
    const answer = await call("lend_site");
    expect(answer.isError).toBe(false);
    expect(posted[0]?.body).toEqual({ account: "work", domain: "www.bbc.co.uk" });
    expect(written.sort()).toEqual(["covering on .www.bbc.co.uk", "host on www.bbc.co.uk", "parent on .bbc.co.uk"]);
    expect(answer.text).toContain("3 of its cookies were for other sites and were left out.");
});

test("a lent session with nothing for this site changes nothing", async () => {
    door = {
        ok: true,
        message: "Lent.",
        cookies: [{ name: "bank", value: "v", domain: ".barclays.co.uk", path: "/", httpOnly: true, secure: true, sameSite: "Lax" }],
    };
    const answer = await call("lend_site");
    expect(answer.isError).toBe(true);
    expect(answer.text).toContain("nothing changed in this browser");
    expect(written).toEqual([]);
});

test("a parent domain is writable only when the site's own cookies here already use it", () => {
    const fits = writableFor("app.example.com", [cookie("seen", ".example.com")]);
    expect(fits({ domain: ".example.com" })).toBe(true);
    expect(fits({ domain: "APP.example.com" })).toBe(true);
    // The parent as a host-only cookie is another host's, and an unseen parent is someone else's to set.
    expect(fits({ domain: "example.com" })).toBe(false);
    expect(writableFor("app.example.com", [])({ domain: ".example.com" })).toBe(false);
});
