import { expect, test } from "vitest";
import {
    HEALTH,
    LOCAL_SANDBOX_MEMORY,
    LOCAL_SANDBOX_MEMORY_SWAP,
    localDaemonPort,
    localDaemonUrl,
    localDaemonUrlInsecure,
    localSandboxMemory,
    OPTIONAL_DIRECTIVES,
    ORIGIN_HOST,
    parseNulEnv,
    replayableEnv,
    runtimeDirectivesOf,
    sandboxNames,
    sandboxRunArgv,
    sandboxRunCommand,
} from "./index.js";

const names = sandboxNames("abc-123");

test("every per-sandbox object derives from the slug the way connect.sh always derived it", () => {
    expect(names).toEqual({
        container: "intentic-sandbox-abc-123",
        tunnelContainer: "intentic-sandbox-tunnel-abc-123",
        workspaceVolume: "intentic-workspace-abc-123",
        historyVolume: "intentic-history-abc-123",
        dockerVolume: "intentic-docker-abc-123",
        network: "intentic-workspace-abc-123",
    });
});

test("the local shape carries the full posture: init, alias, all three volumes, the capability grant", () => {
    const argv = sandboxRunArgv({ names, image: "img:1", baseImage: "img:1" });
    // prettier-ignore
    expect(argv).toEqual([
        "run", "-d", "--init", "--restart", "unless-stopped", "--name", "intentic-sandbox-abc-123",
        "--network", "intentic-workspace-abc-123", "--network-alias", ORIGIN_HOST,
        "--add-host", "host.docker.internal:host-gateway",
        "--log-opt", "max-size=10m", "--log-opt", "max-file=3",
        "--memory", "7g", "--memory-swap", "9g",
        "--cap-add=SYS_ADMIN", "--cap-add=SYS_PTRACE",
        "-v", "intentic-workspace-abc-123:/work", "-v", "intentic-history-abc-123:/history", "-v", "intentic-docker-abc-123:/var/lib/docker",
        "-e", "SANDBOX_NAME=intentic-sandbox-abc-123", "-e", "SANDBOX_IMAGE=img:1", "-e", "SANDBOX_BASE_IMAGE=img:1",
        "img:1",
    ]);
});

test("a measured caller's cap reaches the argv; an unmeasured one falls back to the constants", () => {
    const measured = sandboxRunArgv({ names, image: "img:1", baseImage: "img:1", memory: "22g", memorySwap: "26g" });
    expect(measured.join(" ")).toContain("--memory 22g --memory-swap 26g");
    const unmeasured = sandboxRunArgv({ names, image: "img:1", baseImage: "img:1" });
    expect(unmeasured.join(" ")).toContain(`--memory ${LOCAL_SANDBOX_MEMORY} --memory-swap ${LOCAL_SANDBOX_MEMORY_SWAP}`);
});

/* The cap is a SHARE of the machine, so the property that matters is that two sandboxes fit and the desktop
 * still has room. Checked as arithmetic on real machine sizes rather than as remembered numbers. */
test("the per-machine cap leaves room for a second sandbox on every machine size", () => {
    const GIB = 1024 ** 3;
    for (const totalGib of [8, 16, 20, 32, 64, 128]) {
        const { memory, memorySwap } = localSandboxMemory(totalGib * GIB);
        const memGib = Number(memory.replace("g", ""));
        const swapTotalGib = Number(memorySwap.replace("g", ""));
        // --memory-swap is docker's memory+swap TOTAL, so it must exceed the cap or docker refuses the run.
        expect(swapTotalGib).toBeGreaterThan(memGib);
        // Never so small the image's own toolchain cannot work, never so large one box owns the whole machine.
        expect(memGib).toBeGreaterThanOrEqual(4);
        expect(memGib).toBeLessThanOrEqual(24);
        // Two concurrent sandboxes still leave the host something on any machine big enough to run two.
        if (totalGib >= 16) expect(memGib * 2).toBeLessThan(totalGib);
    }
});

