import { mkdtempSync, mkdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, test } from "vitest";
import { checkProject, findTsconfig } from "./checker.js";

// Real compiler runs against throwaway fixture projects: the checker's whole job is what it relays and what
// it refuses, and only the real compiler can vouch for that.

const made: string[] = [];
const fixture = (): string => {
    const dir = mkdtempSync(join(tmpdir(), "lsp-checker-"));
    made.push(dir);
    return dir;
};

afterEach(() => {
    for (const dir of made.splice(0)) {
        rmSync(dir, { recursive: true, force: true });
    }
});

const TSCONFIG = '{"compilerOptions":{"strict":true,"noEmit":true,"module":"nodenext"}}';

test("a clean project answers with no diagnostics and no refusal", async () => {
    const dir = fixture();
    writeFileSync(join(dir, "tsconfig.json"), TSCONFIG);
    const file = join(dir, "a.ts");
    writeFileSync(file, "export const n: number = 1;\n");
    const report = await checkProject(join(dir, "tsconfig.json"), [file], undefined);
    expect(report.unavailable).toEqual([]);
    expect(report.diagnostics).toEqual([]);
});

test("a type error is reported with its position", async () => {
    const dir = fixture();
    writeFileSync(join(dir, "tsconfig.json"), TSCONFIG);
    const file = join(dir, "a.ts");
    writeFileSync(file, 'export const n: number = "nope";\n');
    const report = await checkProject(join(dir, "tsconfig.json"), [file], undefined);
    expect(report.unavailable).toEqual([]);
    expect(report.diagnostics).toHaveLength(1);
    expect(report.diagnostics[0]).toMatchObject({ file, line: 1, code: 2322, category: "error" });
});

test("the report covers only the asked files, though the whole project was checked", async () => {
    const dir = fixture();
    writeFileSync(join(dir, "tsconfig.json"), TSCONFIG);
    const clean = join(dir, "clean.ts");
    writeFileSync(clean, "export const ok = true;\n");
    writeFileSync(join(dir, "broken.ts"), 'export const n: number = "nope";\n');
    const report = await checkProject(join(dir, "tsconfig.json"), [clean], undefined);
    expect(report.diagnostics).toEqual([]);
    expect(report.unavailable).toEqual([]);
});

test("a config chain that does not load is a refusal, not a diagnostic", async () => {
    const dir = fixture();
    writeFileSync(join(dir, "tsconfig.json"), '{"extends":"./nonexistent.json"}');
    const file = join(dir, "a.ts");
    writeFileSync(file, "export const n: number = 1;\n");
    const report = await checkProject(join(dir, "tsconfig.json"), [file], undefined);
    expect(report.diagnostics).toEqual([]);
    expect(report.unavailable).toHaveLength(1);
    expect(report.unavailable[0]?.reason).toContain("nonexistent.json");
});

/* The native compiler does not auto-include @types from parent node_modules directories the way the JS one
 * does. A program tripping over missing node globals while an ancestor @types directory exists would send the
 * agent errors its own toolchain never shows it, so it is refused, with the reason. */
test("missing node globals with an ancestor @types directory is a refusal", async () => {
    const dir = fixture();
    const realTypes = join(import.meta.dirname, "..", "..", "..", "node_modules", "@types");
    mkdirSync(join(dir, "node_modules"));
    symlinkSync(realTypes, join(dir, "node_modules", "@types"));
    mkdirSync(join(dir, "pkg"));
    writeFileSync(join(dir, "pkg", "tsconfig.json"), TSCONFIG);
    const file = join(dir, "pkg", "main.ts");
    writeFileSync(file, "export const p = process.platform;\n");
    const report = await checkProject(join(dir, "pkg", "tsconfig.json"), [file], undefined);
    expect(report.diagnostics).toEqual([]);
    expect(report.unavailable[0]?.reason).toContain("parent node_modules/@types");
});

test("without any ancestor @types, missing node globals are a real error and reported", async () => {
    const dir = fixture();
    writeFileSync(join(dir, "tsconfig.json"), TSCONFIG);
    const file = join(dir, "main.ts");
    writeFileSync(file, "export const p = process.platform;\n");
    const report = await checkProject(join(dir, "tsconfig.json"), [file], undefined);
    expect(report.unavailable).toEqual([]);
    expect(report.diagnostics.some((d) => d.code === 2591 || d.code === 2580)).toBe(true);
});

test(".vue module-shape errors are dropped; the file's other errors stay real", async () => {
    const dir = fixture();
    writeFileSync(join(dir, "tsconfig.json"), TSCONFIG);
    const file = join(dir, "app.ts");
    writeFileSync(file, 'import Widget from "./Widget.vue";\nexport const w = Widget;\nexport const n: number = "nope";\n');
    const report = await checkProject(join(dir, "tsconfig.json"), [file], undefined);
    expect(report.unavailable).toEqual([]);
    expect(report.diagnostics.map((d) => d.code)).toEqual([2322]);
});

test("a file with no tsconfig above it is checked alone against the compiler's defaults", async () => {
    const dir = fixture();
    const file = join(dir, "alone.ts");
    writeFileSync(file, 'export const n: number = "nope";\n');
    expect(findTsconfig(file)).toBeUndefined();
    const report = await checkProject(undefined, [file], undefined);
    expect(report.diagnostics.some((d) => d.code === 2322)).toBe(true);
});

test("findTsconfig finds the nearest config walking up", async () => {
    const dir = fixture();
    writeFileSync(join(dir, "tsconfig.json"), TSCONFIG);
    mkdirSync(join(dir, "deep", "deeper"), { recursive: true });
    const file = join(dir, "deep", "deeper", "a.ts");
    writeFileSync(file, "export {};\n");
    expect(findTsconfig(file)).toBe(join(dir, "tsconfig.json"));
});

/* The build config excludes the tests, so a test file checked against it is in no program and comes back clean
 * whatever is in it. That is the exact shape of the type error that reached main past a green per-edit check. */
test("a test file is checked against the tsconfig.test.json beside the build config, where one exists", async () => {
    const dir = fixture();
    writeFileSync(join(dir, "tsconfig.json"), JSON.stringify({ compilerOptions: { strict: true, noEmit: true }, exclude: ["**/*.test.ts"] }));
    writeFileSync(join(dir, "tsconfig.test.json"), JSON.stringify({ extends: "./tsconfig.json", exclude: [] }));
    const testFile = join(dir, "a.test.ts");
    writeFileSync(testFile, 'export const n: number = "nope";\n');
    writeFileSync(join(dir, "a.ts"), "export {};\n");
    expect(findTsconfig(testFile)).toBe(join(dir, "tsconfig.test.json"));
    expect(findTsconfig(join(dir, "a.ts"))).toBe(join(dir, "tsconfig.json"));
    const excluded = await checkProject(join(dir, "tsconfig.json"), [testFile], undefined);
    expect(excluded.diagnostics).toEqual([]);
    const included = await checkProject(findTsconfig(testFile), [testFile], undefined);
    expect(included.diagnostics.map((d) => d.code)).toEqual([2322]);
});

test("a test file with no tsconfig.test.json beside its config is checked against the build config", async () => {
    const dir = fixture();
    writeFileSync(join(dir, "tsconfig.json"), TSCONFIG);
    const testFile = join(dir, "a.test.ts");
    writeFileSync(testFile, "export {};\n");
    expect(findTsconfig(testFile)).toBe(join(dir, "tsconfig.json"));
});
