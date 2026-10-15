// The ripgrep preprocessor (bin/fileq-rg-pre) against a temp workspace: a fresh shadow is printed with page marks
// and no fileq run, a stale or pre-stat shadow falls back to `fileq read --plain`, a non-document passes through, and
// plain `rg` under the generated config cites documents by page while code reads exactly as without it.
import { spawnSync } from "node:child_process";
import { chmodSync, copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { markPages } from "@intentic/base/shadow-text";
import { captureCli } from "@intentic/agent-cli/testing";
import { app } from "./app.js";
import { documentExtensions, ripgrepConfigLines } from "./lib/formats.js";
import { DERIVED_DIR, sidecarBody } from "./lib/sidecar.js";
import { pdfPagesBytes } from "./testing.js";

const PRE = fileURLToPath(new URL("../bin/fileq-rg-pre", import.meta.url));
const hasRg = spawnSync("rg", ["--version"]).status === 0;

let root: string;
let bin: string;
let calls: string;

const page = (text: string) => ({ content: `BT /F1 12 Tf 72 700 Td (${text}) Tj ET` });

beforeAll(() => {
    root = mkdtempSync(join(tmpdir(), "fileq-rgpre-"));
    bin = mkdtempSync(join(tmpdir(), "fileq-rgpre-bin-"));
    calls = join(bin, "calls");
    // A stand-in fileq on PATH: records that the slow path ran, and answers as `read --plain` would.
    writeFileSync(join(bin, "fileq"), `#!/bin/sh\necho "$@" >> '${calls}'\nprintf '## Page 1\\n\\nslow first\\n\\n## Page 2\\n\\nslow second\\n'\n`);
    chmodSync(join(bin, "fileq"), 0o755);
    process.env["WORKSPACE_ROOT"] = root;
    mkdirSync(join(root, "docs"), { recursive: true });
    writeFileSync(join(root, "docs/terms.pdf"), pdfPagesBytes([page("Introduction to the terms of service here"), page("Each wniosek must be filed in writing today")]));
});
afterAll(() => {
    delete process.env["WORKSPACE_ROOT"];
    rmSync(root, { recursive: true, force: true });
    rmSync(bin, { recursive: true, force: true });
});

const pre = (file: string, cwd = root) => {
    rmSync(calls, { force: true });
    const result = spawnSync("sh", [PRE, file], { cwd, encoding: "utf8", env: { PATH: `${bin}:${process.env["PATH"] ?? ""}`, WORKSPACE_ROOT: root } });
    expect(result.status).toBe(0);
    return { out: result.stdout, slow: existsSync(calls) };
};

const shadowOf = (relPath: string): string => join(root, DERIVED_DIR, `${relPath}.md`);

describe("fast path: a shadow whose recorded stat is the file's", () => {
    test("prints the body with page marks, without running fileq", async () => {
        expect((await captureCli(app, ["derive", "docs/terms.pdf"])).exitCode).toBe(0);
        const shadow = readFileSync(shadowOf("docs/terms.pdf"), "utf8");
        expect(shadow).toMatch(/^source_size: \d+$/m);
        expect(shadow).toMatch(/^source_mtime: \d+\.\d{9}$/m);
        const { out, slow } = pre("./docs/terms.pdf");
        expect(slow).toBe(false);
        // The shell's marks are exactly the TypeScript ones iq indexes with.
        expect(out).toBe(markPages(sidecarBody(shadow)));
        expect(out).toContain("[p. 2] Each wniosek must be filed in writing today");
        expect(out.split("\n")[0]).toBe("[p. 1] ## Page 1");
    });

    test("an absolute path and a path from a subdirectory find the same shadow", () => {
        expect(pre(join(root, "docs/terms.pdf")).slow).toBe(false);
        expect(pre("terms.pdf", join(root, "docs")).slow).toBe(false);
        expect(pre("../docs/terms.pdf", join(root, "docs")).slow).toBe(false);
    });
});

describe("slow path: fileq read --plain, marked the same way", () => {
    test("a file touched since its shadow was written", () => {
        const later = new Date(Date.now() + 60_000);
        utimesSync(join(root, "docs/terms.pdf"), later, later);
        const { out, slow } = pre("docs/terms.pdf");
        expect(slow).toBe(true);
        expect(readFileSync(calls, "utf8")).toContain(`read --plain ${join(root, "docs/terms.pdf")}`);
        expect(out).toBe("[p. 1] ## Page 1\n[p. 1] \n[p. 1] slow first\n[p. 1] \n[p. 2] ## Page 2\n[p. 2] \n[p. 2] slow second\n");
    });

    test("fileq rewrites the stat of an unchanged file, and the next run is fast again", async () => {
        expect((await captureCli(app, ["derive", "docs/terms.pdf"])).out).toContain("fresh docs/terms.pdf");
        expect(pre("docs/terms.pdf").slow).toBe(false);
    });

    test("a sidecar written before stats were recorded still reads, through the slow path", () => {
        const path = shadowOf("docs/terms.pdf");
        const old = readFileSync(path, "utf8").replaceAll(/^source_(size|mtime): .*\n/gm, "");
        writeFileSync(path, old);
        expect(pre("docs/terms.pdf").slow).toBe(true);
    });

    test("a document with no shadow at all", () => {
        writeFileSync(join(root, "docs/fresh.pdf"), pdfPagesBytes([page("No shadow yet for this one")]));
        expect(pre("docs/fresh.pdf").slow).toBe(true);
    });
});

test("a file that is not a document passes through untouched", () => {
    writeFileSync(join(root, "notes.ts"), "export const wniosek = 1;\n");
    const { out, slow } = pre("notes.ts");
    expect(out).toBe("export const wniosek = 1;\n");
    expect(slow).toBe(false);
});

test("the script's extension list is fileq's document list", () => {
    const script = readFileSync(PRE, "utf8");
    for (const extension of documentExtensions()) {
        const bracketed = Array.from(extension.slice(1), (char) => `[${char}${char.toUpperCase()}]`).join("");
        expect(script, extension).toContain(`*.${bracketed}`);
    }
});

describe.skipIf(!hasRg)("plain rg under the generated config", () => {
    const rg = (args: string[], config: boolean): string => {
        const configPath = join(bin, "ripgreprc");
        // rg execs `--pre` directly, and git records bin/ scripts without the executable bit (the image's Dockerfile
        // adds it), so a fresh checkout's copy cannot start: an executable copy stands in for the image's.
        const executable = join(bin, "fileq-rg-pre");
        copyFileSync(PRE, executable);
        chmodSync(executable, 0o755);
        writeFileSync(configPath, `${ripgrepConfigLines(executable).join("\n")}\n`);
        // ripgrep reads an empty RIPGREP_CONFIG_PATH as unset.
        const env = { PATH: process.env["PATH"] ?? "", WORKSPACE_ROOT: root, RIPGREP_CONFIG_PATH: config ? configPath : "" };
        return spawnSync("rg", args, { cwd: root, encoding: "utf8", env }).stdout;
    };

    test("a document hit is cited by path, line and page", async () => {
        await captureCli(app, ["derive", "docs/terms.pdf"]);
        expect(rg(["-n", "wniosek", "docs"], true)).toMatch(/^docs\/terms\.pdf:\d+:\[p\. 2\] Each wniosek must be filed/m);
    });

    test("code reads exactly as it does without the config", () => {
        expect(rg(["-n", "wniosek", "notes.ts"], true)).toBe(rg(["-n", "wniosek", "notes.ts"], false));
        // Without it, rg sees the file's raw bytes: this fixture's stream happens to be uncompressed, and still no page.
        expect(rg(["-n", "Each wniosek must", "docs"], false)).not.toContain("[p. ");
    });
});
