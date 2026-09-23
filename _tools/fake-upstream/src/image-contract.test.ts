import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

/* THE ONE THING THIS PACKAGE'S IMAGE CANNOT SURVIVE, asserted rather than remembered. */
const SRC = new URL(".", import.meta.url).pathname;

// Every specifier a module can be loaded by, which for this package is `from "…"` and nothing more exotic:
// there is no `require`, and a dynamic `import()` would be caught by the same pattern.
const SPECIFIERS = /(?:\bfrom\s*|\bimport\s*\(\s*)["'`]([^"'`\n]+)["'`]/g;

const shippedFiles = readdirSync(SRC, { withFileTypes: true })
    .filter((entry) => entry.isFile() && entry.name.endsWith(".ts") && !entry.name.endsWith(".test.ts"))
    .map((entry) => entry.name);

describe("the image copies only package.json and src, so src/ must be self-contained", () => {
    // A guard on the guard: a rename that emptied this list would make every assertion below pass vacuously.
    it("has the files the image runs", () => {
        expect(shippedFiles).toEqual(expect.arrayContaining(["http.ts", "main.ts", "server.ts"]));
    });

    it.each(shippedFiles)("%s imports only node builtins and its own siblings", (name) => {
        const source = readFileSync(join(SRC, name), "utf8");
        const outside = [...source.matchAll(SPECIFIERS)]
            .map((match) => match[1])
            .filter((specifier): specifier is string => specifier !== undefined)
            .filter((specifier) => !specifier.startsWith(".") && !specifier.startsWith("node:"));
        expect(outside, `${name} imports ${outside.join(", ")}, which the image has no node_modules to resolve`).toEqual([]);
    });
});
