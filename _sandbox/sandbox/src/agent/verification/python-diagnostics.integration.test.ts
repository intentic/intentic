import { execFileSync } from "node:child_process";
import { chmod, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, expect, test } from "vitest";
import { interpreterNear, runPythonDiag } from "./python-diagnostics.js";

/* THE REAL TOOLS, WHERE THERE ARE ANY. Everything here spawns ruff or pyright over a file on disk, which is the
 * only way to answer the question the unit tests next door cannot: whether what those binaries actually print
 * is what the parsers were written for. A pin bump that changes ruff's concise format or pyright's JSON is a
 * skew nothing else in this repository can see.
 *
 * ABSENT IS NOT A FAILURE, WRONG IS — the judgement packs.integration.test.ts makes about provider CLIs, for the
 * same reason. Both binaries ride the `python` feature pack, so a core image and a developer checkout have
 * neither and have nothing to check; a standard image has both and is held to them. What happens when they are
 * missing is a contract of its own ("unavailable", never a clean file) and is tested where it can be forced,
 * against the hook in agent-diagnostics.test.ts. */

const installed = (binary: string): boolean => {
    try {
        execFileSync(binary, ["--version"], { stdio: "ignore", timeout: 30_000 });
        return true;
    } catch {
        return false;
    }
};

const hasRuff = installed("ruff");
const hasPyright = installed("pyright");

const tempDirs: string[] = [];
afterAll(async () => {
    await Promise.all(tempDirs.map((dir) => rm(dir, { recursive: true, force: true })));
});

const project = async (files: Record<string, string>): Promise<string> => {
    const dir = await mkdtemp(join(tmpdir(), "python-diag-"));
    tempDirs.push(dir);
    await Promise.all(Object.entries(files).map(([name, content]) => writeFile(join(dir, name), content)));
    return dir;
};

const asIs = (file: string): string => file;
const check = (file: string) => runPythonDiag({ file, placement: undefined, named: asIs });

test("the nearest .venv above a file is what the type check is pointed at, and a hollow one is not an environment", async () => {
    const root = await mkdtemp(join(tmpdir(), "python-venv-"));
    tempDirs.push(root);
    await mkdir(join(root, "src", "deep"), { recursive: true });
    const file = join(root, "src", "deep", "main.py");
    await writeFile(file, "x = 1\n");

    // A `.venv` directory with no interpreter in it resolves nothing, so it must not read as an environment:
    // pointing pyright at one would report every import as missing while claiming an environment was in use.
    await mkdir(join(root, ".venv", "bin"), { recursive: true });
    expect(await interpreterNear(file)).toBeUndefined();

    const interpreter = join(root, ".venv", "bin", "python");
    await writeFile(interpreter, "#!/bin/sh\nexec python3 \"$@\"\n");
    await chmod(interpreter, 0o755);
    // Found from a file several directories below it, which is where a project's modules actually live.
    expect(await interpreterNear(file)).toBe(interpreter);
});

test.skipIf(!hasRuff)("a file that does not parse comes back as a syntax error", async () => {
    const dir = await project({ "broken.py": "def f(:\n    return 1\n" });
    const answer = await check(join(dir, "broken.py"));

    expect(answer.kind).toBe("checked");
    expect(answer.kind === "checked" ? answer.lines[0] : "").toContain(`${join(dir, "broken.py")}:1:7: error invalid-syntax:`);
});

test.skipIf(!hasRuff)("an undefined name is an error, and a file with nothing wrong with it has nothing said about it", async () => {
    const dir = await project({
        "undefined.py": "def f():\n    return missing_helper(1)\n",
        // Every shape that would make a naive undefined-name check unusable: a star import, a global defined
        // after its use, and a name that exists only for the type checker.
        "fine.py": 'from os.path import *\nimport typing\n\nif typing.TYPE_CHECKING:\n    from foo import Bar\n\ndef f(p, b: "Bar"):\n    return join(p, LATER)\n\nLATER = "x"\n',
    });

    const bad = await check(join(dir, "undefined.py"));
    expect(bad.kind === "checked" ? bad.lines : []).toEqual([`${join(dir, "undefined.py")}:2:12: error F821: Undefined name \`missing_helper\``]);

    const good = await check(join(dir, "fine.py"));
    expect(good.kind === "checked" ? good.lines : ["not checked"]).toEqual([]);
});

test.skipIf(!hasPyright)("with no environment, the file's own type errors are reported and its unresolved imports are not", async () => {
    const dir = await project({
        // `httpx` is not installed anywhere near this file; `.upper()` on an int is wrong whatever is installed.
        "typed.py": "import httpx\n\ndef f() -> str:\n    return (1).upper()\n",
    });
    const answer = await check(join(dir, "typed.py"));

    expect(answer.kind).toBe("checked");
    const lines = answer.kind === "checked" ? answer.lines.join("\n") : "";
    expect(lines).toContain("error report");
    expect(lines).not.toContain("httpx");
    // The claim is narrower than a clean report looks, and the answer says so rather than leaving it inferred.
    expect(answer.kind === "checked" ? answer.note : undefined).toContain("no `.venv` was found");
}, 60_000);
