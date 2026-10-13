import { chunkMessage, openFenceAfter, tablesToCode } from "./chunks.js";

test("a reply that fits is one message, untouched", () => {
    expect(chunkMessage("hello there", 2_000)).toEqual(["hello there"]);
});

test("a long reply is cut at a paragraph break rather than mid-sentence", () => {
    const first = `${"a".repeat(30)} ${"b".repeat(30)}`;
    const second = "c".repeat(40);
    const chunks = chunkMessage(`${first}\n\n${second}`, 80);
    expect(chunks).toEqual([first, second]);
});

test("with no paragraph near, the cut falls on the last line break, then the last space", () => {
    expect(chunkMessage(`${"x".repeat(50)}\n${"y".repeat(50)}`, 80)).toEqual(["x".repeat(50), "y".repeat(50)]);
    expect(chunkMessage(`${"x".repeat(50)} ${"y".repeat(50)}`, 80)).toEqual(["x".repeat(50), "y".repeat(50)]);
});

test("text with nowhere to break is cut hard at the ceiling", () => {
    expect(chunkMessage("abcdefg", 3)).toEqual(["abc", "def", "g"]);
});

test("a code block cut in two is closed in the first message and reopened, language included, in the next", () => {
    const code = Array.from({ length: 12 }, (_, line) => `const value${line} = ${line};`).join("\n");
    const reply = `Here is the fix:\n\n\`\`\`ts\n${code}\n\`\`\`\n\nThat is all.`;
    const chunks = chunkMessage(reply, 160);
    expect(chunks.length).toBeGreaterThan(1);
    for (const chunk of chunks) {
        expect(chunk.length).toBeLessThanOrEqual(160);
        // Every message balances its own fences: nothing renders as an unclosed block.
        expect(openFenceAfter(chunk)).toBeUndefined();
    }
    expect(chunks[1]?.startsWith("```ts\n")).toBe(true);
    // Nothing of the code is lost or doubled across the cut.
    const rejoined = chunks.join("\n").replaceAll("\n```\n```ts\n", "\n");
    for (let line = 0; line < 12; line += 1) {
        expect(rejoined.split(`const value${line} = ${line};`)).toHaveLength(2);
    }
});

test("a fence opened inside a message and closed later in the same one needs no reopening", () => {
    const reply = `${"intro ".repeat(10)}\n\n\`\`\`\nshort\n\`\`\`\n\n${"outro ".repeat(10)}`;
    const chunks = chunkMessage(reply, 90);
    expect(chunks.every((chunk) => openFenceAfter(chunk) === undefined)).toBe(true);
});

test("openFenceAfter reads tildes and longer runs, and a closer must match the opener's character", () => {
    expect(openFenceAfter("~~~python\nprint(1)")).toEqual({ marker: "~~~", opener: "~~~python" });
    expect(openFenceAfter("````\n```\nstill open")).toEqual({ marker: "````", opener: "````" });
    expect(openFenceAfter("```js\nx\n```")).toBeUndefined();
    expect(openFenceAfter("```\nx\n~~~")).toEqual({ marker: "```", opener: "```" });
});

test("a Markdown table becomes an aligned code block, everything around it kept", () => {
    const text = ["Results:", "", "| Test | Status |", "| --- | :---: |", "| **login** | passed |", "| redirect loop | `failed` |", "", "Done."].join("\n");
    expect(tablesToCode(text)).toBe(
        ["Results:", "", "```", "Test           Status", "-------------  ------", "login          passed", "redirect loop  failed", "```", "", "Done."].join("\n"),
    );
});

test("pipes inside a code block are not a table", () => {
    const text = ["```", "| a | b |", "| --- | --- |", "```"].join("\n");
    expect(tablesToCode(text)).toBe(text);
});
