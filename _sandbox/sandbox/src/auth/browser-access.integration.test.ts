import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, test } from "vitest";
import { fileBrowserAccess } from "./browser-access.js";

const roots: string[] = [];

afterEach(async () => {
    await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

test("a missing marker enables browser auth; any persisted marker disables it", async () => {
    const root = await mkdtemp(join(tmpdir(), "intentic-browser-access-"));
    roots.push(root);
    const path = join(root, "nested", "browser-access-disabled");
    const access = fileBrowserAccess(path);

    await expect(access.enabled()).resolves.toBe(true);
    await access.disable();
    await expect(access.enabled()).resolves.toBe(false);

    // Marker presence, not a fragile exact payload, is permanent retirement after a partial host write.
    await writeFile(path, "");
    await expect(access.enabled()).resolves.toBe(false);
});
