import { execFile } from "node:child_process";
import { join } from "node:path";
import { promisify } from "node:util";
import { sandboxIdFromToken } from "@intentic/sandbox-contract/tunnel-ids";
import { localDaemonPort } from "@intentic/sandbox-run";
import { expect, test } from "vitest";

// Proves the protocol a caller sees: NUL-framed env, allowlist here, a directive failure killing the process.

const exec = promisify(execFile);
const packageRoot = join(import.meta.dirname, "..", "..");
const TSX = join(packageRoot, "node_modules", ".bin", "tsx");
const CLI = join(packageRoot, "src", "cli.ts");

// A failed spawn must never look like a legitimate refusal: `code` distinguishes the two, `stderr` carries the reason.
const runProbes = async (args: string[]): Promise<{ stdout: string }> => exec(TSX, [CLI, "sandbox", "host-probes", ...args]);

// `env` is the probe's own environment (how a runner seeds a standing ask), merged over the test runner's so tsx still
// finds node.
const runVerb = async (args: string[], stdin: string, env: Record<string, string> = {}): Promise<{ stdout: string; stderr: string; code: number }> => {
    const child = exec(TSX, [CLI, "sandbox", "run-command", ...args], { env: { ...process.env, ...env } });
    child.child.stdin?.end(stdin);
    try {
        const { stdout, stderr } = await child;
        return { stdout, stderr, code: 0 };
    } catch (error) {
        const failure = error as { code?: number | string; stdout?: string; stderr?: string };
        if (typeof failure.code !== "number") {
            throw error;
        }
        return { stdout: failure.stdout ?? "", stderr: failure.stderr ?? "", code: failure.code };
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
    // Multi-line key rides as one quoted word: the reason the env channel is NUL-framed.
    expect(stdout).toContain("'HOST_SSH_KEY=l1\nl2'");
    // Image identity is never replayed from the replaced container; empty vars are dropped.
    expect(stdout).not.toContain("old:tag");
    expect(stdout).not.toContain("CONNECT_TOKEN");
});

// base64 round-trips through the verb (argv in, container env out) via a decode/encode step, so `definition` stays the
// same TOML text every other caller hands it. A corrupted trip would boot a silently-bare workspace.
test("--definition-b64 rides through to SANDBOX_DEFINITION_SEED on the emitted command", async () => {
    const toml = "schemaVersion = 1\n\n[settings]\nautoLand = false\n";
    const b64 = Buffer.from(toml, "utf8").toString("base64");
    const { stdout } = await runVerb(["--slug", "s9", "--image", "i", "--base-image", "i", "--definition-b64", b64], "");
    expect(stdout).toContain(`-e SANDBOX_DEFINITION_SEED=${b64}`);
    // Absent means absent: no seed must not carry an empty one for the daemon to trip on.
    const bare = await runVerb(["--slug", "s9", "--image", "i", "--base-image", "i"], "");
    expect(bare.stdout).not.toContain("SANDBOX_DEFINITION_SEED");
});

test("--format json prints the argv for PowerShell to splat", async () => {
    const { stdout } = await runVerb(["--slug", "s2", "--image", "i", "--base-image", "i", "--format", "json"], "");
    const argv = JSON.parse(stdout) as string[];
    expect(argv[0]).toBe("run");
    expect(argv).toContain("--cap-add=SYS_ADMIN");
    expect(argv.at(-1)).toBe("i");
});

// The loopback port is derived from CONNECT_TOKEN already on the env channel (same digest that names the tunnel), so no
// flow has to compute an address itself.
test("the loopback publish is derived from the connect token the env channel already carries", async () => {
    const port = localDaemonPort(sandboxIdFromToken("s3cret")!);
    const { stdout } = await runVerb(["--slug", "s4", "--image", "i", "--base-image", "i"], "CONNECT_TOKEN=s3cret\0");
    // Loopback listener (8788), not the tunnel origin (8787), which must stay plain HTTP for the connector.
    expect(stdout).toContain(`-p 127.0.0.1:${port}:8788`);
    // Bound to the id, not the slug: two sandboxes sharing a slug shape still get distinct ports.
    expect(port).not.toBe(localDaemonPort(sandboxIdFromToken("other")!));
});

test("--no-local-publish drops only the shortcut, so a port docker refused can't fail the launch twice", async () => {
    const { stdout } = await runVerb(["--slug", "s5", "--image", "i", "--base-image", "i", "--no-local-publish"], "CONNECT_TOKEN=s3cret\0");
    expect(stdout).not.toContain("-p ");
    // Rest of the run is untouched: same sandbox, minus one optimization.
    expect(stdout).toContain("--cap-add=SYS_ADMIN");
    expect(stdout).toContain("-v intentic-workspace-s5:/work");
});

