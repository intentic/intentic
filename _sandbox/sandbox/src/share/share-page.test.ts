import type { SharePayload } from "@intentic/sandbox-contract";
import { expect, it } from "vitest";
import { sharePage } from "./share-page.js";

/* The step where a conversation becomes markup — and the step where getting it wrong is an injection into a
 * page served on the open internet with no auth in front of it. A prompt can contain any characters at all,
 * and the prompts in this product routinely contain markup, because people paste HTML into them. */

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

/* THE ONE ESCAPE THAT MATTERS. An HTML parser does not read a JSON script block as markup — with one
 * exception: it ends the block at the first `</script`. So a prompt containing one would close the block early
 * and everything after it would be parsed as the document. */
it("cannot be closed early by a conversation that contains a closing script tag", () => {
    const page = sharePage(TEMPLATE, payload(`</script><img src=x onerror=alert(1)>`));
    // Exactly one script block, and the payload's own text never appears as markup.
    expect(page.match(/<\/script>/g)).toHaveLength(1);
    expect(page).not.toContain(`<img src=x`);
    // And it still round-trips: the words are preserved, they are simply not markup.
    const body = /<script id="intentic-conversation" type="application\/json">(.*?)<\/script>/s.exec(page)?.[1];
    expect(JSON.parse(body ?? "")).toMatchObject({ messages: [{ text: `</script><img src=x onerror=alert(1)>` }] });
});

// The title lands in real markup rather than in a data block, so it takes ordinary escaping.
it("puts the share's title on the page without letting it become markup", () => {
    const page = sharePage(TEMPLATE, payload("hi", `Fix <script>alert(1)</script>`));
    expect(page).toContain(`<title>Fix &lt;script&gt;alert(1)&lt;/script&gt;</title>`);
});

// A template that has stopped carrying the block would otherwise publish a page that renders nothing, and the
// owner would learn about it from whoever they sent the link to.
it("refuses a template it cannot write the conversation into", () => {
    expect(() => sharePage(`<html><head></head></html>`, payload("hi"))).toThrow(/data block/);
});