/* The machine that prompted all of this, from its own /proc/meminfo rather than the round number its
 * .wslconfig asks for: `memory=20GB` yields a guest that reports 20479632 kB, i.e. 19.53 GiB, because the
 * kernel's own reservations come off the top. Pinned with the real figure precisely because the round one
 * derives a different cap (7g), and the value that ships is the one the probe container actually measures. */
test("the WSL guest that prompted the cap: measured, not the round number its config asks for", () => {
    expect(localSandboxMemory(20479632 * 1024)).toEqual({ memory: "6g", memorySwap: "8g" });
    // Two sandboxes at that cap still leave the desktop, docker and the sync agent the larger half.
    expect(6 * 2).toBeLessThan(19.53);
});

test("an unmeasurable machine gets the fallback, never a cap derived from zero", () => {
    for (const bad of [0, -1, Number.NaN, Number.POSITIVE_INFINITY]) {
        expect(localSandboxMemory(bad)).toEqual({ memory: LOCAL_SANDBOX_MEMORY, memorySwap: LOCAL_SANDBOX_MEMORY_SWAP });
    }
});

/* THE ESCAPE HATCH, for the machine the share is wrong about: one sandbox, many agent sessions inside it.
 * Pinned on the same guest as the test above, whose derived 6g is exactly the cap that is too small for it —
 * a `turbo` fan-out plus a handful of open agents does not fit, and the owner widens it by hand every rebuild. */
test("an explicit SANDBOX_MEMORY replaces the derived share and takes the same swap rule", () => {
    const guest = 20479632 * 1024;
    expect(localSandboxMemory(guest)).toEqual({ memory: "6g", memorySwap: "8g" });
    expect(localSandboxMemory(guest, "10g")).toEqual({ memory: "10g", memorySwap: "13g" });
    // Asking for LESS is an ask too: the override replaces the share, it does not raise a floor under it.
    expect(localSandboxMemory(guest, "5g")).toEqual({ memory: "5g", memorySwap: "7g" });
});

/* An override that could claim anything would just be the uncapped container the cap exists to prevent, so the
 * ask is held between the same floor and ceiling the derived share is, plus its own share of the machine. */
test("an override is bounded: it may claim more of the machine than the share, never all of it", () => {
    const guest = 20479632 * 1024;
    // 60% of 19.53 GiB is ~11.7, so a greedy ask lands there rather than on the number it asked for.
    expect(localSandboxMemory(guest, "18g").memory).toBe("11g");
    // Never above the absolute ceiling, however large the machine.
    expect(localSandboxMemory(256 * 1024 ** 3, "200g").memory).toBe("24g");
    // And the floor holds from below: an override cannot starve the image's own toolchain.
    expect(localSandboxMemory(guest, "1g").memory).toBe("4g");
    // The 72% that caused the incident is not reachable by asking for it.
    expect(Number(localSandboxMemory(guest, "14g").memory.replace("g", "")) / 19.53).toBeLessThan(0.62);
});

test("an override is honoured on a machine the caller could not measure", () => {
    expect(localSandboxMemory(0, "12g")).toEqual({ memory: "12g", memorySwap: "15g" });
});

test("a malformed SANDBOX_MEMORY stops the recreate by name rather than reverting to the share", () => {
    for (const bad of ["10", "10G", "10gb", "ten", "10.5g", "-4g", "10 g"]) {
        expect(() => localSandboxMemory(20479632 * 1024, bad), bad).toThrowError(/SANDBOX_MEMORY/u);
    }
    // Empty is ABSENT, not malformed: replayableEnv drops empty values, and an unset cap is the derived share.
    expect(localSandboxMemory(20479632 * 1024, "")).toEqual({ memory: "6g", memorySwap: "8g" });
});

/* The cap must OUTLIVE the container it sizes, which is the whole reason it is an env var and not a flag:
 * `docker update --memory` retunes a running container and is discarded by the next recreate. Replayed, the
 * number rides onto the new container and the recreate after that reads it back. */
