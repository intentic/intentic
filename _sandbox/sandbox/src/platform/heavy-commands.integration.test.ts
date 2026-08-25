import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "vitest";
import { DEFAULT_HEAVY_COMMANDS, fileHeavyCommandsStore, type HeavyCommands, matchHeavyCommand } from "./heavy-commands.js";

/* THE FILE HALF: what .intentic/config/heavy-commands.json does on disk. Separated from heavy-commands.test.ts
 * because these open real temp trees and the matcher's tests do not — the two budgets exist precisely so a
 * suite that touches a filesystem is not held to a 5s hang detector (see @intentic/testing/vitest).
 *
 * The whole point of the feature is that a person edits this file, so "what happens to an edit" is the
 * behaviour worth pinning: it must survive a seed, it must be able to make something new heavy, and a
 * half-written one must not silently switch the protection off. */

const dir = async (): Promise<string> => mkdtemp(join(tmpdir(), "heavy-"));

test("an absent file reads as the shipped defaults", async () => {
    const store = fileHeavyCommandsStore(join(await dir(), "heavy-commands.json"));
    expect(await store.read()).toEqual(DEFAULT_HEAVY_COMMANDS);
});

test("seed writes the defaults once, and never touches a file that already exists", async () => {
    const path = join(await dir(), "heavy-commands.json");
    const store = fileHeavyCommandsStore(path);
    await store.seed();
    const written = JSON.parse(await readFile(path, "utf8")) as HeavyCommands;
    expect(written.limit).toBe(2);

    // A hand-tuned file is the whole reason this feature exists; seeding again must not undo someone's edit,
    // and the daemon seeds on every boot.
    await writeFile(path, JSON.stringify({ limit: 1, rules: [{ id: "mine", pattern: "make" }] }));
    await store.seed();
    expect(JSON.parse(await readFile(path, "utf8"))).toEqual({ limit: 1, rules: [{ id: "mine", pattern: "make" }] });
    expect((await store.read()).limit).toBe(1);
});

test("a hand-edited file decides what is heavy, including making something new heavy", async () => {
    const path = join(await dir(), "heavy-commands.json");
    await writeFile(path, JSON.stringify({ limit: 1, rules: [{ id: "gradle", pattern: "\\bgradlew?\\b" }] }));
    const loaded = await fileHeavyCommandsStore(path).read();
    expect(matchHeavyCommand("./gradlew assembleRelease", loaded)).toEqual({ id: "gradle", pool: "heavy", limit: 1 });
    // ...and what is no longer heavy: the shipped rules are REPLACED, not merged, so an owner can shrink the
    // list as well as grow it. A merge would make the defaults impossible to opt out of.
    expect(matchHeavyCommand("pnpm test", loaded)).toBeUndefined();
});

test("an unreadable file reports and falls back to the defaults rather than queueing nothing", async () => {
    const path = join(await dir(), "heavy-commands.json");
    await writeFile(path, "{ not json");
    const reasons: string[] = [];
    const store = fileHeavyCommandsStore(path, (reason) => reasons.push(reason));
    /* Falling back to "no rules" would silently disable the protection on exactly the box whose config someone
     * was mid-edit on, which is the moment it is most likely to be needed. Falling back to the shipped rules
     * keeps the box protected and puts the problem on the screen instead. */
    expect(await store.read()).toEqual(DEFAULT_HEAVY_COMMANDS);
    await writeFile(path, JSON.stringify({ limit: -4 }));
    expect(await store.read()).toEqual(DEFAULT_HEAVY_COMMANDS);
    expect(reasons.length).toBeGreaterThan(0);
});
