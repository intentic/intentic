import { importsOf } from "./import-scan.js";

test("a clause naming only types is type-only; a default, a namespace or one value name loads the module", () => {
    const text = [
        `import type { A } from "@x/a";`,
        `import { type B, type C } from "@x/b";`,
        `import { type D, e } from "@x/d";`,
        `import f from "@x/f";`,
        `export * from "@x/g";`,
        `export type { H } from "@x/h";`,
        `import "@x/side";`,
    ].join("\n");
    expect(importsOf("a.ts", text).map(({ specifier, typeOnly, line }) => [specifier, typeOnly, line])).toEqual([
        ["@x/a", true, 1],
        ["@x/b", true, 2],
        ["@x/d", false, 3],
        ["@x/f", false, 4],
        ["@x/g", false, 5],
        ["@x/h", true, 6],
        ["@x/side", false, 7],
    ]);
});

test("a multi-line clause is read whole, at the line its specifier is on", () => {
    expect(importsOf("a.ts", `import type {\n    A,\n    B,\n} from "@x/a";\n`)).toEqual([{ specifier: "@x/a", typeOnly: true, line: 4 }]);
});

test("calls load their module; a template with a substitution names a pattern and is skipped", () => {
    const text =
        'const a = await import("@x/a");\nconst b = require("@x/b");\nconst c = import(`./locales/${lang}.json`);\nimport(/* @vite-ignore */ "@x/d");';
    expect(importsOf("a.ts", text).map(({ specifier }) => specifier)).toEqual(["@x/a", "@x/b", "@x/d"]);
});

test("a component is read through its script and style blocks, and a stylesheet through its @import lines only", () => {
    const component = `<template><div>import x from "@x/not-code"</div></template>\n<script setup lang="ts">\nimport { a } from "@x/a";\n</script>\n<style>\n@import "@x/theme/base.css";\n</style>\n`;
    expect(importsOf("View.vue", component).map(({ specifier, line }) => [specifier, line])).toEqual([
        ["@x/theme/base.css", 6],
        ["@x/a", 3],
    ]);
    expect(importsOf("styles.css", `@import url("../../_shared/css/house.css");\n.a { content: "import x from 'y'"; }`)).toEqual([
        { specifier: "../../_shared/css/house.css", typeOnly: false, line: 1 },
    ]);
});
