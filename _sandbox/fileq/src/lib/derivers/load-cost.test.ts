import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, it, expect } from "bun:test";

// What a fileq run costs before it does anything. `derive.ts` imports all eleven derivers so `read` and `derive`
// cannot disagree about a file, which means one deriver's top-level `import` is paid by every run of the CLI: an
// agent reading a png, a sweep with nothing stale in it, `fileq --version`.
// Measured when this guard was written, on the sandbox image: loading these three took ~1.3s of a ~1.4s no-op run,
// and moving them inside `derive()` took `fileq --version` from ~560ms to ~120ms. A file of that format pays the
// same load it always did, once, in the process that actually parses it.
// Re-measure with: `node -e "import('exceljs')"` against the clock, and add anything else of that size here.
const LOAD_LAZILY = ["exceljs", "mammoth", "music-metadata"];

const HERE = import.meta.dirname;

const deriverSources = async (): Promise<{ name: string; source: string }[]> => {
    const names = (await readdir(HERE)).filter((name) => name.endsWith(".ts") && !name.endsWith(".test.ts"));
    return Promise.all(names.map(async (name) => ({ name, source: await readFile(join(HERE, name), "utf8") })));
};

describe("what a deriver costs to load", () => {
    it("keeps the heavy parsers out of every run that does not use them", async () => {
        const statik: string[] = [];
        for (const { name, source } of await deriverSources()) {
            for (const module of LOAD_LAZILY) {
                // A value import: `import x from "exceljs"`. `import type` is erased by the compiler and costs nothing,
                // and `await import("exceljs")` inside derive() is the whole point.
                if (new RegExp(String.raw`^import (?!type )[^;]*from "${module}";`, "m").test(source)) {
                    statik.push(`${name} → ${module}`);
                }
            }
        }
        expect(statik).toEqual([]);
    });

    // The same rule read from the other side: each of those parsers is still reachable, just later. A deriver that
    // dropped its parser entirely would pass the test above by doing nothing at all.
    it("still loads each of them where its own format is parsed", async () => {
        const sources = await deriverSources();
        for (const module of LOAD_LAZILY) {
            const users = sources.filter(({ source }) => source.includes(`await import("${module}")`));
            expect({ module, users: users.length }).toEqual({ module, users: 1 });
        }
    });
});
