import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, test } from "vitest";
import { diagnose } from "./client.js";

const made: string[] = [];
const fixture = (): string => {
    const dir = mkdtempSync(join(tmpdir(), "lsp-client-"));
    made.push(dir);
    return dir;
};

afterEach(() => {
    for (const dir of made.splice(0)) {
        rmSync(dir, { recursive: true, force: true });
    }
});

const TSCONFIG = '{"compilerOptions":{"strict":true,"noEmit":true,"module":"nodenext"}}';

test("a file with no tsconfig above it has no answer at all", async () => {
    const dir = fixture();
    const file = join(dir, "plain.ts");
    writeFileSync(file, "export {};\n");
    expect(await diagnose({ files: [file] })).toBeUndefined();
});

test("files from two projects are grouped, checked apart, and answered together", async () => {
    const dir = fixture();
    for (const name of ["one", "two"]) {
        mkdirSync(join(dir, name));
        writeFileSync(join(dir, name, "tsconfig.json"), TSCONFIG);
    }
    const broken = join(dir, "one", "a.ts");
    writeFileSync(broken, 'export const n: number = "nope";\n');
    const clean = join(dir, "two", "b.ts");
    writeFileSync(clean, "export const ok = true;\n");
    const report = await diagnose({ files: [broken, clean] });
    expect(report).toBeDefined();
    expect(report!.unavailable).toEqual([]);
    expect(report!.diagnostics.map((d) => d.file)).toEqual([broken]);
});

/* Agents edit in bursts — six PostToolUse hooks inside a second, all about one package. Concurrent asks about
 * one project must all come back right (each caller sees its own file's slice), however the client pools the
 * underlying compiler runs. */
test("concurrent asks about one project each get their own file's answer", async () => {
    const dir = fixture();
    writeFileSync(join(dir, "tsconfig.json"), TSCONFIG);
    const files = ["a", "b", "c", "d", "e", "f"].map((name) => {
        const file = join(dir, `${name}.ts`);
        writeFileSync(file, name === "c" ? 'export const n: number = "nope";\n' : `export const ${name} = 1;\n`);
        return file;
    });
    const reports = await Promise.all(files.map((file) => diagnose({ files: [file] })));
    for (const [i, report] of reports.entries()) {
        expect(report).toBeDefined();
        expect(report!.unavailable).toEqual([]);
        if (files[i]!.endsWith("c.ts")) {
            expect(report!.diagnostics.map((d) => d.code)).toEqual([2322]);
        } else {
            expect(report!.diagnostics).toEqual([]);
        }
    }
});

test("a refusal reaches every asker of the project as per-file unavailability", async () => {
    const dir = fixture();
    writeFileSync(join(dir, "tsconfig.json"), '{"extends":"./missing.json"}');
    const file = join(dir, "a.ts");
    writeFileSync(file, "export {};\n");
    const report = await diagnose({ files: [file] });
    expect(report).toBeDefined();
    expect(report!.diagnostics).toEqual([]);
    expect(report!.unavailable).toHaveLength(1);
    expect(report!.unavailable[0]).toMatchObject({ file });
});
