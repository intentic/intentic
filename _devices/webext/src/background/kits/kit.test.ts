import { number, object, string } from "zod";
import { kitMemory, releaseKitTab } from "./kit.js";

// What a kit remembers between calls, and how it lets a tab go once it no longer does.

const SANDBOX = "https://sandbox-1.example.dev";
let removed: number[] = [];
let discardable: number[] = [];

beforeEach(() => {
    removed = [];
    discardable = [];
    const session = new Map<string, unknown>();
    Object.assign(globalThis, {
        chrome: {
            storage: {
                session: {
                    get: async (keys: string[]) => Object.fromEntries(keys.filter((key) => session.has(key)).map((key) => [key, session.get(key)])),
                    set: async (items: Record<string, unknown>) => {
                        for (const [key, value] of Object.entries(items)) {
                            session.set(key, value);
                        }
                    },
                },
            },
            tabs: {
                remove: async (id: number) => {
                    if (id === 404) {
                        throw new Error(`No tab with id: ${id}`);
                    }
                    removed.push(id);
                },
                update: async (id: number, properties: { autoDiscardable?: boolean }) => {
                    if (properties.autoDiscardable === true) {
                        discardable.push(id);
                    }
                    return { id };
                },
            },
        },
    });
});

test("an entry past the newest few falls off the end and is handed back, so its tab can be let go", async () => {
    const memory = kitMemory("test-chats", object({ chat: string(), tabId: number() }), 2);
    const same = (chat: string) => (other: { chat: string }) => other.chat === chat;
    expect(await memory.put(SANDBOX, { chat: "a", tabId: 1 }, same("a"))).toEqual([]);
    expect(await memory.put(SANDBOX, { chat: "b", tabId: 2 }, same("b"))).toEqual([]);
    // Replacing an entry is not evicting one.
    expect(await memory.put(SANDBOX, { chat: "a", tabId: 1 }, same("a"))).toEqual([]);
    expect(await memory.put(SANDBOX, { chat: "c", tabId: 3 }, same("c"))).toEqual([{ chat: "b", tabId: 2 }]);
    expect(await memory.list(SANDBOX)).toEqual([
        { chat: "c", tabId: 3 },
        { chat: "a", tabId: 1 },
    ]);
});

test("a released tab is closed or made discardable again, and one already gone is no error", async () => {
    await releaseKitTab(5, true);
    await releaseKitTab(6, false);
    await releaseKitTab(404, true);
    expect(removed).toEqual([5]);
    expect(discardable).toEqual([6]);
});
