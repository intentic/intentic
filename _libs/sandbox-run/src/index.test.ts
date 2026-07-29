import { expect, test } from "vitest";
import {
    HEALTH,
    ORIGIN_HOST,
    parseNulEnv,
    replayableEnv,
    runtimeDirectivesOf,
    sandboxNames,
    sandboxRunArgv,
    sandboxRunCommand,
    shellQuote,
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
        "--cap-add=SYS_ADMIN",
        "-v", "intentic-workspace-abc-123:/work", "-v", "intentic-history-abc-123:/history", "-v", "intentic-docker-abc-123:/var/lib/docker",
        "-e", "SANDBOX_NAME=intentic-sandbox-abc-123", "-e", "SANDBOX_IMAGE=img:1", "-e", "SANDBOX_BASE_IMAGE=img:1",
        "img:1",
    ]);
});

test("the hosted-provider shape drops init/alias/history and adds ports, labels, dns — same posture", () => {
    const argv = sandboxRunArgv({
        names,
        image: "img:2",
        baseImage: "img:2",
        init: false,
        alias: false,
        history: false,
        ports: ["10.0.0.2:5173:5173"],
        labels: ["intentic.type=workspace"],
        dns: ["1.1.1.1"],
    });
    expect(argv).not.toContain("--init");
    expect(argv).not.toContain("--network-alias");
    expect(argv.join(" ")).not.toContain(":/history");
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

test("quoting survives the values that broke line-based plumbing: quotes and multi-line keys", () => {
    // A plain word stays bare — the emitted command reads exactly like the hand-written scripts always did.
    expect(shellQuote("--cap-add=SYS_ADMIN")).toBe("--cap-add=SYS_ADMIN");
    expect(shellQuote(`it's`)).toBe(`'it'\\''s'`);
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

test("replayableEnv allowlists, drops empties, and orders canonically — image identity is never replayed", () => {
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

test("the health gate is one definition: daemon port, bounded patience", () => {
    expect(HEALTH.url).toBe("http://localhost:8787/health");
    expect(HEALTH.attempts * HEALTH.intervalSeconds).toBe(30);
});
