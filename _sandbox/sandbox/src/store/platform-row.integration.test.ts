import { mkdtemp, readFile, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readPlatformRow, rememberPlatformRow } from "./platform-row.js";

// What `ic sandbox session` and `ic sandbox list --json` read for the platform's id: written once per change, read back
// as the platform said it, and never guessed from a file that is not one.

test("the platform's id is kept as its announce said it, and read back", async () => {
    const root = await mkdtemp(join(tmpdir(), "platform-row-"));
    expect(await readPlatformRow(root)).toBeUndefined();
    await rememberPlatformRow(root, "cm1row");
    expect(await readPlatformRow(root)).toBe("cm1row");
    expect(JSON.parse(await readFile(join(root, "platform-row.json"), "utf8"))).toEqual({ platformId: "cm1row" });
    // The hourly heartbeat names it again: nothing is written when nothing changed.
    const before = (await stat(join(root, "platform-row.json"))).mtimeMs;
    await rememberPlatformRow(root, "cm1row");
    expect((await stat(join(root, "platform-row.json"))).mtimeMs).toBe(before);
    await rememberPlatformRow(root, "cm2row");
    expect(await readPlatformRow(root)).toBe("cm2row");
});

test("a file that names no id is no id", async () => {
    const root = await mkdtemp(join(tmpdir(), "platform-row-"));
    await writeFile(join(root, "platform-row.json"), `{"platformId":""}`);
    expect(await readPlatformRow(root)).toBeUndefined();
    await writeFile(join(root, "platform-row.json"), `not json`);
    expect(await readPlatformRow(root)).toBeUndefined();
});
