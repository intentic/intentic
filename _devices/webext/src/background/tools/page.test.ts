import { askConfirm } from "../../page/overlay.js";
import { type ActionResult, clickRef, collectPage, describeRef, markDocument, pressKeyOnPage, type RefDescription } from "../../page/driver.js";
import { checkField, focusField, pressEnterInField, typeRich, typeValue } from "../../page/typing.js";
import { store } from "../store.js";
import { click, fill, pressKey } from "./page.js";

// The confirm-then-act path of a click, with the page stood in for: which injected function ran, with what, and what
// the page answered. The page side itself is page/driver.test.ts; this is what the background makes of its answers.

const URL_NOW = "https://app.example/settings";
const SANDBOX = "https://sandbox-1.example.dev";

interface Injected {
    readonly name: string;
    readonly args: unknown[];
}

let injected: Injected[] = [];
// What the person answers each question, in order; an unanswered one is a no.
let answers: boolean[] = [];
// What each clickRef finds in the page, in order.
let landings: ActionResult[] = [];
let described: RefDescription = { ok: true, role: "li", name: "Remove", sensitive: true };
// The document in the agent's tab: its mark (driver.ts markDocument), which a replaced page loses.
let documentMark = "doc-1";
// What happens in the page when an action runs in it, beyond its answer: a route change, a new document, a closed
// frame. `null` is Chrome's answer for a frame that went away; a throw is its other one.
let onAction: ((name: string) => void) | undefined;
// Injected functions whose frame goes away under them: Chrome answers `null`, or throws.
let unanswered = new Map<string, "null" | "throw">();
// Every origin whose permission Chrome was asked about, in order.
let permissionChecks: string[] = [];
// Origins Chrome holds a grant for; a tab elsewhere has its address hidden, as Chrome does.
let granted = new Set(["https://app.example/*"]);

const NAMES = new Map<unknown, string>([
    [describeRef, "describe"],
    [askConfirm, "ask"],
    [clickRef, "click"],
    [collectPage, "snapshot"],
    [markDocument, "mark"],
    [focusField, "focus"],
    [typeRich, "type"],
    [typeValue, "type"],
    [checkField, "check"],
    [pressEnterInField, "enter"],
    [pressKeyOnPage, "key"],
]);
const nameOf = (func: unknown): string => NAMES.get(func) ?? "banner";

let tabs: { id: number; url: string }[] = [];
const urlOf = (id: number): string => tabs.find((tab) => tab.id === id)?.url ?? "";
const originOf = (url: string): string => `${new URL(url).origin}/*`;
const visible = (tab: { id: number; url: string }) => (granted.has(originOf(tab.url)) ? tab : { id: tab.id });

const answerFor = (name: string, tabId: number) => {
    switch (name) {
        case "describe":
            return described;
        case "ask":
            return answers.shift() ?? false;
        case "click":
            return landings.shift();
        case "mark":
            return { url: urlOf(tabId), mark: documentMark };
        case "focus":
            return { ok: true, rich: true, message: "focused" };
        case "type":
        case "check":
            return { ok: true, message: "typed" };
        case "enter":
            return { ok: true, message: "pressed Enter" };
        case "key":
            return { ok: true, message: "pressed" };
        case "snapshot":
            return { url: urlOf(tabId), title: "Settings", truncated: false, loading: false, elements: [{ ref: "e0", role: "button", name: "Send" }] };
        default:
            return undefined;
    }
};

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

