import { scriptBlocksOf } from "./sfc.js";

test.each(["", " ", "\t", "\n", "\r", "\f", " ignored", "/"])("script blocks accept %j before the closing bracket", (suffix) => {
    expect(scriptBlocksOf(`<template>sample</template>\n<script setup lang="tsx">\nconst value = <div />;\n</SCRIPT${suffix}>`)).toEqual([
        { content: "\nconst value = <div />;\n", lang: "tsx", lineOffset: 1 },
    ]);
});

test("script blocks stop at a complete tag name and include both script blocks", () => {
    expect(scriptBlocksOf('<scripture>ignore</scripture><script>first</scripture>still first</script ><script setup>second</script>')).toEqual([
        { content: "first</scripture>still first", lang: "ts", lineOffset: 0 },
        { content: "second", lang: "ts", lineOffset: 0 },
    ]);
});
