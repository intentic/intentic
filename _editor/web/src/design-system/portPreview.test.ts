import "@intentic/testing/dom";
import { openForwardedPort } from "@intentic/ui";
import { t } from "@intentic/ui/i18n";

// A localhost link opens as a port preview: forward, wait for the address, navigate the tab opened on the click. A
// forward whose answer never came back may still have landed (the Ports view then shows it forwarded and its link
// opens), so the tab asks the daemon's list before it gives up, and never shows fetch's bare "Failed to fetch".

const PREVIEW = `https://port-a-sandbox-1.example.dev`;

interface FakeTab {
    closed: boolean;
    opener: unknown;
    readonly document: { readonly body: { textContent: string } };
    readonly location: { href: string };
}

// Both are accessors on this global, which spyOn refuses: replaced by definition and put back the same way.
const replaced = [`open`, `fetch`].map((name) => ({ name, held: Object.getOwnPropertyDescriptor(globalThis, name) }));
let tab: FakeTab;

beforeEach(() => {
    tab = { closed: false, opener: window, document: { body: { textContent: `` } }, location: { href: `` } };
    // The tab the click opens: only the fields openForwardedPort touches.
    Object.defineProperty(globalThis, `open`, { value: () => tab, configurable: true, writable: true });
    // The preview proxy's probe, answering for a serving port on the first ask.
    Object.defineProperty(globalThis, `fetch`, {
        value: async () => new Response(JSON.stringify({ proxy: `intentic-preview`, state: `serving`, servers: [] }), { status: 200 }),
        configurable: true,
        writable: true,
    });
});
afterEach(() => {
    for (const { name, held } of replaced) {
        if (held === undefined) {
            Reflect.deleteProperty(globalThis, name);
        } else {
            Object.defineProperty(globalThis, name, held);
        }
    }
});

// Lets the click's async chain run to its end: no timers are involved on these paths.
const settle = async (): Promise<void> => {
    for (let beat = 0; beat < 20; beat += 1) {
        await new Promise((resolve) => setTimeout(resolve, 0));
    }
};

const unanswered = (): TypeError => new TypeError(`Failed to fetch`);

test("a forward that landed with its answer lost opens the address the daemon lists", async () => {
    const forward = jest.fn(async () => { throw unanswered(); });
    const listed = jest.fn(async () => PREVIEW);
    openForwardedPort({ port: 5173, path: `/app`, forward, listed });
    await settle();
    expect(listed).toHaveBeenCalledWith(5173);
    expect(forward).toHaveBeenCalledTimes(1);
    expect(tab.location.href).toBe(`${PREVIEW}/app`);
});

test("a forward that got no answer and is not listed is sent once more", async () => {
    const forward = jest.fn<(port: number) => Promise<string | undefined>>().mockRejectedValueOnce(unanswered()).mockResolvedValueOnce(PREVIEW);
    openForwardedPort({ port: 5173, forward, listed: async () => undefined });
    await settle();
    expect(forward).toHaveBeenCalledTimes(2);
    expect(tab.location.href).toBe(PREVIEW);
});

test("a forward that keeps getting no answer says so in words, not fetch's", async () => {
    const onError = jest.fn();
    openForwardedPort({ port: 5173, forward: async () => { throw unanswered(); }, listed: async () => undefined, onError });
    await settle();
    const said = t(`ui.portPreview.unanswered`, { port: 5173 });
    expect(said).toContain(`5173`);
    expect(said).not.toContain(`portPreview`);
    expect(tab.document.body.textContent).toBe(said);
    expect(onError).toHaveBeenCalledWith(said);
    expect(tab.location.href).toBe(``);
});

test("a refusal is the daemon's last word: shown as it came, never retried", async () => {
    const forward = jest.fn(async () => { throw new Error(`nothing is listening on port 5173`); });
    openForwardedPort({ port: 5173, forward, listed: async () => undefined });
    await settle();
    expect(forward).toHaveBeenCalledTimes(1);
    expect(tab.document.body.textContent).toBe(`nothing is listening on port 5173`);
});

test("a list that cannot be read leaves the forward's own failure to report", async () => {
    openForwardedPort({
        port: 5173,
        forward: async () => { throw new Error(`port 5173 is a browser's DevTools port`); },
        listed: async () => { throw unanswered(); },
    });
    await settle();
    expect(tab.document.body.textContent).toBe(`port 5173 is a browser's DevTools port`);
});
