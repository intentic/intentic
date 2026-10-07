import { solveTurnstile } from "./challenge.js";

// The Turnstile script is fetched from Cloudflare by the page; here the test plays the network by firing the tag's own
// load and error events.

const TAG = 'script[src^="https://challenges.cloudflare.com/turnstile/"]';
const tags = (): HTMLScriptElement[] => [...document.head.querySelectorAll<HTMLScriptElement>(TAG)];

afterEach(() => {
    for (const tag of tags()) {
        tag.remove();
    }
    Reflect.deleteProperty(window, "turnstile");
});

test("a bot check that failed to load is fetched again on the next try, not failed for the page's whole life", async () => {
    const first = solveTurnstile(document.createElement("div"), "site-key");
    await Promise.resolve();
    expect(tags()).toHaveLength(1);
    tags()[0]?.dispatchEvent(new Event("error"));
    await expect(first).rejects.toThrow("The bot check failed to load");
    expect(tags()).toHaveLength(0);

    const second = solveTurnstile(document.createElement("div"), "site-key");
    await Promise.resolve();
    expect(tags()).toHaveLength(1);
    const turnstile = { render: (_container: HTMLElement, options: { callback: (token: string) => void }) => options.callback("token-1") };
    Object.defineProperty(window, "turnstile", { value: turnstile, configurable: true });
    tags()[0]?.dispatchEvent(new Event("load"));
    expect(await second).toBe("token-1");
});
