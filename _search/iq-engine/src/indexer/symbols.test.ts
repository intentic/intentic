import { expect, test } from "vitest";
import { extractSymbols } from "./symbols.js";

const TS = `export interface Widget {
    name: string;
}

// Builds one widget.
export const createWidget = (name: string): Widget => ({ name });

const internal = 42;

export class Registry {
    add(widget: Widget): void {
        void widget;
    }
}

export function reset(): void {}
`;

test("TS extraction: interfaces, arrow consts, plain consts, classes, methods, functions", () => {
    const symbols = extractSymbols("alpha/src/widget.ts", "ts", TS);
    const byName = new Map(symbols.map((symbol) => [symbol.name, symbol]));
    expect(byName.get("Widget")?.kind).toBe("type");
    expect(byName.get("createWidget")?.kind).toBe("fn");
    expect(byName.get("createWidget")?.exported).toBe(true);
    expect(byName.get("internal")?.kind).toBe("const");
    expect(byName.get("internal")?.exported).toBe(false);
    expect(byName.get("Registry")?.kind).toBe("class");
    expect(byName.get("add")?.kind).toBe("method");
    expect(byName.get("reset")?.kind).toBe("fn");
    expect(symbols.every((symbol) => !symbol.heuristic)).toBe(true);
    expect(byName.get("Registry")!.endLine).toBeGreaterThan(byName.get("Registry")!.line);
});

test("test files map fn/const to test kind", () => {
    const symbols = extractSymbols("alpha/src/widget.spec.ts", "ts", "export const specSmoke = () => true;");
    expect(symbols[0]?.kind).toBe("test");
});

const PY = `class Foo:
    def method(self):
        pass

def top_level(x):
    return x

def _private():
    pass
`;

test("Python extraction: classes, methods vs functions, underscore privacy", () => {
    const symbols = extractSymbols("beta/app.py", "python", PY);
    const byName = new Map(symbols.map((symbol) => [symbol.name, symbol]));
    expect(byName.get("Foo")?.kind).toBe("class");
    expect(byName.get("method")?.kind).toBe("method");
    expect(byName.get("top_level")?.kind).toBe("fn");
    expect(byName.get("_private")?.exported).toBe(false);
});

test("unknown languages fall back to flagged heuristics", () => {
    const symbols = extractSymbols("scripts/build.zig", undefined, "export function doBuild() {\n}\n");
    expect(symbols[0]?.name).toBe("doBuild");
    expect(symbols[0]?.heuristic).toBe(true);
});

const VUE = `<script setup lang="ts">
import { computed } from "vue";

const props = defineProps<{ repo: string }>();

const barOf = (group: string): string => {
    function pick(): string {
        return group;
    }
    return pick();
};

const legend = computed(() => [props.repo]);
</script>

<template>
    <div>{{ legend }}</div>
</template>
`;

test("Vue SFC extraction: script-block symbols land on their real file lines", () => {
    const symbols = extractSymbols("_extensions/repo-apps/src/DependenciesView.vue", "vue", VUE);
    const byName = new Map(symbols.map((symbol) => [symbol.name, symbol]));
    expect(byName.get("barOf")?.kind).toBe("fn");
    // `computed(...)` is a call, so the declarator reads as a value: same as it would in a .ts file.
    expect(byName.get("legend")?.kind).toBe("const");
    expect(byName.get("props")?.kind).toBe("const");
    expect(symbols.every((symbol) => !symbol.heuristic)).toBe(true);
    // `const barOf` is line 6 of the file, not line 5 of the script block.
    expect(byName.get("barOf")?.line).toBe(6);
    expect(VUE.split("\n")[byName.get("barOf")!.line - 1]).toContain("const barOf");
});

test("Vue SFC extraction: script-setup locals are indexed but not exported", () => {
    const byName = new Map(extractSymbols("app/Widget.vue", "vue", VUE).map((symbol) => [symbol.name, symbol]));
    // Indexed, so `iq def barOf` finds it inside the component…
    expect(byName.get("barOf")).toBeDefined();
    expect(byName.get("pick")).toBeDefined();
    // …but a component's locals are not its API, and claiming otherwise turns every large component into a fake
    // hub in the map's reference graph (`step`, `busy`, `error` match everywhere).
    expect(byName.get("barOf")?.exported).toBe(false);
    expect(byName.get("legend")?.exported).toBe(false);
});

test("Vue SFC extraction: a real module-scope export still reads as exported", () => {
    const two = `<script lang="ts">
export const WIDGET_KIND = "widget";
</script>
`;
    expect(extractSymbols("app/Widget.vue", "vue", two)[0]?.exported).toBe(true);
});

test("Vue SFC extraction: both blocks of the two-block form contribute", () => {
    const two = `<script lang="ts">
export const NAME = "widget";
</script>

<script setup lang="ts">
const local = 1;
</script>
`;
    const byName = new Map(extractSymbols("app/Widget.vue", "vue", two).map((symbol) => [symbol.name, symbol]));
    expect(byName.get("NAME")?.line).toBe(2);
    expect(byName.get("local")?.line).toBe(6);
});

/* A DESTRUCTURING DECLARATOR IS NOT A DEFINITION, and reading its name field as a name is how 481 pattern-shaped
 * rows reached a real index: `{ app }`, `[logPath, pattern]`, and, from every `.vue` written in this repo's own
 * style: the whole multi-line `defineProps` destructure. Each one then surfaced as an `iq def` candidate and
 * annotated ordinary hits `⟨in { app } (const)⟩`, and the 31 that spanned lines went further: the graph stage
 * hands an anchor name to ripgrep as a search pattern, which rejects a newline and takes the entire query with
 * it. Two natural-language searches a day died that way, after the embedder and reranker had already been paid.
 */
test("declarators: a destructuring pattern is not indexed as a symbol", () => {
    const names = (source: string): string[] => extractSymbols("app/x.ts", "ts", source).map((symbol) => symbol.name);
    expect(names(`const { app } = start();`)).toEqual([]);
    expect(names(`const [logPath, pattern] = process.argv.slice(2);`)).toEqual([]);
    // The shape that carried a newline into a regex.
    expect(names(`const {\n    names,\n    heading = "Widgets",\n} = defineProps<{ names: string[] }>();`)).toEqual([]);
    // …while the ordinary declarator beside it is untouched.
    expect(names(`const { app } = start();\nexport const widgetCount = 3;`)).toEqual(["widgetCount"]);
});

// Whatever the extractors do next, a name the graph stage cannot search for must not reach it: every symbol
// the table offers as an anchor has to be a single token.
test("declarators: every extracted name is a single searchable token", () => {
    const sfc = `<script setup lang="ts">
const {
    names,
    heading = \`Widgets\`,
} = defineProps<{ names: string[]; heading?: string }>();
const widgets = names.map((name) => name);
</script>
`;
    for (const symbol of extractSymbols("app/WidgetList.vue", "vue", sfc)) {
        expect(symbol.name).not.toMatch(/\s/);
    }
});
