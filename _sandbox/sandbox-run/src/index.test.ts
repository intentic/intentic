import { expect, test } from "vitest";
import {
    HEALTH,
    hostRuntimeOf,
    LOCAL_SANDBOX_MEMORY,
    localDaemonPort,
    localDaemonUrlInsecure,
    localSandboxCpus,
    localSandboxMemory,
    OPTIONAL_DIRECTIVES,
    ORIGIN_HOST,
    OVERLAY_RUNTIME_ENV,
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
        "--memory", "7g", "--memory-swap", "-1",
        "--cap-add=SYS_ADMIN", "--cap-add=SYS_PTRACE",
        "-v", "intentic-workspace-abc-123:/work", "-v", "intentic-history-abc-123:/history", "-v", "intentic-docker-abc-123:/var/lib/docker",
        "-e", "SANDBOX_NAME=intentic-sandbox-abc-123", "-e", "SANDBOX_IMAGE=img:1", "-e", "SANDBOX_BASE_IMAGE=img:1",
        "img:1",
    ]);
});

test("a definition rides as base64 in SANDBOX_DEFINITION_SEED, so its quotes and newlines never meet a shell", () => {
    const toml = 'schemaVersion = 1\n[[repositories]]\nid = "app"\nremote = "https://example.com/app.git"\n';
    const argv = sandboxRunArgv({ names, image: "img:1", baseImage: "img:1", definition: toml });
    const stamped = argv.find((entry) => entry.startsWith("SANDBOX_DEFINITION_SEED="));
    // The decode below is the assertion, and it already cannot pass on a missing entry: `?? ""` decodes to the
    // empty string, which is not the toml. A presence check in front of it added nothing.
    expect(Buffer.from((stamped ?? "").slice("SANDBOX_DEFINITION_SEED=".length), "base64").toString("utf8")).toBe(toml);
    // And absent means absent: no empty var for the daemon to misread as a seed.
    expect(sandboxRunArgv({ names, image: "img:1", baseImage: "img:1" }).some((entry) => entry.includes("SANDBOX_DEFINITION_SEED"))).toBe(false);
});

test("a measured caller's cap reaches the argv; an unmeasured one falls back to the constant", () => {
    const measured = sandboxRunArgv({ names, image: "img:1", baseImage: "img:1", memory: "22g" });
    expect(measured.join(" ")).toContain("--memory 22g --memory-swap -1");
    const unmeasured = sandboxRunArgv({ names, image: "img:1", baseImage: "img:1" });
    expect(unmeasured.join(" ")).toContain(`--memory ${LOCAL_SANDBOX_MEMORY} --memory-swap -1`);
});

/* THE PROPERTY THAT TURNS A FREEZE INTO A SLOWDOWN, asserted on the argv because it is a docker spelling and
 * not a number: `-1` is "page into whatever swap the engine has". The equal-values spelling this replaced
 * ("no swap at all") promised an instant OOM kill at the ceiling and delivered a reclaim livelock instead —
 * a node-heavy tree is mostly file-backed pages, so the kernel thrashed hot executables for 20 minutes and
 * `oom_kill` stayed 0 (see the doctrine in index.ts). Every shape that carries a cap must carry the
 * allowance, which is why this walks them rather than checking the local default alone. */
test("every capped sandbox may page: --memory-swap is unbounded on every shape that carries a cap", () => {
    const shapes = [
        sandboxRunArgv({ names, image: "img:1", baseImage: "img:1" }),
        sandboxRunArgv({ names, image: "img:1", baseImage: "img:1", memory: "22g" }),
        sandboxRunArgv({ names, image: "img:1", baseImage: "img:1", memory: localSandboxMemory(20479632 * 1024) }),
        sandboxRunArgv({ names, image: "img:1", baseImage: "img:1", memory: localSandboxMemory(0, "10g") }),
    ];
    for (const argv of shapes) {
        expect(argv.indexOf("--memory")).toBeGreaterThan(-1);
        expect(argv[argv.indexOf("--memory-swap") + 1]).toBe("-1");
    }
});

/* The cap is the MACHINE MINUS THE RESERVE, so the property that matters is that the sandbox gets nearly
 * everything while the host's fixed footprint (sync agent, editor tooling, docker, sibling containers) keeps
 * its 3 GiB. Checked as arithmetic on real machine sizes rather than as remembered numbers. */
test("the per-machine cap grants the machine minus the host reserve, floored where the machine is small", () => {
    const GIB = 1024 ** 3;
    for (const totalGib of [8, 16, 20, 32, 64, 128]) {
        const memGib = Number(localSandboxMemory(totalGib * GIB).replace("g", ""));
        // Never so small the image's own toolchain cannot work.
        expect(memGib).toBeGreaterThanOrEqual(4);
        // The host keeps its reserve (rounding-down can leave it slightly more, never less)…
        expect(totalGib - memGib).toBeGreaterThanOrEqual(Math.min(3, totalGib - 4));
        // …and not much more than it: the sandbox is the machine's primary workload, sized like one.
        expect(totalGib - memGib).toBeLessThanOrEqual(4);
    }
});

