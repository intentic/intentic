import { handleMcpMessage } from "./mcp.js";
import { choose, granted } from "./site-grants.js";
import { CHOICE_HOLD_MS, store } from "./store.js";
import { currentGrants } from "./tools/tab-access.js";

// Allowing a site the agent asked for, as it happens in the person's browser: they pick Read or Read & act in the
// popup, Chrome's own dialog takes focus and closes that popup (crbug.com/40721470), and Chrome's grant lands in the
// worker afterwards. Nothing after the popup's request runs here, which is the point: the pick must reach the agent's
// list without it.

const GITHUB = "https://github.com/*";

// What Chrome holds right now; a test adds to it the way the dialog's Allow does.
let held: string[] = [];

const install = (origins: string[] = []): void => {
    held = origins;
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
        tabs: { query: async () => [] },
        permissions: {
            getAll: async () => ({ origins: held }),
            contains: async (request: { origins?: string[] }) => (request.origins ?? []).every((origin) => held.includes(origin)),
        },
        action: {
            setBadgeText: async () => undefined,
            setBadgeBackgroundColor: async () => undefined,
            setTitle: async () => undefined,
            openPopup: async () => undefined,
        },
    };
    Object.assign(globalThis, { chrome: fake, navigator: { userAgent: "Mozilla/5.0 Chrome/141.0.0.0 Windows" } });
};

// Chrome's dialog answered Allow: the site is held, and `onAdded` names it.
const allowInDialog = async (origin: string, now = Date.now()): Promise<void> => {
    held = [...held, origin];
    await granted([origin], now);
};

beforeEach(() => {
    install();
});

test("a pick made before Chrome's dialog closed the popup is filed when the grant lands", async () => {
    await store.setPending({ origin: GITHUB, reason: "To read the alert.", at: Date.now() });
    await choose(GITHUB, "act");
    // Nothing is filed while Chrome is still asking.
    expect(await store.modes()).toEqual({});
    await allowInDialog(GITHUB);
    expect(await currentGrants()).toEqual([{ origin: GITHUB, mode: "act" }]);
    expect(await store.pending()).toBeUndefined();
    expect((await store.log())[0]?.detail).toBe("Allowed github.com to read and act");
});

// Passwords' all-sites grant, or a site granted before its mode was filed: Chrome answers without a dialog and adds
// nothing, so no grant ever lands for the pick to wait on.
test("a pick for a site Chrome already holds is filed at once", async () => {
    install([GITHUB]);
    await choose(GITHUB, "read");
    expect(await currentGrants()).toEqual([{ origin: GITHUB, mode: "read" }]);
});

test("the site the agent asked for, allowed from Chrome's own menu, files as read only", async () => {
    await store.setPending({ origin: GITHUB, reason: "", at: Date.now() });
    await allowInDialog(GITHUB);
    expect(await currentGrants()).toEqual([{ origin: GITHUB, mode: "read" }]);
    expect(await store.pending()).toBeUndefined();
});

test("a grant nobody picked a mode for is not a site given to the agent", async () => {
    await store.setPending({ origin: GITHUB, reason: "", at: Date.now() });
    await allowInDialog("https://gitlab.com/*");
    expect(await store.modes()).toEqual({});
    expect((await store.pending())?.origin).toBe(GITHUB);
});

test("a pick for one site is not spent by another's grant, and an old pick is not filed", async () => {
    const at = Date.now();
    await choose(GITHUB, "act", at);
    await allowInDialog("https://gitlab.com/*", at + 1000);
    expect(await store.modes()).toEqual({});
    await allowInDialog(GITHUB, at + CHOICE_HOLD_MS + 1);
    expect(await store.modes()).toEqual({});
});

// Chrome holding a site is not the agent being allowed there: with Passwords on, Chrome holds every site.
test("ask_access leaves a request for a site Chrome holds but the agent was never given", async () => {
    install([GITHUB]);
    // SAFETY: a tools/call is answered with MCP's content list (mcp.ts `textResult`); a wrong shape fails the expect.
    const answer = (await handleMcpMessage(
        { jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "ask_access", arguments: { origin: "github.com", reason: "To read it." } } },
        undefined,
    )) as { result: { content: { text: string }[] } };
    expect(answer.result.content[0]?.text).toContain("Asked for github.com");
    expect((await store.pending())?.origin).toBe(GITHUB);
});