const install = (open: { id: number; url: string }[]): void => {
    tabs = open;
    const storage = new Map<string, unknown>();
    // Window 1 is the agent's own (agent-window.ts), so a click given no tab lands on its tab in front, tab 7.
    const session = new Map<string, unknown>([["agentWindows", { [SANDBOX]: 1 }]]);
    const fake = {
        storage: {
            local: area(storage),
            session: area(session),
        },
        tabs: {
            query: async () => tabs.slice(0, 1).map((tab) => ({ ...visible(tab), active: true, windowId: 1 })),
            get: async (id: number) => tabs.map((tab) => ({ ...visible(tab), active: false, windowId: 1, status: "complete" })).find((tab) => tab.id === id),
            onUpdated: { addListener: () => undefined, removeListener: () => undefined },
        },
        windows: {
            get: async (id: number) => ({
                id,
                focused: false,
                state: "normal",
                tabs: tabs.map((tab, at) => ({ ...visible(tab), active: at === 0, windowId: 1 })),
            }),
            update: async (id: number) => ({ id, focused: false }),
        },
        action: {
            setBadgeText: async () => undefined,
            setBadgeBackgroundColor: async () => undefined,
            setTitle: async () => undefined,
            openPopup: async () => undefined,
        },
        permissions: {
            contains: async (request: { origins: string[] }) => {
                permissionChecks.push(...request.origins);
                return request.origins.every((origin) => granted.has(origin));
            },
        },
        scripting: {
            executeScript: async (injection: { target: { tabId: number }; func: unknown; args?: unknown[] }) => {
                const name = nameOf(injection.func);
                injected.push({ name, args: injection.args ?? [] });
                const answer = answerFor(name, injection.target.tabId);
                onAction?.(name);
                const silence = unanswered.get(name);
                if (silence === "throw") {
                    throw new Error("Frame with ID 0 was removed.");
                }
                return [{ frameId: 0, result: silence === "null" ? null : answer }];
            },
        },
    };
    Object.assign(globalThis, { chrome: fake });
};

const asked = (): number => injected.filter((call) => call.name === "ask").length;

beforeEach(async () => {
    injected = [];
    answers = [];
    landings = [];
    described = { ok: true, role: "li", name: "Remove", sensitive: true };
    documentMark = "doc-1";
    onAction = undefined;
    unanswered = new Map();
    permissionChecks = [];
    granted = new Set(["https://app.example/*"]);
    install([
        { id: 7, url: URL_NOW },
        { id: 8, url: URL_NOW },
    ]);
    await store.setScopes(SANDBOX, { read: "on", act: "on", screenshot: "off", cookies: "off", scripts: "off", confirm: "sensitive" });
    await store.setMode("https://app.example/*", "act");
});

const gone: ActionResult = { ok: false, gone: true, message: `e4 is gone from the page: take a fresh snapshot.` };
const landed: ActionResult = { ok: true, message: `clicked` };

// The live failure: "Remove" in a popup menu, the person said yes, the menu had closed by then, and every retry asked
// again and lost the click again.
test("a yes whose menu closed while the person decided is kept for one retry of that same click", async () => {
    answers = [true];
    landings = [gone, landed];
    const first = click(SANDBOX, "e4");
    await expect(first).rejects.toThrow(`Nothing happened`);
    await expect(first).rejects.toThrow(`open the menu again`);
    expect(asked()).toBe(1);

    // The agent reopened the menu and snapshotted: a new ref, the same element by name, and no second question.
    expect(await click(SANDBOX, "e9")).toContain("Settings");
    expect(asked()).toBe(1);

    // Spent: the next one asks afresh.
    answers = [false];
    await expect(click(SANDBOX, "e9")).rejects.toThrow(`said no`);
    expect(asked()).toBe(2);
});

test("the click after a question goes to the element that was described, by its pin", async () => {
    answers = [true];
    landings = [landed];
    await click(SANDBOX, "e4");
    const describe = injected.find((call) => call.name === "describe");
    const clicked = injected.find((call) => call.name === "click");
    expect(describe?.args[0]).toBe("e4");
    expect(clicked?.args).toEqual(["e4", describe?.args[1]]);
    expect(String(describe?.args[1]).length).toBeGreaterThan(8);
});

test("a kept yes answers nothing but the click it was given for", async () => {
    answers = [true];
    landings = [gone];
    await expect(click(SANDBOX, "e4")).rejects.toThrow(`Nothing happened`);

    // Another element on the same page is its own question.
    described = { ok: true, role: "button", name: "Delete account", sensitive: true };
    answers = [false];
    await expect(click(SANDBOX, "e5")).rejects.toThrow(`said no`);

    // So is the same element in another tab.
    described = { ok: true, role: "li", name: "Remove", sensitive: true };
    answers = [false];
    await expect(click(SANDBOX, "e4", 8)).rejects.toThrow(`said no`);
    expect(asked()).toBe(3);

    // And the yes is still there for the click it was for.
    landings = [landed];
    expect(await click(SANDBOX, "e4", 7)).toContain("Settings");
    expect(asked()).toBe(3);
});

