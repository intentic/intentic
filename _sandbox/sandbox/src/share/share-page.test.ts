import type { SharePayload } from "@intentic/sandbox-contract";
import { expect, it } from "vitest";
import { sharePage } from "./share-page.js";

// Pins that turning a conversation into markup on an unauthenticated public page is an injection surface; prompts
// routinely contain arbitrary HTML, since people paste it in.

const TEMPLATE = `<!doctype html><html><head><title>Shared conversation</title>
<script id="intentic-conversation" type="application/json">
null
</script></head><body></body></html>`;

const payload = (text: string, title = "A chat"): SharePayload => ({
    title,
    sharedAt: 1786372320000,
    detail: "messages",
    messages: [{ role: "user", text }],
});

it("writes the conversation into the page's data block, where the app finds it", () => {
    const page = sharePage(TEMPLATE, payload("hello"));
    const body = /<script id="intentic-conversation" type="application\/json">(.*?)<\/script>/s.exec(page)?.[1];
    expect(JSON.parse(body ?? "")).toMatchObject({ messages: [{ text: "hello" }] });
});

// An HTML parser treats a JSON script block as non-markup, except that it still ends the block at the first `</script`;
// a prompt containing that string would close it early and leak the rest as document markup.
it("cannot be closed early by a conversation that contains a closing script tag", () => {
    const page = sharePage(TEMPLATE, payload(`</script><img src=x onerror=alert(1)>`));
    expect(page.match(/<\/script>/g)).toHaveLength(1);
    expect(page).not.toContain(`<img src=x`);
    const body = /<script id="intentic-conversation" type="application\/json">(.*?)<\/script>/s.exec(page)?.[1];
    expect(JSON.parse(body ?? "")).toMatchObject({ messages: [{ text: `</script><img src=x onerror=alert(1)>` }] });
});

// The title lands in real markup, not a data block, so it takes ordinary HTML escaping.
it("puts the share's title on the page without letting it become markup", () => {
    const page = sharePage(TEMPLATE, payload("hi", `Fix <script>alert(1)</script>`));
    expect(page).toContain(`<title>Fix &lt;script&gt;alert(1)&lt;/script&gt;</title>`);
});

// Failing loudly here beats publishing a page that silently renders nothing.
it("refuses a template it cannot write the conversation into", () => {
    expect(() => sharePage(`<html><head></head></html>`, payload("hi"))).toThrow(/data block/);
});
