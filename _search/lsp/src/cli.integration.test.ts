import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

// The CLI as an agent runs it, a subprocess whose stderr it throws away: every refusal must reach stdout, and its exit
// code must not be the 1 a search tool uses for "found nothing". Only the paths that answer before any compiler starts.
const CLI = fileURLToPath(new URL("./cli.ts", import.meta.url));
const run = (...args: string[]) => {
    const result = spawnSync(process.execPath, [CLI, ...args], { encoding: "utf8" });
    return { code: result.status, stdout: result.stdout, stderr: result.stderr };
};

test("no verb prints the usage to stdout and exits 2", () => {
    expect(run()).toEqual({ code: 2, stdout: "usage:\n  lsp rename <file> <symbol> <newName>\n  lsp diag <file...>\n", stderr: "" });
});

test("an unknown verb and a verb missing its arguments are usage errors on stdout, exit 2", () => {
    const unknown = run("refactor");
    expect(unknown.code).toBe(2);
    expect(unknown.stdout.split("\n")[0]).toBe("lsp: unknown command: refactor");
    expect(unknown.stderr).toBe("");

    const short = run("rename", "a.ts");
    expect(short.code).toBe(2);
    expect(short.stdout.split("\n")[0]).toBe("lsp: rename needs <file> <symbol> <newName>");

    expect(run("diag").stdout.split("\n")[0]).toBe("lsp: diag needs at least one <file>");
});
