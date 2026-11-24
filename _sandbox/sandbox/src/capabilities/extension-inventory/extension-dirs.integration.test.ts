import * as fsp from "node:fs/promises";
import { copyFile, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { repoRoot } from "@intentic/constants/node";
import { memoClock, RACY_MS } from "../../store/memo/file-memo.js";
import { parseExtensionManifest } from "../extension-dirs.js";

const realNow = Date.now;
const dirs: string[] = [];
afterEach(async () => {
    memoClock.now = realNow;
    jest.restoreAllMocks();
    for (const dir of dirs.splice(0)) {
        await rm(dir, { recursive: true, force: true });
    }
});
const extension = async (): Promise<string> => {
    const dir = await mkdtemp(join(tmpdir(), "intentic-extension-dirs-"));
    dirs.push(dir);
    return dir;
};
const SHIPPED = join(repoRoot(import.meta.url), "_extensions/approvals/intentic-extension.json");

test("an unchanged manifest is read and validated once; a rewrite and a removal are seen", async () => {
    const dir = await extension();
    const path = join(dir, "intentic-extension.json");
    await copyFile(SHIPPED, path);
    memoClock.now = () => realNow() + 10 * RACY_MS;
    const first = await parseExtensionManifest(dir);
    expect("manifest" in first).toBe(true);
    const reads = jest.spyOn(fsp, "readFile");
    const again = await parseExtensionManifest(dir);
    expect(again).toBe(first);
    expect(reads.mock.calls.filter(([target]) => target === path)).toHaveLength(0);

    await writeFile(path, "{ not json");
    expect(await parseExtensionManifest(dir)).toMatchObject({ error: expect.any(String) });
    await rm(path);
    expect(await parseExtensionManifest(dir)).toEqual({ error: "no intentic-extension.json at the extension root" });
});

test("a manifest read is frozen, so one caller cannot change what the next is handed", async () => {
    const dir = await extension();
    await copyFile(SHIPPED, join(dir, "intentic-extension.json"));
    const read = await parseExtensionManifest(dir);
    expect("manifest" in read && Object.isFrozen(read.manifest)).toBe(true);
});