test("a no keeps nothing, and a click nobody was asked about says only that its element went", async () => {
    answers = [false];
    await expect(click(SANDBOX, "e4")).rejects.toThrow(`said no`);

    described = { ok: true, role: "button", name: "Open", sensitive: false };
    landings = [gone];
    const unasked = click(SANDBOX, "e4");
    await expect(unasked).rejects.toThrow(`gone from the page`);
    await expect(unasked).rejects.not.toThrow(`Nothing happened`);
    expect(asked()).toBe(1);

    // Neither left a yes behind.
    described = { ok: true, role: "li", name: "Remove", sensitive: true };
    answers = [false];
    await expect(click(SANDBOX, "e4")).rejects.toThrow(`said no`);
    expect(asked()).toBe(2);
});

// ---- What an action says became of it, when the page moved or went quiet under it ----

const SEND: RefDescription = { ok: true, role: "button", name: "Send", sensitive: false };

// The live failure: ChatGPT's Send routes from / to /c/<id> and loads it, the frame the click ran in is gone before
// Chrome hears back, and the agent was told the page "did not answer" although the message had been sent.
test("a click whose page went away under it, onto a new address, is reported as landed, with the page it landed on", async () => {
    described = SEND;
    unanswered = new Map([["click", "throw"]]);
    onAction = (name) => {
        if (name === "click") {
            tabs[0] = { id: 7, url: "https://app.example/c/42" };
            documentMark = "doc-2";
        }
    };
    const said = await click(SANDBOX, "e4");
    expect(said).toStartWith(`Clicked "Send"; the page then moved to https://app.example/c/42 (page below).`);
    expect(said).toContain(`[e0] button "Send"`);
    expect(said).not.toContain("did not answer");
    // The destination's permission was asked again after the move, before anything of it was read.
    const snapshotAt = injected.findLastIndex((call) => call.name === "snapshot");
    expect(snapshotAt).toBeGreaterThan(injected.findIndex((call) => call.name === "click"));
    expect(permissionChecks.at(-1)).toBe("https://app.example/*");
});

test("a page that went quiet with nothing changed is UNKNOWN, with the page to check before repeating", async () => {
    described = SEND;
    unanswered = new Map([["click", "null"]]);
    const said = await click(SANDBOX, "e4");
    expect(said).toStartWith(`UNKNOWN whether the click on "Send" took effect`);
    expect(said).toContain("before doing it again");
    expect(said).toContain(`[e0] button "Send"`);
});

test("a click the page answered, after which a single-page app changed its route, says the refs are stale", async () => {
    described = SEND;
    landings = [landed];
    onAction = (name) => {
        if (name === "click") {
            tabs[0] = { id: 7, url: "https://app.example/c/43" };
        }
    };
    const said = await click(SANDBOX, "e4");
    expect(said).toStartWith(`Clicked "Send"; the page's address then changed to https://app.example/c/43 without loading a new page`);
    expect(said).toContain("References from earlier snapshots are stale");
});

test("a page that moved somewhere not allowed is said to have moved, and nothing of it is read or named", async () => {
    described = SEND;
    unanswered = new Map([["click", "null"]]);
    onAction = (name) => {
        if (name === "click") {
            tabs[0] = { id: 7, url: "https://bank.example/accounts" };
            documentMark = "doc-2";
        }
    };
    const said = await click(SANDBOX, "e4");
    // The page never answered, so the move is the only sign, and it does not say the click landed.
    expect(said).toStartWith(`UNKNOWN whether the click on "Send" took effect; the page can no longer be read: it moved somewhere this browser is not allowed to read`);
    expect(said).not.toContain("bank.example");
    const clickedAt = injected.findIndex((call) => call.name === "click");
    expect(injected.slice(clickedAt + 1).filter((call) => call.name === "snapshot" || call.name === "mark")).toEqual([]);
});

