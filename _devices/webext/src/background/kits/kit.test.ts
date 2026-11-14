import { kitStorage, releaseKitTab } from "./kit.js";

// What a kit keeps between calls, and how it lets a tab go once it no longer does. Which entries it keeps is the kit's
// own (@intentic/site-kits' memory.test.ts).

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

test("each sandbox's value is kept apart under the kit's key, and a stored value that does not read is none", async () => {
    const chats = kitStorage("session", "test-chats");
    await chrome.storage.session.set({ "kit:test-chats": "an earlier build's" });
    expect(await chats.read(SANDBOX)).toBeUndefined();
    await chats.write(SANDBOX, [{ chat: "a", tabId: 1 }]);
    await chats.write("https://sandbox-2.example.dev/", [{ chat: "b", tabId: 2 }]);
    expect(await chats.read(SANDBOX)).toEqual([{ chat: "a", tabId: 1 }]);
    expect(await chrome.storage.session.get(["kit:test-chats"])).toEqual({
        "kit:test-chats": { [SANDBOX]: [{ chat: "a", tabId: 1 }], "https://sandbox-2.example.dev": [{ chat: "b", tabId: 2 }] },
    });
});

test("a released tab is closed or made discardable again, and one already gone is no error", async () => {
    await releaseKitTab(5, true);
    await releaseKitTab(6, false);
    await releaseKitTab(404, true);
    expect(removed).toEqual([5]);
    expect(discardable).toEqual([6]);
});