// Two halves of the preflight protocol: `host-probes` says what to ask the host; `run-command --unsupported` emits the
// run without the flag but with the reason, so the daemon never has to guess why.
test("host-probes names what to ask the host, and only for what the overlay asked", async () => {
    // Independent invocations run concurrently: tsx startup is this file's cost, neither reads the other's result.
    const [asked, allOrNothing] = await Promise.all([
        runProbes(["--runtime", "# intentic:runtime --privileged --gpus=all"]),
        // --privileged is all-or-nothing: a host that refuses it must fail the launch outright, not limp.
        runProbes(["--runtime", "# intentic:runtime --privileged"]),
    ]);

    expect(asked.stdout.trim().split("\n")).toEqual(["--gpus=all\truntime\tnvidia"]);
    expect(allOrNothing.stdout).toBe("");
});

test("--unsupported drops those directives and records why, leaving the rest of the run intact", async () => {
    const args = ["--slug", "s6", "--image", "i", "--base-image", "i", "--runtime", "# intentic:runtime --privileged --gpus=all"];
    // Independent invocations run concurrently (nothing depends on the others); every multi-spawn test follows this.
    const [honoured, unsupported, detached] = await Promise.all([
        runVerb(args, ""),
        // Attached: the value is a docker flag itself; a detached spelling would misparse it as one of ours.
        runVerb([...args, "--unsupported=--gpus=all"], ""),
        // Detached is refused outright, not silently ignored: an empty run command is a hard failure.
        runVerb([...args, "--unsupported", "--gpus=all"], ""),
    ]);

    // Same token appears in the overlay's provenance stamp (SANDBOX_OVERLAY_RUNTIME), recording what was asked.
    expect(honoured.stdout).toMatch(/ --gpus=all /u);
    expect(honoured.stdout).toContain("SANDBOX_GPU=all");

    expect(unsupported.stdout).not.toMatch(/ --gpus=all /u);
    expect(unsupported.stdout).toContain("SANDBOX_GPU=unsupported");
    // The privilege the nested engine needs isn't collateral damage; only the optional one comes off.
    expect(unsupported.stdout).toContain("--privileged");

    expect(detached.stdout).toBe("");
});

test("an unallowlisted runtime directive fails the whole verb: never a command minus a privilege", async () => {
    const { code, stdout, stderr } = await runVerb(
        ["--slug", "s3", "--image", "i", "--base-image", "i", "--runtime", "# intentic:runtime --cap-add=SYS_PTRACE"],
        "",
    );
    expect(code).not.toBe(0);
    expect(stdout).toBe("");
    // Named, so the refusal is the allowlist speaking, not some other crash that exits non-zero.
    expect(stderr).toContain("--cap-add=SYS_PTRACE");
});

// A value on the probe's env replaces what stdin carried; empty clears it; either way it's re-emitted onto the
// container, which is what makes `sandbox reshape` a standing change.
test("a seed on the probe's env replaces or clears what the old container carried, and is re-emitted", async () => {
    const args = ["--slug", "s7", "--image", "i", "--base-image", "i"];
    const carried = "SANDBOX_MEMORY=10g\0SANDBOX_CPUS=2\0SANDBOX_RUNTIME=--privileged\0";
    const [replayed, replaced, cleared] = await Promise.all([
        runVerb(args, carried),
        runVerb(args, carried, { SANDBOX_CPUS: "1", SANDBOX_RUNTIME: "--privileged --gpus=all" }),
        runVerb(args, carried, { SANDBOX_MEMORY: "", SANDBOX_CPUS: "", SANDBOX_RUNTIME: "" }),
    ]);
    // Untouched: what the container carried rides again, as flags and as env.
    expect(replayed.stdout).toContain("--cpus 2");
    expect(replayed.stdout).toContain("-e SANDBOX_CPUS=2");
    expect(replayed.stdout).toContain("--privileged");
    // Replaced: the fresh ask wins once; the new directive is probed like any other.
    expect(replaced.stdout).toContain("--cpus 1");
    expect(replaced.stdout).not.toContain("SANDBOX_CPUS=2");
    expect(replaced.stdout).toContain("-e 'SANDBOX_RUNTIME=--privileged --gpus=all'");
    expect(replaced.stdout).toContain("--gpus=all");
    // Cleared: no CPU ceiling, no owner directives, memory back to the derived default.
    expect(cleared.stdout).not.toContain("--cpus");
    expect(cleared.stdout).not.toContain("--privileged");
    expect(cleared.stdout).not.toContain("SANDBOX_RUNTIME");
    expect(cleared.stdout).not.toContain("SANDBOX_MEMORY=10g");
    expect(cleared.stdout).toMatch(/--memory \d+g/u);
});

test("host-probes asks about the owner's optional directives exactly as the overlay's", async () => {
    // Attached, like --unsupported: the values are docker flags, so a detached spelling would misparse them as ours.
    const [owner, both] = await Promise.all([
        runProbes(["--host-runtime=--privileged --gpus=all"]),
        // One line, not two: the union is deduped before probing.
        runProbes(["--runtime", "# intentic:runtime --gpus=all", "--host-runtime=--gpus=all"]),
    ]);
    expect(owner.stdout.trim().split("\n")).toEqual(["--gpus=all\truntime\tnvidia"]);
    expect(both.stdout.trim().split("\n")).toEqual(["--gpus=all\truntime\tnvidia"]);
});
