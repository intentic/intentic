import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "vitest";
import { DEFAULT_HEAVY_COMMANDS, fileHeavyCommandsStore, type HeavyCommands, matchHeavyCommand } from "./heavy-commands.js";

// The file half: what .intentic/config/heavy-commands.json does on disk, separate from heavy-commands.test.ts since
// these open real temp trees under a longer hang-detector budget (@intentic/testing/vitest).

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
    // The shipped rules are replaced, not merged, so an owner can shrink the list too.
    expect(matchHeavyCommand("pnpm test", loaded)).toBeUndefined();
});

test("an unreadable file reports and falls back to the defaults rather than queueing nothing", async () => {
    const path = join(await dir(), "heavy-commands.json");
    await writeFile(path, "{ not json");
    const reasons: string[] = [];
    const store = fileHeavyCommandsStore(path, (reason) => reasons.push(reason));
    expect(await store.read()).toEqual(DEFAULT_HEAVY_COMMANDS);
    await writeFile(path, JSON.stringify({ limit: -4 }));
    expect(await store.read()).toEqual(DEFAULT_HEAVY_COMMANDS);
    expect(reasons.length).toBeGreaterThan(0);
});
