import { expect, test } from "vitest";
import { extractImports } from "./imports.js";

test("TypeScript: every import form, including type-only, re-export, require and dynamic", () => {
    const ts = `import { a } from "./widget.js";
import type { B } from "../types.js";
import defaultThing from "@intentic/sdk";
import "./side-effect.css";
export { c } from "./registry.js";
const d = require("node:fs");
const e = await import("./lazy.js");
`;
    expect(extractImports("src/a.ts", "ts", ts).toSorted()).toEqual(
        ["../types.js", "./lazy.js", "./registry.js", "./side-effect.css", "./widget.js", "@intentic/sdk", "node:fs"].toSorted(),
    );
});

test("Vue SFC: specifiers come from the script block", () => {
    const vue = `<script setup lang="ts">
import { computed } from "vue";
import { createWidget } from "./widget.js";
</script>

<template><div /></template>
`;
    expect(extractImports("src/A.vue", "vue", vue).toSorted()).toEqual(["./widget.js", "vue"]);
});

test("Python and Go/Java forms", () => {
    expect(extractImports("app.py", "python", "from pkg.mod import thing\nimport os\n").toSorted()).toEqual(["os", "pkg.mod"]);
    expect(extractImports("A.java", "java", "import com.example.Thing;\n")).toEqual(["com.example.Thing"]);
});

test("data and markup contribute no specifiers", () => {
    expect(extractImports("package.json", undefined, `{ "name": "x", "scripts": { "b": "import foo from 'bar'" } }`)).toEqual([]);
});
