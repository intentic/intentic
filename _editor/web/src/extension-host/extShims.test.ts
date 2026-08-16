import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { expect, test } from "vitest";
// @ts-expect-error — plain .mjs build script, no declarations
import { extShims, shimsDir } from "../../scripts/generate-ext-shims.mjs";

/* CI guard for the COMMITTED shims under public/ext-shims. They are generated output that lives in git, so
 * nothing forces a rename in a package to reach them: the source moves, the shim keeps re-exporting a name the
 * host no longer has, and the only symptom is an extension whose screen renders blank at runtime — far from
 * here, with nothing naming this file. A `cmp` → `ui` rename shipped exactly that way.
 *
 * Comparing whole file text rather than name lists is deliberate: the header and the `default` re-export are
 * part of what the browser loads, and a test that checked only names would pass on a shim pointing at the
 * wrong module. Failure means one command: `node scripts/generate-ext-shims.mjs`. */
test("every committed ext-shim matches what the generator produces", async () => {
    const stale: string[] = [];
    for (const shim of await extShims()) {
        const onDisk = await readFile(join(shimsDir, shim.file), "utf8").catch(() => undefined);
        if (onDisk !== shim.content) {
            stale.push(shim.file);
        }
    }
    expect(stale, `stale ext-shims — re-run: node scripts/generate-ext-shims.mjs`).toEqual([]);
});
