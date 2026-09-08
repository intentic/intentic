import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { expect, test } from "vitest";
// @ts-expect-error: plain .mjs build script, no declarations
import { extShims, shimsDir } from "../../scripts/generate-ext-shims.mjs";

// CI guard for the committed shims under public/ext-shims. They are generated output that lives in git, so nothing
// forces a rename in a package to reach them, and the only symptom is an extension screen rendering blank at runtime,
// far from here. Comparing whole file text rather than name lists catches a shim pointing at the wrong module. Failure
// means one command: `node scripts/generate-ext-shims.mjs`.

// Generated during collection, not inside the test body: extShims() imports every package it shims, carrying a module
// graph rather than a function call. Left inside the test, that cost would sit on the test's clock and could push a
// contended full-repo run past its budget. See vitest.config.ts.
const shims = await extShims();

test("every committed ext-shim matches what the generator produces", async () => {
    const stale: string[] = [];
    for (const shim of shims) {
        const onDisk = await readFile(join(shimsDir, shim.file), "utf8").catch(() => undefined);
        if (onDisk !== shim.content) {
            stale.push(shim.file);
        }
    }
    expect(stale, `stale ext-shims — re-run: node scripts/generate-ext-shims.mjs`).toEqual([]);
});
