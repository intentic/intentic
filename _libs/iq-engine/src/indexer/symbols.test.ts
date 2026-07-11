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
    const symbols = extractSymbols("repositories/alpha/src/widget.ts", "ts", TS);
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
    const symbols = extractSymbols("repositories/alpha/src/widget.spec.ts", "ts", "export const specSmoke = () => true;");
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
    const symbols = extractSymbols("repositories/beta/app.py", "python", PY);
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
