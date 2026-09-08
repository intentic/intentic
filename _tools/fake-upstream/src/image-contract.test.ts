import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

/* THE ONE THING THIS PACKAGE'S IMAGE CANNOT SURVIVE, asserted rather than remembered.
 *
 * The Dockerfile is the stock node base with `package.json` and `src` copied in — no install, no
 * `node_modules`, no build. So a workspace import anywhere under `src/` resolves perfectly from the checkout,
 * type-checks, passes every other suite in this package, and then kills the container at startup on
 * `ERR_MODULE_NOT_FOUND`.
 *
 * That is not a hypothetical failure mode; it is a night of the nightly `onboarding` job. A refactor lifted
 * this package's request-body read and JSON reply into `@intentic/testing/http-fake` alongside every other
 * fake's, which was right for all of them but this one, and the stand-in model then exited instantly every
 * time the journey stood the world up. Nothing in the repository could have said so before the container ran:
 * this test is what says so now, in the package that owns the constraint, in the suite that already runs.
 *
 * Tests and `vitest.config.ts` are exempt because they never enter the image — this file imports vitest.
 */
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
