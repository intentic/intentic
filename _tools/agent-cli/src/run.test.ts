import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { test, expect } from "bun:test";

// The invariant every `cli.ts` on this shell depends on. A CLI's entry file may import THIS module statically
// only while this module itself pulls nothing in at runtime: the first runtime import here is loaded before any
// handler exists, so a broken install would die as a raw node stack instead of the sentence that names it.
test("run.ts has no runtime import: a broken module graph must fail inside its own catch", () => {
    const source = readFileSync(fileURLToPath(new URL("./run.ts", import.meta.url)), "utf8");
    const statics = [...source.matchAll(/^import\s+(?!type\b)[^;]*?from\s+["']([^"']+)["']/gmu)].map((match) => match[1]);
    expect(statics).toEqual([]);
});
