// token-estimate.mjs is a copy of @intentic/base's estimate, kept because the image copies this package's files as
// written. This holds the copy to the original: the same count and the same cut on this package's own sources and on
// text drawn from every character class the estimate tells apart.
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { expect, test } from "bun:test";
import * as base from "../../../../_tools/base/src/text/tokens.ts";
import { estimateTokens, sliceToTokens } from "../token-estimate.mjs";

const SRC = join(import.meta.dirname, "..");
// ASCII letters, digits, whitespace and punctuation, accented and Cyrillic letters, CJK, symbols, an emoji (a surrogate
// pair) and the non-ASCII spaces.
const POOL = [
    ...String.raw`abcXYZ0129.,;:-_=/\"'(){}[]<>|*#@$%&!?~`,
    " ",
    "\t",
    "\n",
    "\r",
    ..."éłßЖщΩ中語한カ→✓─",
    "\u{1F600}",
    "\u00A0",
    "\u3000",
    "\u2009",
];

// A seeded draw, so a failure names the same text on every run.
const drawn = () => {
    let seed = 20_261_126;
    const next = () => {
        seed = (seed * 1_103_515_245 + 12_345) % 2_147_483_648;
        return seed / 2_147_483_648;
    };
    return Array.from({ length: 300 }, () => {
        const length = Math.floor(next() * 600);
        // Runs of one character too, since repeats and whitespace runs are priced as runs.
        return Array.from({ length }, () => (next() < 0.2 ? "    " : POOL[Math.floor(next() * POOL.length)])).join("");
    });
};

test("the copy counts and cuts exactly as @intentic/base does", () => {
    const sources = readdirSync(SRC)
        .filter((name) => name.endsWith(".mjs"))
        .map((name) => readFileSync(join(SRC, name), "utf8"));
    const texts = [...sources, readFileSync(join(SRC, "..", "README.md"), "utf8"), ...drawn(), ""];
    const differing = texts.filter(
        (text) =>
            estimateTokens(text) !== base.estimateTokens(text) ||
            [0, 1, 7, 100, 2000].some((budget) => sliceToTokens(text, budget) !== base.sliceToTokens(text, budget)),
    );
    expect(differing.map((text) => text.slice(0, 80))).toEqual([]);
    expect(texts.length).toBeGreaterThan(300);
});