test("SANDBOX_MEMORY survives the replay allowlist and is re-emitted onto the container it sizes", () => {
    expect(replayableEnv([["SANDBOX_MEMORY", "10g"]])).toEqual([["SANDBOX_MEMORY", "10g"]]);
    const argv = sandboxRunArgv({
        names,
        image: "img:1",
        baseImage: "img:1",
        memory: "10g",
        memorySwap: "13g",
        env: [["SANDBOX_MEMORY", "10g"]],
    });
    expect(argv.join(" ")).toContain("--memory 10g --memory-swap 13g");
    expect(argv.join(" ")).toContain("-e SANDBOX_MEMORY=10g");
});

test("the hosted-provider shape drops init/alias and adds ports, labels, dns: same posture, same volumes", () => {
    const argv = sandboxRunArgv({
        names,
        image: "img:2",
        baseImage: "img:2",
        init: false,
        alias: false,
        ports: ["10.0.0.2:5173:5173"],
        labels: ["intentic.type=workspace"],
        dns: ["1.1.1.1"],
    });
    expect(argv).not.toContain("--init");
    expect(argv).not.toContain("--network-alias");
    expect(argv).not.toContain("--memory");
    expect(argv).not.toContain("--memory-swap");
    // /history rides every shape: the hosted flavor once skipped it, and each update wiped the fleet,
    // the transcripts and every repo's real git dir while "your files are kept" stayed technically true.
    expect(argv.join(" ")).toContain("intentic-history-abc-123:/history");
    expect(argv.join(" ")).toContain("--label intentic.type=workspace");
    expect(argv.join(" ")).toContain("--dns 1.1.1.1");
    expect(argv.join(" ")).toContain("-p 10.0.0.2:5173:5173");
    expect(argv).toContain("--cap-add=SYS_ADMIN");
});

test("environment hash, runtime directives, extra mounts and replayed env ride in their fixed places", () => {
    const command = sandboxRunCommand({
        names,
        image: "env:tag",
        baseImage: "base:tag",
        environmentHash: "deadbeef",
        env: [["OWNER_EMAIL", "a@b.c"]],
        runtime: ["--privileged"],
        mounts: ["shared-auth:/agent-auth"],
    });
    expect(command).toContain("-e SANDBOX_ENVIRONMENT_HASH=deadbeef");
    expect(command).toContain("--privileged");
    expect(command).toContain("-v shared-auth:/agent-auth");
    expect(command).toContain("-e OWNER_EMAIL=a@b.c");
    // The image being launched closes the command.
    expect(command.endsWith("env:tag")).toBe(true);
});

test("the emitted command survives the values that broke line-based plumbing: a multi-line key", () => {
    // shellQuote's own cases live in quote.test.ts; this is about the emitter passing every argv word through it.
    const key = "-----BEGIN OPENSSH PRIVATE KEY-----\nabc\n-----END OPENSSH PRIVATE KEY-----";
    const command = sandboxRunCommand({ names, image: "i", baseImage: "i", env: [["HOST_SSH_KEY", key]] });
    expect(command).toContain(`'HOST_SSH_KEY=${key}'`);
});

test("parseNulEnv keeps multi-line values whole and values containing '='", () => {
    expect(parseNulEnv("A=1\0HOST_SSH_KEY=l1\nl2\0B=x=y\0")).toEqual([
        ["A", "1"],
        ["HOST_SSH_KEY", "l1\nl2"],
        ["B", "x=y"],
    ]);
});

test("replayableEnv allowlists, drops empties, and orders canonically: image identity is never replayed", () => {
    const replayed = replayableEnv([
        ["SANDBOX_IMAGE", "old:tag"],
        ["PATH", "/usr/bin"],
        ["OWNER_EMAIL", "a@b.c"],
        ["CONNECT_TOKEN", ""],
        ["AGENT_AUTH_DIR", "/agent-auth"],
    ]);
    expect(replayed).toEqual([
        ["AGENT_AUTH_DIR", "/agent-auth"],
        ["OWNER_EMAIL", "a@b.c"],
    ]);
});

test("runtime directives: allowlisted tokens pass, anything else stops the recreate by name", () => {
    const overlay = ["FROM base", "# intentic:runtime --device=/dev/net/tun --cap-add=NET_ADMIN", "RUN true"].join("\n");
    expect(runtimeDirectivesOf(overlay)).toEqual(["--device=/dev/net/tun", "--cap-add=NET_ADMIN"]);
    expect(() => runtimeDirectivesOf("# intentic:runtime --cap-add=SYS_PTRACE")).toThrowError(/--cap-add=SYS_PTRACE/);
    expect(runtimeDirectivesOf("FROM base\nRUN true")).toEqual([]);
});

