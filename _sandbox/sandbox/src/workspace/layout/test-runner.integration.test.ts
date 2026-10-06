import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { TEST_COMMANDS, testCommandOf, testRunnerOf } from "./test-runner.js";

// A directory holding exactly the files a case names.
const dirWith = async (files: Readonly<Record<string, string>>): Promise<string> => {
    const dir = await mkdtemp(join(tmpdir(), "test-runner-"));
    for (const [name, content] of Object.entries(files)) {
        await writeFile(join(dir, name), content);
    }
    return dir;
};

const SCRIPTED = JSON.stringify({ scripts: { test: "vitest run" } });

test("a test script is the runner, ahead of any runner's config beside it", async () => {
    const dir = await dirWith({ "package.json": SCRIPTED, "bunfig.toml": "", "vitest.config.ts": "" });
    expect(testRunnerOf(dir)).toBe("script");
    expect(testCommandOf(dir)).toBe("pnpm test");
});

test("without a script, bun's config names bun ahead of vitest's", async () => {
    expect(testRunnerOf(await dirWith({ "package.json": "{}", "bunfig.toml": "", "vitest.config.ts": "" }))).toBe("bun");
    expect(testCommandOf(await dirWith({ "bunfig.toml": "" }))).toBe("bun test");
});

test("a vitest config, or a workspace catalog naming vitest, is a vitest repo", async () => {
    expect(testRunnerOf(await dirWith({ "vitest.config.ts": "" }))).toBe("vitest");
    expect(testRunnerOf(await dirWith({ "pnpm-workspace.yaml": "catalog:\n  vitest: ^3.0.0\n" }))).toBe("vitest");
    expect(testRunnerOf(await dirWith({ "pnpm-workspace.yaml": "packages:\n  - apps/*\n" }))).toBe(undefined);
});

test("a repo with nothing to run tests has no runner, and a run there is still handed to vitest", async () => {
    const dir = await dirWith({ "package.json": JSON.stringify({ scripts: { build: "tsc" } }) });
    expect(testRunnerOf(dir)).toBe(undefined);
    expect(testCommandOf(dir)).toBe(TEST_COMMANDS.vitest);
});

test("a manifest that does not parse names no script, and the config files still decide", async () => {
    expect(testRunnerOf(await dirWith({ "package.json": "{ not json" }))).toBe(undefined);
    expect(testRunnerOf(await dirWith({ "package.json": "null", "bunfig.toml": "" }))).toBe("bun");
});

test("a manifest that cannot be read is not taken for one without a script", async () => {
    const dir = await dirWith({});
    // A directory where the manifest should be: EISDIR, not missing.
    await mkdir(join(dir, "package.json"));
    expect(() => testRunnerOf(dir)).toThrow("EISDIR");
});
