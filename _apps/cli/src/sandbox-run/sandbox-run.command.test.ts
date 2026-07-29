import { execFile } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { expect, test } from "vitest";

/* The verb is a thin shell over @intentic/sandbox-run (where the shape itself is unit-tested); what needs
 * proving here is the PROTOCOL a calling script actually experiences: NUL-framed env on stdin surviving a
 * multi-line key, the allowlist applied on this side of the pipe, and a bad directive failing the process
 * rather than printing a command minus a privilege. Driven through the real bin, argv to stdout, like the
 * scripts drive it. */

const exec = promisify(execFile);
const packageRoot = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const TSX = join(packageRoot, "node_modules", ".bin", "tsx");
const CLI = join(packageRoot, "src", "cli.ts");

const runVerb = async (args: string[], stdin: string): Promise<{ stdout: string; code: number }> => {
    const child = exec(TSX, [CLI, "sandbox", "run-command", ...args]);
    child.child.stdin?.end(stdin);
    try {
        return { stdout: (await child).stdout, code: 0 };
    } catch (error) {
        return { stdout: "", code: (error as { code?: number }).code ?? 1 };
    }
};

test("prints the canonical run command: replayed env filtered here, multi-line keys intact", async () => {
    const { stdout } = await runVerb(
        ["--slug", "s1", "--image", "img:new", "--base-image", "img:base", "--mounts", "shared:/agent-auth"],
        "OWNER_EMAIL=a@b.c\0SANDBOX_IMAGE=old:tag\0CONNECT_TOKEN=\0HOST_SSH_KEY=l1\nl2\0",
    );
    expect(stdout).toContain("docker run -d --init");
    expect(stdout).toContain("--cap-add=SYS_ADMIN");
    expect(stdout).toContain("-v shared:/agent-auth");
    expect(stdout).toContain("-e OWNER_EMAIL=a@b.c");
    // The multi-line key rides as ONE quoted word — the whole reason the env channel is NUL-framed.
    expect(stdout).toContain("'HOST_SSH_KEY=l1\nl2'");
    // Image identity is never replayed from the container being replaced, and empty vars are dropped.
    expect(stdout).not.toContain("old:tag");
    expect(stdout).not.toContain("CONNECT_TOKEN");
}, 30_000);

test("--format json prints the argv for PowerShell to splat", async () => {
    const { stdout } = await runVerb(["--slug", "s2", "--image", "i", "--base-image", "i", "--format", "json"], "");
    const argv = JSON.parse(stdout) as string[];
    expect(argv[0]).toBe("run");
    expect(argv).toContain("--cap-add=SYS_ADMIN");
    expect(argv.at(-1)).toBe("i");
}, 30_000);

test("an unallowlisted runtime directive fails the whole verb — never a command minus a privilege", async () => {
    const { code, stdout } = await runVerb(
        ["--slug", "s3", "--image", "i", "--base-image", "i", "--runtime", "# intentic:runtime --cap-add=SYS_PTRACE"],
        "",
    );
    expect(code).not.toBe(0);
    expect(stdout).toBe("");
}, 30_000);
