import { askConfirm } from "../../page/overlay.js";
import { type ActionResult, clickRef, collectPage, describeRef, type RefDescription } from "../../page/driver.js";
import { store } from "../store.js";
import { click } from "./page.js";

// The confirm-then-act path of a click, with the page stood in for: which injected function ran, with what, and what
// the page answered. The page side itself is page/driver.test.ts; this is what the background makes of its answers.

const URL_NOW = "https://app.example/settings";

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

const nameOf = (func: unknown): string =>
    func === describeRef ? "describe" : func === askConfirm ? "ask" : func === clickRef ? "click" : func === collectPage ? "snapshot" : "banner";

const answerFor = (name: string) => {
    switch (name) {
        case "describe":
            return described;
        case "ask":
            return answers.shift() ?? false;
        case "click":
            return landings.shift();
        case "snapshot":
            return { url: URL_NOW, title: "Settings", truncated: false, loading: false, elements: [] };
        default:
            return undefined;
    }
};

const install = (tabs: { id: number; url: string }[]): void => {
    const storage = new Map<string, unknown>();
    const fake = {
        storage: {
            local: {
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
            },
        },
        tabs: {
            query: async () => tabs.slice(0, 1).map((tab) => ({ ...tab, active: true, windowId: 1 })),
            get: async (id: number) => tabs.map((tab) => ({ ...tab, active: false, windowId: 1 })).find((tab) => tab.id === id),
        },
        permissions: { contains: async () => true },
        scripting: {
            executeScript: async (injection: { func: unknown; args?: unknown[] }) => {
                const name = nameOf(injection.func);
                injected.push({ name, args: injection.args ?? [] });
                return [{ frameId: 0, result: answerFor(name) }];
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
    install([
        { id: 7, url: URL_NOW },
        { id: 8, url: URL_NOW },
    ]);
    await store.setScopes({ read: "on", act: "on", screenshot: "off", cookies: "off", confirm: "sensitive" });
    await store.setMode("https://app.example/*", "act");
});

const gone: ActionResult = { ok: false, gone: true, message: `e4 is gone from the page: take a fresh snapshot.` };
const landed: ActionResult = { ok: true, message: `clicked` };

// The live failure: "Remove" in a popup menu, the person said yes, the menu had closed by then, and every retry asked
// again and lost the click again.
test("a yes whose menu closed while the person decided is kept for one retry of that same click", async () => {
    answers = [true];
    landings = [gone, landed];
    const first = click("e4");
    await expect(first).rejects.toThrow(`Nothing happened`);
    await expect(first).rejects.toThrow(`open the menu again`);
    expect(asked()).toBe(1);

    // The agent reopened the menu and snapshotted: a new ref, the same element by name, and no second question.
    expect(await click("e9")).toContain("Settings");
    expect(asked()).toBe(1);

    // Spent: the next one asks afresh.
    answers = [false];
    await expect(click("e9")).rejects.toThrow(`said no`);
    expect(asked()).toBe(2);
});

test("the click after a question goes to the element that was described, by its pin", async () => {
    answers = [true];
    landings = [landed];
    await click("e4");
    const describe = injected.find((call) => call.name === "describe");
    const clicked = injected.find((call) => call.name === "click");
    expect(describe?.args[0]).toBe("e4");
    expect(clicked?.args).toEqual(["e4", describe?.args[1]]);
    expect(String(describe?.args[1]).length).toBeGreaterThan(8);
});

test("a kept yes answers nothing but the click it was given for", async () => {
    answers = [true];
    landings = [gone];
    await expect(click("e4")).rejects.toThrow(`Nothing happened`);

    // Another element on the same page is its own question.
    described = { ok: true, role: "button", name: "Delete account", sensitive: true };
    answers = [false];
    await expect(click("e5")).rejects.toThrow(`said no`);

    // So is the same element in another tab.
    described = { ok: true, role: "li", name: "Remove", sensitive: true };
    answers = [false];
    await expect(click("e4", 8)).rejects.toThrow(`said no`);
    expect(asked()).toBe(3);

    // And the yes is still there for the click it was for.
    landings = [landed];
    expect(await click("e4", 7)).toContain("Settings");
    expect(asked()).toBe(3);
});

test("a no keeps nothing, and a click nobody was asked about says only that its element went", async () => {
    answers = [false];
    await expect(click("e4")).rejects.toThrow(`said no`);

    described = { ok: true, role: "button", name: "Open", sensitive: false };
    landings = [gone];
    const unasked = click("e4");
    await expect(unasked).rejects.toThrow(`gone from the page`);
    await expect(unasked).rejects.not.toThrow(`Nothing happened`);
    expect(asked()).toBe(1);

    // Neither left a yes behind.
    described = { ok: true, role: "li", name: "Remove", sensitive: true };
    answers = [false];
    await expect(click("e4")).rejects.toThrow(`said no`);
    expect(asked()).toBe(2);
});