/* The machine that prompted all of this, from its own /proc/meminfo rather than the round number its
 * .wslconfig asks for: `memory=20GB` yields a guest that reports 20479632 kB, i.e. 19.53 GiB, because the
 * kernel's own reservations come off the top. Pinned with the real figure precisely because the round one
 * derives a different cap (17g), and the value that ships is the one the probe container actually measures. */
test("the WSL guest that prompted the cap: measured, not the round number its config asks for", () => {
    expect(localSandboxMemory(20479632 * 1024)).toBe("16g");
    // What stays outside the cgroup covers what actually runs there: distro + docker + sibling containers.
    expect(19.53 - 16).toBeGreaterThan(3);
});

test("an unmeasurable machine gets the fallback, never a cap derived from zero", () => {
    for (const bad of [0, -1, Number.NaN, Number.POSITIVE_INFINITY]) {
        expect(localSandboxMemory(bad)).toBe(LOCAL_SANDBOX_MEMORY);
    }
});

/* THE ESCAPE HATCH, for the machine the reserve is wrong about: an owner who wants the sandbox SMALLER than
 * the derived cap (other workloads on the machine), or a specific figure they have measured for themselves. */
test("an explicit SANDBOX_MEMORY replaces the derived cap", () => {
    const guest = 20479632 * 1024;
    expect(localSandboxMemory(guest)).toBe("16g");
    expect(localSandboxMemory(guest, "10g")).toBe("10g");
    // Asking for LESS is an ask too: the override replaces the cap, it does not raise a floor under it.
    expect(localSandboxMemory(guest, "5g")).toBe("5g");
});

/* An override that could claim anything would just be the uncapped container the cap exists to prevent, so
 * the ask is held to the same machine-minus-reserve the derived cap answers, and to the same floor. */
test("an override is bounded: it may claim up to the machine minus the reserve, never all of it", () => {
    const guest = 20479632 * 1024;
    // 19.53 GiB minus the 3 GiB reserve floors to 16, so a greedy ask lands there, not on the number it typed.
    expect(localSandboxMemory(guest, "18g")).toBe("16g");
    // A machine with real room honours a big ask: the bound is the machine's, not a universal ceiling.
    expect(localSandboxMemory(256 * 1024 ** 3, "200g")).toBe("200g");
    // And the floor holds from below: an override cannot starve the image's own toolchain.
    expect(localSandboxMemory(guest, "1g")).toBe("4g");
});

test("an override is honoured on a machine the caller could not measure", () => {
    expect(localSandboxMemory(0, "12g")).toBe("12g");
});

test("a malformed SANDBOX_MEMORY stops the recreate by name rather than reverting to the share", () => {
    for (const bad of ["10", "10G", "10gb", "ten", "10.5g", "-4g", "10 g"]) {
        expect(() => localSandboxMemory(20479632 * 1024, bad), bad).toThrowError(/SANDBOX_MEMORY/u);
    }
    // Empty is ABSENT, not malformed: replayableEnv drops empty values, and an unset cap is the derived cap.
    expect(localSandboxMemory(20479632 * 1024, "")).toBe("16g");
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
        env: [["SANDBOX_MEMORY", "10g"]],
    });
    expect(argv.join(" ")).toContain("--memory 10g --memory-swap -1");
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
    // The plain form needs no name and so lives here. Its certified sibling is composed where it is dialled
    // (the editor's endpoint.ts), off this same port: one published mapping, and what the daemon serves on it
    // decides which of the two answers.
    expect(localDaemonUrlInsecure("0f310c3c4db4")).toBe(`http://127.0.0.1:${localDaemonPort("0f310c3c4db4")}`);
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

/* --- The owner's other two standing asks: a CPU ceiling and their own runtime directives --------------------
 *
 * Both arrive the way the memory cap does (an env var on the container, replayed) and both are bounded and
 * validated HERE, because ic forwards and never interprets. What differs is the default: memory has a derived
 * cap, CPUs have none, so "nothing asked" must produce no flag at all — a sandbox has always had every core. */
test("no CPU ask means no --cpus flag: every core, as a sandbox has always run", () => {
    expect(localSandboxCpus(8)).toBeUndefined();
    expect(localSandboxCpus(8, "")).toBeUndefined();
    expect(sandboxRunArgv({ names, image: "i", baseImage: "i" })).not.toContain("--cpus");
});

test("a CPU ask is whole cores, held between one and the engine's own count", () => {
    expect(localSandboxCpus(8, "4")).toBe("4");
    // A cap the engine cannot honour is docker's "invalid range" at launch: a whole recreate lost to a typo.
    expect(localSandboxCpus(8, "16")).toBe("8");
    // Unmeasured: honoured as typed, the same rule as the memory override.
    expect(localSandboxCpus(0, "16")).toBe("16");
    for (const bad of ["0", "0.5", "2.5", "four", "-2", "4 "]) {
        if (bad === "4 ") {
            // Surrounding whitespace is a shell accident, not a different number.
            expect(localSandboxCpus(8, bad)).toBe("4");
            continue;
        }
        expect(() => localSandboxCpus(8, bad), bad).toThrowError(/SANDBOX_CPUS/u);
    }
});