/* Every optional directive must be allowlisted, or the preflight would clear an ask the run then refuses. The
 * `=` spelling is load-bearing rather than style: directive lines split on whitespace, so `--gpus all` would
 * arrive as two tokens and the allowlist would have to accept a bare `all`: next to every flag on it. */
test("every optional directive is allowlisted, and only in its single-token spelling", () => {
    for (const entry of OPTIONAL_DIRECTIVES) {
        expect(runtimeDirectivesOf(`# intentic:runtime ${entry.token}`)).toEqual([entry.token]);
        expect(entry.token).not.toContain(" ");
    }
    expect(() => runtimeDirectivesOf("# intentic:runtime --gpus all")).toThrowError(/--gpus/);
});

/* The trade the whole table exists for: a host's refusal costs the EXTRA, not the sandbox. The flag comes off,
 * the container still starts, and the env stamp carries the reason inward: without which the daemon cannot
 * tell "not rebuilt yet" from "this machine cannot", the same absent hardware from inside, and would offer a
 * rebuild that can never work. Driven off the table so a second row is covered the day it is added. */
test("a host that cannot honour an optional directive loses the flag, not the sandbox", () => {
    for (const entry of OPTIONAL_DIRECTIVES) {
        const supported = sandboxRunArgv({ names, image: "i", baseImage: "i", runtime: [entry.token] });
        expect(supported).toContain(entry.token);
        expect(supported.join(" ")).toContain(`${entry.env}=all`);

        const dropped = sandboxRunArgv({ names, image: "i", baseImage: "i", runtime: ["--privileged", entry.token], unsupported: [entry.token] });
        expect(dropped).not.toContain(entry.token);
        // The rest of the posture is untouched: only the optional directive comes off.
        expect(dropped).toContain("--privileged");
        expect(dropped.join(" ")).toContain(`${entry.env}=unsupported`);

        // Nothing asked ⇒ nothing stamped: a sandbox that never wanted the extra must not read as one denied it.
        expect(sandboxRunArgv({ names, image: "i", baseImage: "i", unsupported: [entry.token] }).join(" ")).not.toContain(entry.env);
    }
});

// A directive NOT in the table is all-or-nothing: naming it unsupported must not quietly strip a privilege
// the capability that asked for it cannot work without. Those failures belong at the launch, loudly.
test("only table directives can be dropped; the rest ride whatever the caller claims", () => {
    const argv = sandboxRunArgv({ names, image: "i", baseImage: "i", runtime: ["--privileged"], unsupported: ["--privileged"] });
    expect(argv).toContain("--privileged");
});

// Replaying a stamp from the old container would pin a sandbox to the answer its FIRST host gave: a machine
// that grows a GPU (or moves to one) could never report otherwise.
test("the optional-directive stamps are runner-set, never replayed", () => {
    for (const entry of OPTIONAL_DIRECTIVES) {
        expect(replayableEnv([[entry.env, "all"]]).map(([name]) => name)).not.toContain(entry.env);
    }
});

test("the health gate is one definition: daemon port, bounded patience", () => {
    expect(HEALTH.url).toBe("http://localhost:8787/health");
    expect(HEALTH.attempts * HEALTH.intervalSeconds).toBe(30);
});

