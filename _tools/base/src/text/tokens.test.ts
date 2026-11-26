// The estimate against o200k_base's real counts for the shapes the product's budgets meet, and the cut's laws for every
// input. The counts were taken with gpt-tokenizer's o200k_base on these exact strings (2026-11-26); the test needs no
// tokenizer.
import { assert, integer, property, string } from "fast-check";
import { estimateTokens, sliceToTokens } from "./tokens.js";

const SAMPLES: readonly { readonly content: string; readonly text: string; readonly o200k: number }[] = [
    {
        content: "prose",
        text:
            "Every budget in the product counts text with the same estimate, so a page that fits the reader also fits the ledger. " +
            "The estimate splits text the way the tokenizer does and prices each piece by its kind and length.",
        o200k: 43,
    },
    {
        content: "code",
        text:
            "export const clip = (markdown: string, budgetTokens: number, path: string): string => {\n    const total = estimateTokens(markdown);\n" +
            "    if (total <= budgetTokens) {\n        return markdown;\n    }\n    return markdown.slice(0, 10);\n};\n",
        o200k: 56,
    },
    {
        content: "ls -la",
        text:
            "total 24\ndrwxr-xr-x  5 root root 4096 Nov 26 11:51 .\ndrwxr-xr-x 12 root root 4096 Nov 26 11:51 ..\n" +
            "-rw-r--r--  1 root root 1873 Nov 26 11:51 format.test.ts\n-rw-r--r--  1 root root 1520 Nov 26 11:51 format.ts\n" +
            "drwxr-xr-x  2 root root 4096 Nov 26 11:51 text\n",
        o200k: 119,
    },
    {
        content: "a JSON log line",
        text: JSON.stringify({
            level: "info",
            time: "2026-11-21T20:33:13.315Z",
            pid: 107,
            provider: "gemini",
            from: "ready",
            to: "spent",
            utilization: 100,
            windowResetsAt: "2026-11-27T12:54:12.000Z",
        }),
        o200k: 66,
    },
    {
        content: "base64",
        text: Buffer.from(Array.from({ length: 600 }, (_, index) => (index * 7919 + 13) % 256)).toString("base64"),
        o200k: 551,
    },
    { content: "CJK", text: "配置在启动时加载。请在重启服务之前确认所有依赖都已安装，并且内存足够。", o200k: 26 },
];

const off = (estimate: number, truth: number): number => Math.abs(estimate - truth) / truth;

test.each(SAMPLES)("$content is within 15 percent of o200k_base, and closer than four characters a token", ({ text, o200k }) => {
    expect(off(estimateTokens(text), o200k)).toBeLessThan(0.15);
    expect(off(estimateTokens(text), o200k)).toBeLessThanOrEqual(off(Math.ceil(text.length / 4), o200k));
});

test("nothing is free and empty is nothing", () => {
    expect(estimateTokens("")).toBe(0);
    expect(estimateTokens(" ")).toBe(1);
    expect(estimateTokens("a")).toBe(1);
});

test("repeated punctuation is one piece, however long", () => {
    expect(estimateTokens("-".repeat(48))).toBe(1);
    expect(estimateTokens("|---|---|---|---|")).toBeGreaterThan(2);
});

test("a cut lands between pieces: whole words, whole numbers", () => {
    expect(sliceToTokens("alpha beta gamma delta", 2)).toBe("alpha beta");
    expect(sliceToTokens("12345678", 2)).toBe("123456");
    expect(sliceToTokens("alpha", 0)).toBe("");
    expect(sliceToTokens("", 10)).toBe("");
});

const anyText = string({ unit: "binary", maxLength: 400 });
const budget = integer({ min: 0, max: 120 });

test("a cut is a prefix whose estimate fits, and the whole text when it all fits", () => {
    assert(
        property(anyText, budget, (text, tokens) => {
            const cut = sliceToTokens(text, tokens);
            expect(text.startsWith(cut)).toBe(true);
            expect(estimateTokens(cut)).toBeLessThanOrEqual(tokens);
            expect(cut === text).toBe(estimateTokens(text) <= tokens);
        }),
    );
});

test("a larger budget never cuts shorter, and a cut never splits a surrogate pair", () => {
    assert(
        property(anyText, budget, budget, (text, first, second) => {
            const [low, high] = first <= second ? [first, second] : [second, first];
            expect(sliceToTokens(text, low).length).toBeLessThanOrEqual(sliceToTokens(text, high).length);
            const end = sliceToTokens(text, low).length;
            const code = text.charCodeAt(end);
            const before = text.charCodeAt(end - 1);
            expect(end < text.length && code >= 0xdc00 && code <= 0xdfff && before >= 0xd800 && before <= 0xdbff).toBe(false);
        }),
    );
});
