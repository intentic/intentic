import { parseEntry } from "./parse-entry.js";

test("a source file keeps its symbols, imports, scored decisions and source chunks together", () => {
    const content = `import { fallback } from "./fallback.js";
export const choose = (flag: boolean, n?: number): number => flag && (n ?? fallback) ? 1 : 0;
`;
    const result = parseEntry("src/choose.ts", "ts", content);

    expect(result.symbols.map(({ name, kind, line, exported }) => ({ name, kind, line, exported }))).toEqual([
        { name: "choose", kind: "fn", line: 2, exported: true },
    ]);
    expect(result.complexity).toBe(3);
    expect(result.imports).toEqual(["./fallback.js"]);
    expect(result.chunks.map((chunk) => chunk.text).join("\n")).toContain(content.split("\n")[1]!);
});

test("successive files in different grammars keep their own definitions and decisions", () => {
    const python = parseEntry("src/a.py", "python", `def choose(flag):\n    return 1 if flag else 0\n`);
    const rust = parseEntry("src/a.rs", "rust", `pub fn choose(flag: bool) -> i32 { if flag { 1 } else { 0 } }`);
    const tsx = parseEntry("src/a.tsx", "tsx", `export const view = ready && <View value={first ?? second} />;`);

    expect(python.symbols.map((symbol) => symbol.name)).toEqual(["choose"]);
    expect(rust.symbols.map((symbol) => symbol.name)).toEqual(["choose"]);
    expect(tsx.symbols.map((symbol) => symbol.name)).toEqual(["view"]);
    expect([python.complexity, rust.complexity, tsx.complexity]).toEqual([1, 1, 2]);
});

test("component blocks retain file-relative lines and template keywords add no decisions", () => {
    const result = parseEntry(
        "src/A.vue",
        "vue",
        `<script setup lang="ts">\nconst selected = first ?? second;\n</script>\n<template><div v-if="visible">for while</div></template>`,
    );

    expect(result.symbols.map(({ name, line }) => ({ name, line }))).toEqual([{ name: "selected", line: 2 }]);
    expect(result.complexity).toBe(1);
});

test("non-code and unsupported grammars keep their existing fallbacks", () => {
    const config = parseEntry("data.json", "ts", `{"if": "for while &&"}`);
    const script = parseEntry("run.sh", undefined, `if true; then\n  for item in a b; do echo "$item"; done\nfi`);

    expect(config.symbols).toEqual([]);
    expect(config.complexity).toBe(0);
    expect(config.imports).toEqual([]);
    expect(script.complexity).toBe(2);
    expect(script.chunks.map((chunk) => chunk.text).join("\n")).toContain("if true; then");
});
