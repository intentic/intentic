import { mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// The cache directory is read when the module loads, so it is pointed somewhere throwaway before the import.
const scratch = mkdtempSync(join(tmpdir(), `bun-vue-test-`));
const cacheDir = join(scratch, `cache`);
process.env[`VUE_SFC_CACHE_DIR`] = cacheDir;
const { loadSfc } = await import(`./bun-vue.js`);

const component = (path: string, greeting: string): string => {
    writeFileSync(
        path,
        `<script setup lang="ts">\nconst greeting = ${JSON.stringify(greeting)};\n</script>\n<template><p>{{ greeting }}</p></template>\n`,
    );
    return path;
};

const entries = (): string[] => readdirSync(cacheDir).filter((name) => name.endsWith(`.js`));

afterAll(() => {
    rmSync(scratch, { recursive: true, force: true });
});

test("a component compiles once and is read back from the cache after that, byte for byte", () => {
    const path = component(join(scratch, `Hello.vue`), `hello`);
    const compiled = loadSfc(path);
    expect(compiled).toContain(`hello`);
    expect(entries()).toHaveLength(1);
    expect(loadSfc(path)).toBe(compiled);
    expect(entries()).toHaveLength(1);
});

test("a changed file is a new entry, never the old output", () => {
    const path = component(join(scratch, `Changing.vue`), `before`);
    const before = loadSfc(path);
    component(path, `after`);
    const after = loadSfc(path);
    expect(after).toContain(`after`);
    expect(after).not.toBe(before);
});

test("the same bytes at another path are another entry, since the scope id is the path's", () => {
    const first = component(join(scratch, `First.vue`), `same`);
    const second = component(join(scratch, `Second.vue`), `same`);
    const counted = entries().length;
    loadSfc(first);
    loadSfc(second);
    expect(entries()).toHaveLength(counted + 2);
});

test("a component that does not parse still says why, and leaves nothing cached", () => {
    const path = join(scratch, `Broken.vue`);
    writeFileSync(path, `<template><p></template>`);
    const counted = entries().length;
    expect(() => loadSfc(path)).toThrow(`Broken.vue`);
    expect(entries()).toHaveLength(counted);
});
