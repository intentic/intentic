import { execFile } from "node:child_process";
import { join } from "node:path";
import { promisify } from "node:util";
import { sandboxIdFromToken } from "@intentic/sandbox-contract/tunnel-ids";
import { localDaemonPort } from "@intentic/sandbox-run";
import { expect, test } from "vitest";

/* The verb is a thin shell over @intentic/sandbox-run (where the shape itself is unit-tested); what needs
 * proving here is the PROTOCOL a calling script actually experiences: NUL-framed env on stdin surviving a
 * multi-line key, the allowlist applied on this side of the pipe, and a bad directive failing the process
 * rather than printing a command minus a privilege. Driven through the real bin, argv to stdout, like the
 * scripts drive it. */

const exec = promisify(execFile);
const packageRoot = join(import.meta.dirname, "..", "..");
const TSX = join(packageRoot, "node_modules", ".bin", "tsx");
const CLI = join(packageRoot, "src", "cli.ts");

/* A failed spawn must never look like a verb that legitimately refused: `code` distinguishes the two and
 * `stderr` carries the reason, so an ENOENT or an unbuilt dependency reads as itself instead of as an empty
 * stdout the assertions then misattribute. */
const runProbes = async (args: string[]): Promise<{ stdout: string }> => exec(TSX, [CLI, "sandbox", "host-probes", ...args]);

const runVerb = async (args: string[], stdin: string): Promise<{ stdout: string; stderr: string; code: number }> => {
    const child = exec(TSX, [CLI, "sandbox", "run-command", ...args]);
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
    // The multi-line key rides as ONE quoted word: the whole reason the env channel is NUL-framed.
    expect(stdout).toContain("'HOST_SSH_KEY=l1\nl2'");
    // Image identity is never replayed from the container being replaced, and empty vars are dropped.
    expect(stdout).not.toContain("old:tag");
    expect(stdout).not.toContain("CONNECT_TOKEN");
});

/* The seed's round trip through the verb: base64 in on the argv (how `ic runner up` carries a definition
 * file's content), base64 out on the emitted container env — with a decode/encode in between, so the
 * contract's `definition` field stays the TOML text every OTHER caller hands it. A corrupted trip here is a
 * runner that boots, serves, and silently opens as a bare workspace. */
test("--definition-b64 rides through to SANDBOX_DEFINITION_SEED on the emitted command", async () => {
    const toml = "schemaVersion = 1\n\n[settings]\nautoLand = false\n";
    const b64 = Buffer.from(toml, "utf8").toString("base64");
    const { stdout } = await runVerb(["--slug", "s9", "--image", "i", "--base-image", "i", "--definition-b64", b64], "");
    expect(stdout).toContain(`-e SANDBOX_DEFINITION_SEED=${b64}`);
    // Absent means absent: a sandbox with no seed must not carry an empty one for the daemon to trip on.
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

/* The loopback shortcut is derived, never passed: the verb already receives CONNECT_TOKEN on the env channel,
 * so the port a browser will probe falls out of the same digest that names the tunnel. Proving it end-to-end
 * here (rather than only in the shape unit test) is what stops a flow from having to compute an address. */
test("the loopback publish is derived from the connect token the env channel already carries", async () => {
    const port = localDaemonPort(sandboxIdFromToken("s3cret")!);
    const { stdout } = await runVerb(["--slug", "s4", "--image", "i", "--base-image", "i"], "CONNECT_TOKEN=s3cret\0");
    // The loopback listener (8788), never the tunnel origin (8787): that one must stay plain HTTP for the
    // connector, while this one carries the TLS the browser needs.
    expect(stdout).toContain(`-p 127.0.0.1:${port}:8788`);
    // Bound to the id, not the slug: two sandboxes sharing a slug shape still get their own port.
    expect(port).not.toBe(localDaemonPort(sandboxIdFromToken("other")!));
});

test("--no-local-publish drops only the shortcut, so a port docker refused can't fail the launch twice", async () => {
    const { stdout } = await runVerb(["--slug", "s5", "--image", "i", "--base-image", "i", "--no-local-publish"], "CONNECT_TOKEN=s3cret\0");
    expect(stdout).not.toContain("-p ");
    // Everything else about the run is untouched: the retry is the same sandbox, minus one optimization.
    expect(stdout).toContain("--cap-add=SYS_ADMIN");
    expect(stdout).toContain("-v intentic-workspace-s5:/work");
});

/* The two halves of the preflight protocol, end to end through the real bin: this is how a creation flow
 * negotiates an optional directive without knowing any token's name:
 *   1. `host-probes` says WHAT to ask this host (the table, shipped as data).
 *   2. `run-command --unsupported` takes the answer and emits a run without the flag but WITH the reason.
 * Anything less and the daemon inside would have to guess whether missing hardware means "not rebuilt yet" or
 * "this machine cannot", which are opposite instructions to give a person. */
test("host-probes names what to ask the host, and only for what the overlay asked", async () => {
    // Two independent invocations, so they go out together: the same reason the test below takes its three that
    // way. A tsx start is the only real cost this file has, and on a loaded runner one has been measured at 20s
    // against a local 0.4s; a test that spends two in sequence pays that twice for nothing, because neither call
    // reads what the other returned.
    const [asked, allOrNothing] = await Promise.all([
        runProbes(["--runtime", "# intentic:runtime --privileged --gpus=all"]),
        // --privileged is all-or-nothing: there is nothing to ask, because a host that refuses it has broken the
        // capability and the launch should fail rather than limp.
        runProbes(["--runtime", "# intentic:runtime --privileged"]),
    ]);

    expect(asked.stdout.trim().split("\n")).toEqual(["--gpus=all\truntime\tnvidia"]);
    expect(allOrNothing.stdout).toBe("");
});

test("--unsupported drops those directives and records why, leaving the rest of the run intact", async () => {
    const args = ["--slug", "s6", "--image", "i", "--base-image", "i", "--runtime", "# intentic:runtime --privileged --gpus=all"];
    // Three independent invocations, so they go out together. Nothing here depends on the one before it, and a
    // tsx start is the only real cost this file has: taken in sequence this test pays it three times over, which
    // is how it used to exhaust a budget its one-spawn siblings passed inside. Every multi-spawn test here goes
    // out this way.
    const [honoured, unsupported, detached] = await Promise.all([
        runVerb(args, ""),
        // ATTACHED, and this test is the reason the flows write it that way: the values are themselves docker
        // flags, so the detached spelling makes the parser read `--gpus=all` as a flag of ours that doesn't exist.
        runVerb([...args, "--unsupported=--gpus=all"], ""),
        // Detached, it is refused outright rather than silently ignored: a flow that regresses to it prints
        // nothing, and every caller here treats an empty run command as a hard failure.
        runVerb([...args, "--unsupported", "--gpus=all"], ""),
    ]);

    expect(honoured.stdout).toContain("--gpus=all");
    expect(honoured.stdout).toContain("SANDBOX_GPU=all");

    expect(unsupported.stdout).not.toContain("--gpus");
    expect(unsupported.stdout).toContain("SANDBOX_GPU=unsupported");
    // The privilege the nested engine actually needs is not collateral damage: only the optional one comes off.
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
    // Named, so the refusal is the allowlist speaking, not any other crash that happens to exit non-zero.
    expect(stderr).toContain("--cap-add=SYS_PTRACE");
});