test("a click the page answered with nothing moving reads as clicked, with the page after it", async () => {
    described = SEND;
    landings = [landed];
    const said = await click(SANDBOX, "e4");
    expect(said).toStartWith(`Clicked "Send".\n\n`);
});

test("fill with submit whose Enter took the page to a new conversation is reported as typed and sent", async () => {
    described = { ok: true, role: "div", name: "Ask ChatGPT", sensitive: false };
    unanswered = new Map([["enter", "throw"]]);
    onAction = (name) => {
        if (name === "enter") {
            tabs[0] = { id: 7, url: "https://app.example/c/44" };
            documentMark = "doc-2";
        }
    };
    const said = await fill(SANDBOX, "e4", "draw a fox", true);
    expect(said).toStartWith(`Typed into "Ask ChatGPT" and pressed Enter; the page then moved to https://app.example/c/44 (page below).`);
    // The steps ran in order, each once: no second Enter.
    expect(injected.map((call) => call.name).filter((name) => ["focus", "type", "check", "enter"].includes(name))).toEqual(["focus", "type", "check", "enter"]);
});

test("a key whose page went quiet without moving is UNKNOWN, never a bare failure", async () => {
    unanswered = new Map([["key", "null"]]);
    const said = await pressKey(SANDBOX, "Enter");
    expect(said).toStartWith(`UNKNOWN whether pressing Enter took effect`);
});

test("a click that took the page to another allowed site asks that site's permission before reading it", async () => {
    await store.setMode("https://images.example/*", "read");
    granted.add("https://images.example/*");
    described = SEND;
    landings = [landed];
    onAction = (name) => {
        if (name === "click") {
            tabs[0] = { id: 7, url: "https://images.example/fox.png" };
            documentMark = "doc-2";
        }
    };
    const said = await click(SANDBOX, "e4");
    expect(said).toStartWith(`Clicked "Send"; the page then moved to https://images.example/fox.png (page below).`);
    expect(permissionChecks.at(-1)).toBe("https://images.example/*");
});

test("a page that moves on after its permission was checked is not read or named, and is looked at again under its own", async () => {
    described = SEND;
    landings = [landed];
    let marks = 0;
    onAction = (name) => {
        // The look after the click: the page redirects elsewhere between the check and the read.
        if (name === "mark" && ++marks === 2) {
            tabs[0] = { id: 7, url: "https://bank.example/accounts" };
            documentMark = "doc-2";
        }
    };
    const said = await click(SANDBOX, "e4");
    expect(said).not.toContain("bank.example");
    expect(said).not.toContain(`[e0] button "Send"`);
    expect(said).toContain("could not be read just now");
});

test("a move to a site Chrome lets this extension see but the agent was not given is not named, not even by the refusal", async () => {
    // Chrome reveals the address (the extension holds a grant there, as Passwords' all-sites grant does), and the
    // policy's refusal names the site it refuses: neither reaches the agent.
    granted.add("https://bank.example/*");
    described = SEND;
    landings = [landed];
    onAction = (name) => {
        if (name === "click") {
            tabs[0] = { id: 7, url: "https://bank.example/accounts" };
            documentMark = "doc-2";
        }
    };
    const said = await click(SANDBOX, "e4");
    expect(said).toStartWith(`Clicked "Send"; the page can no longer be read: it moved somewhere this browser is not allowed to read, or its permission was taken back`);
    expect(said).not.toContain("bank.example");
});

test("a page that did not answer right after the person's yes keeps the yes for one retry of that click", async () => {
    answers = [true];
    unanswered = new Map([["mark", "null"]]);
    const first = click(SANDBOX, "e4");
    await expect(first).rejects.toThrow("nothing was done");
    await expect(first).rejects.toThrow("is kept");
    expect(injected.some((call) => call.name === "click")).toBe(false);

    unanswered = new Map();
    landings = [landed];
    expect(await click(SANDBOX, "e4")).toStartWith(`Clicked "Remove".`);
    expect(asked()).toBe(1);
});
