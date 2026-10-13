import { escapeHtml, toTelegramHtml } from "./format.js";

// An agent's Markdown as Telegram's HTML: every tag a pair, code verbatim, what Telegram has no tag for made readable.

test("inline markup becomes Telegram's tags, and code spans keep their text verbatim", () => {
    expect(toTelegramHtml("**Fixed**: the _guard_ in `a < b && c` was ~~wrong~~ backwards, see [the PR](https://github.com/x/y/pull/1).")).toBe(
        '<b>Fixed</b>: the <i>guard</i> in <code>a &lt; b &amp;&amp; c</code> was <s>wrong</s> backwards, see <a href="https://github.com/x/y/pull/1">the PR</a>.',
    );
});

test("snake_case and multiplication are not italics", () => {
    expect(toTelegramHtml("set max_retry_count to 2*3*4")).toBe("set max_retry_count to 2*3*4");
});

test("a code block keeps its language and its text, markup and all", () => {
    expect(toTelegramHtml("Run:\n```ts\nconst a = 1 < 2 && **b**;\n```\nThen done.")).toBe(
        'Run:\n<pre><code class="language-ts">const a = 1 &lt; 2 &amp;&amp; **b**;</code></pre>\nThen done.',
    );
    expect(toTelegramHtml("```\nplain\n```")).toBe("<pre>plain</pre>");
});

test("headings turn bold, list markers bullets, and consecutive quote lines one quote", () => {
    expect(toTelegramHtml("## What changed\n- the guard\n  - nested\n> first\n> second\nafter")).toBe(
        "<b>What changed</b>\n• the guard\n  • nested\n<blockquote>first\nsecond</blockquote>\nafter",
    );
});

test("text that only looks like markup is escaped, never read as a tag", () => {
    expect(toTelegramHtml("<script>alert(1)</script> & <b>")).toBe("&lt;script&gt;alert(1)&lt;/script&gt; &amp; &lt;b&gt;");
    expect(escapeHtml("a<b>&c")).toBe("a&lt;b&gt;&amp;c");
});