test("the loopback port is derived from the id alone: the browser computes the same one without being told", () => {
    // Stable across calls (a recreate must land on the port the browser is already probing) and inside the
    // quiet band: above what dev servers claim, below Linux's ephemeral floor.
    expect(localDaemonPort("0f310c3c4db4")).toBe(localDaemonPort("0f310c3c4db4"));
    // HTTPS on a public name that resolves to loopback: the only shape Safari will accept. Same port either
    // way: one published mapping, and what the daemon serves on it decides which of the two answers.
    expect(localDaemonUrl("0f310c3c4db4", "intentic.dev")).toBe(`https://local-0f310c3c4db4.intentic.dev:${localDaemonPort("0f310c3c4db4")}`);
    expect(localDaemonUrlInsecure("0f310c3c4db4")).toBe(`http://127.0.0.1:${localDaemonPort("0f310c3c4db4")}`);
    // No zone ⇒ no name a CA could certify ⇒ no https candidate to offer.
    expect(localDaemonUrl("0f310c3c4db4", undefined)).toBeUndefined();
    for (const id of ["0f310c3c4db4", "abc123def456", "000000000000", "ffffffffffff"]) {
        expect(localDaemonPort(id)).toBeGreaterThanOrEqual(28000);
        expect(localDaemonPort(id)).toBeLessThan(32000);
    }
    // Two sandboxes on one machine must not race for one port.
    expect(localDaemonPort("000000000000")).not.toBe(localDaemonPort("000001000000"));
});

test("a sandbox with an id publishes the loopback shortcut on 127.0.0.1: never on every interface", () => {
    const argv = sandboxRunArgv({ names, image: "img:1", baseImage: "img:1", sandboxId: "0f310c3c4db4" });
    // The LOOPBACK listener (8788), not the tunnel origin (8787): the connector dials 8787 in plain HTTP over
    // the container network, so that port can never carry the TLS the browser needs.
    expect(argv.join(" ")).toContain(`-p 127.0.0.1:${localDaemonPort("0f310c3c4db4")}:8788`);
    expect(argv.join(" ")).not.toContain(`:8787`);
});

test("the publish is the one part of the run that may be dropped: no id, or a port docker already refused", () => {
    // A bare dev run has no connect token, so no id, so nothing to publish.
    expect(sandboxRunArgv({ names, image: "i", baseImage: "i" }).join(" ")).not.toContain("-p ");
    // The retry every flow makes when docker answered "port is already allocated": same sandbox, no shortcut.
    const retry = sandboxRunArgv({ names, image: "i", baseImage: "i", sandboxId: "0f310c3c4db4", localPublish: false });
    expect(retry.join(" ")).not.toContain("-p ");
    // Hosted-provider ports are unaffected by the retry: they are the sandbox's real ingress, not a shortcut.
    const hosted = sandboxRunArgv({
        names,
        image: "i",
        baseImage: "i",
        ports: ["10.0.0.2:5173:5173"],
        sandboxId: "abc123def456",
        localPublish: false,
    });
    expect(hosted.join(" ")).toContain("-p 10.0.0.2:5173:5173");
});

/* The channel and the rollback target: both runner-set per run, both deliberately outside the replay
 * allowlist. That last part is what this test is really pinning: replaying them from the OLD container would
 * make the channel unchangeable and freeze the rollback target at whatever it was when the sandbox was first
 * created, which is the opposite of what either is for. */
test("channel and previousImage ride as container env, and only when the runner set them", () => {
    const bare = sandboxRunArgv({ names, image: "img:1", baseImage: "img:1" });
    expect(bare.join(" ")).not.toContain("SANDBOX_CHANNEL");
    expect(bare.join(" ")).not.toContain("SANDBOX_PREVIOUS_IMAGE");

    const swapped = sandboxRunArgv({
        names,
        image: "img:2",
        baseImage: "img:2",
        channel: "stable",
        previousImage: "registry.example/sandbox:1.4.2",
    });
    expect(swapped.join(" ")).toContain("SANDBOX_CHANNEL=stable");
    expect(swapped.join(" ")).toContain("SANDBOX_PREVIOUS_IMAGE=registry.example/sandbox:1.4.2");
});

// Replaying an old container's env must not carry either one back in: the runner decides both per run.
test("neither name survives the replay allowlist", () => {
    const replayed = replayableEnv([
        ["SANDBOX_CHANNEL", "canary"],
        ["SANDBOX_PREVIOUS_IMAGE", "registry.example/sandbox:1.0.0"],
        ["CONNECT_TOKEN", "t"],
    ]);
    expect(replayed.map(([name]) => name)).not.toContain("SANDBOX_CHANNEL");
    expect(replayed.map(([name]) => name)).not.toContain("SANDBOX_PREVIOUS_IMAGE");
});