test("--cpus rides after the memory cap on the local shape and never on the hosted one", () => {
    const local = sandboxRunArgv({ names, image: "i", baseImage: "i", memory: "10g", cpus: "4" });
    expect(local.join(" ")).toContain("--memory 10g --memory-swap -1 --cpus 4");
    const hosted = sandboxRunArgv({ names, image: "i", baseImage: "i", init: false, cpus: "4" });
    expect(hosted).not.toContain("--cpus");
});

test("SANDBOX_CPUS and SANDBOX_RUNTIME survive the replay allowlist: said once, on the sandbox itself", () => {
    expect(
        replayableEnv([
            ["SANDBOX_CPUS", "4"],
            ["SANDBOX_RUNTIME", "--privileged"],
        ]),
    ).toEqual([
        ["SANDBOX_CPUS", "4"],
        ["SANDBOX_RUNTIME", "--privileged"],
    ]);
});

test("the owner's directives are held to the same allowlist as the overlay's, and named by their own var", () => {
    expect(hostRuntimeOf("--privileged --gpus=all")).toEqual(["--privileged", "--gpus=all"]);
    expect(hostRuntimeOf(undefined)).toEqual([]);
    expect(hostRuntimeOf("  ")).toEqual([]);
    expect(hostRuntimeOf("--privileged --privileged")).toEqual(["--privileged"]);
    expect(() => hostRuntimeOf("--cap-add=SYS_PTRACE")).toThrowError(/SYS_PTRACE.*SANDBOX_RUNTIME/u);
    expect(() => hostRuntimeOf("--gpus all")).toThrowError(/SANDBOX_RUNTIME/u);
});

/* THE UNION, which is the whole relationship between the two sources: the owner adds to what the overlay
 * demands, and withdrawing their own ask never withdraws the overlay's. Deduped, because docker accepts
 * `--privileged` twice but not every repeated flag. */
test("the run carries the union of the overlay's directives and the owner's, once each", () => {
    const argv = sandboxRunArgv({ names, image: "i", baseImage: "i", runtime: ["--privileged"], hostRuntime: ["--privileged", "--gpus=all"] });
    expect(argv.filter((arg) => arg === "--privileged")).toHaveLength(1);
    expect(argv).toContain("--gpus=all");
    // The overlay's demand stands with the owner asking for nothing.
    expect(sandboxRunArgv({ names, image: "i", baseImage: "i", runtime: ["--privileged"], hostRuntime: [] })).toContain("--privileged");
});

/* A GPU the OWNER asked for is optional in exactly the way the docker card's is: probed, dropped on a host
 * without the runtime, and its fate stamped — or the daemon inside would offer a rebuild that can never work. */
test("an owner-asked optional directive is dropped and stamped exactly as an overlay-asked one", () => {
    const dropped = sandboxRunArgv({ names, image: "i", baseImage: "i", hostRuntime: ["--gpus=all"], unsupported: ["--gpus=all"] });
    expect(dropped).not.toContain("--gpus=all");
    expect(dropped.join(" ")).toContain("SANDBOX_GPU=unsupported");
    const honoured = sandboxRunArgv({ names, image: "i", baseImage: "i", hostRuntime: ["--gpus=all"] });
    expect(honoured).toContain("--gpus=all");
    expect(honoured.join(" ")).toContain("SANDBOX_GPU=all");
});

/* WHOSE PRIVILEGE IT IS. From outside, `docker inspect` shows a privileged container and cannot say whether the
 * docker capability demanded it (a view must draw that locked) or the owner asked (theirs to withdraw). The
 * overlay's half is stamped on its own so a reader can tell; runner-set, so it is never replayed. */
test("the overlay's directives are stamped as provenance, alone, and never replayed", () => {
    const both = sandboxRunArgv({ names, image: "i", baseImage: "i", runtime: ["--privileged"], hostRuntime: ["--gpus=all"] });
    expect(both.join(" ")).toContain(`${OVERLAY_RUNTIME_ENV}=--privileged`);
    expect(both.join(" ")).not.toContain(`${OVERLAY_RUNTIME_ENV}=--privileged --gpus`);
    // Nothing from the overlay ⇒ no stamp: an owner-only privilege must not read as a capability's.
    expect(sandboxRunArgv({ names, image: "i", baseImage: "i", hostRuntime: ["--privileged"] }).join(" ")).not.toContain(OVERLAY_RUNTIME_ENV);
    expect(replayableEnv([[OVERLAY_RUNTIME_ENV, "--privileged"]])).toEqual([]);
});
