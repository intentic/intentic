import { createHash } from "node:crypto";
import { expect, test } from "vitest";
import type { SshExecutor, SshResult, SshSession } from "../core/ssh.js";
import { createWorkspaceProvider } from "./workspace.js";

const res = (stdout: string, code = 0): SshResult => ({ stdout, stderr: "", code });

const IMAGE = "ghcr.io/intentic/sandbox:0.1.0";
const CONTAINER = "intentic-sandbox-workspace";

const fakeSsh = (
    opts: { running?: boolean; image?: string; tools?: string; runFails?: boolean; buildFails?: boolean } = {},
): { executor: SshExecutor; commands: string[] } => {
    const commands: string[] = [];
    const session: SshSession = {
        exec: async (command) => {
            commands.push(command);
            // Both image + tools-digest reads are `docker inspect`; distinguish by the label template (the
            // run command also carries an `intentic.tools=` label, so this must stay inside the inspect branch).
            if (command.includes("docker inspect")) {
                return res(command.includes("intentic.tools") ? (opts.tools ?? "") : (opts.image ?? IMAGE));
            }
            if (command.includes("docker ps")) {
                return res(opts.running ? CONTAINER : "");
            }
            if (command.includes("docker build")) {
                return res("sha256:built", opts.buildFails ? 1 : 0);
            }
            if (command.includes("docker run")) {
                return res("id", opts.runFails ? 1 : 0);
            }
            return res("");
        },
        dispose: async () => {},
    };
    return { executor: { connect: async () => session }, commands };
};

// A resolved agent tool as the engine hands it to the provider (token already a concrete string).
const TOOL = { name: "obs", url: "https://signoz.example.com/mcp", token: "tok-mcp" };

const unreachable: SshExecutor = {
    connect: async () => {
        throw new Error("ECONNREFUSED");
    },
};

const ctx = (log: (message: string) => void = () => {}) => ({
    env: {},
    log,
    id: "workspace",
    output: () => {
        throw new Error("unused");
    },
});

const inputs = {
    server: "host",
    address: "203.0.113.10",
    user: "deploy",
    sshKey: "key",
    internalIp: "10.0.0.5",
    domain: "*.example.com",
    zone: "example.com",
    previewPort: 5173,
    daemonPort: 8787,
    network: "intentic-workspace",
    image: IMAGE,
};

const OUTPUTS = {
    internalUrl: "http://10.0.0.5:8787",
    healthUrl: "http://10.0.0.5:8787/health",
    previewBase: "example.com",
};

test("read returns undefined when the host is unreachable over SSH", async () => {
    expect(await createWorkspaceProvider(unreachable).read(inputs, ctx())).toBeUndefined();
});

test("read returns undefined when the sandbox container is not running", async () => {
    expect(await createWorkspaceProvider(fakeSsh({ running: false }).executor).read(inputs, ctx())).toBeUndefined();
});

test("read returns the daemon/health/base outputs + observed image and tools digest when running", async () => {
    expect(await createWorkspaceProvider(fakeSsh({ running: true, tools: "deadbeef" }).executor).read(inputs, ctx())).toEqual({
        outputs: OUTPUTS,
        detail: { image: IMAGE, tools: "deadbeef" },
    });
});

test("diff is noop when the running image matches the pin, update when it differs", () => {
    const provider = createWorkspaceProvider(fakeSsh().executor);
    expect(provider.diff(inputs, { outputs: {}, detail: { image: IMAGE, tools: "" } })).toEqual({ action: "noop" });
    expect(provider.diff(inputs, { outputs: {}, detail: { image: "ghcr.io/intentic/sandbox:0.0.9", tools: "" } }).action).toBe("update");
});

test("apply forwards the agent tools as base64 INTENTIC_AGENT_TOOLS + stamps the tools digest label", async () => {
    const ssh = fakeSsh();
    await createWorkspaceProvider(ssh.executor).apply({ ...inputs, tools: [TOOL] }, undefined, ctx());
    const run = ssh.commands.find((c) => c.includes("docker run")) ?? "";
    const encoded = /-e INTENTIC_AGENT_TOOLS=(\S+)/.exec(run)?.[1];
    // Base64, which is the whole reason this variable exists: the tools ride encoded so their quotes and
    // newlines never meet a shell. A raw JSON blob here would satisfy "something was captured" and fail in use.
    expect(encoded).toMatch(/^[A-Za-z0-9+/]+={0,2}$/);
    // The value round-trips: base64 → JSON → the resolved tools the agent connects to.
    expect(JSON.parse(Buffer.from(encoded as string, "base64").toString("utf8"))).toEqual([TOOL]);
    expect(/--label intentic\.tools=\S+/.test(run)).toBe(true);
});

test("apply omits the tools env when no tools are wired (preview-only sandboxes stay lean)", async () => {
    const ssh = fakeSsh();
    await createWorkspaceProvider(ssh.executor).apply(inputs, undefined, ctx());
    expect(ssh.commands.some((c) => c.includes("INTENTIC_AGENT_TOOLS"))).toBe(false);
});

test("diff updates when the agent tools change (digest drift), and is noop against the digest apply stamped", async () => {
    const ssh = fakeSsh();
    const provider = createWorkspaceProvider(ssh.executor);
    const withTools = { ...inputs, tools: [TOOL] };
    // A stale/empty tools label against a tools-bearing spec must recreate so the new tools take effect.
    expect(provider.diff(withTools, { outputs: {}, detail: { image: IMAGE, tools: "" } }).action).toBe("update");
    // The digest apply stamps on the container is exactly what diff treats as a noop (no needless recreate).
    await provider.apply(withTools, undefined, ctx());
    const digest = /--label intentic\.tools=(\S+)/.exec(ssh.commands.find((c) => c.includes("docker run")) ?? "")?.[1];
    // A non-empty token. The empty-string case is the one that matters: the line below feeds this straight back
    // into `diff`, and an empty digest against an empty stored label compares equal, so the noop it asserts
    // would hold for a container that was stamped with nothing at all.
    expect(digest).toMatch(/^\S+$/);
    expect(provider.diff(withTools, { outputs: {}, detail: { image: IMAGE, tools: digest as string } })).toEqual({ action: "noop" });
});

test("apply ensures the network, then runs the sandbox unprivileged with internalIp-bound ports + the env", async () => {
    const ssh = fakeSsh();
    const outputs = await createWorkspaceProvider(ssh.executor).apply(inputs, undefined, ctx());
    expect(outputs).toEqual(OUTPUTS);
    expect(ssh.commands.some((c) => c.includes("docker network") && c.includes("intentic-workspace"))).toBe(true);
    const run = ssh.commands.find((c) => c.includes("docker run")) ?? "";
    // Unprivileged by default: the HOST's docker socket is never mounted, no root override, and no
    // privileges or devices without an overlay carrying runtime directives.
    expect(run).not.toContain("--privileged");
    expect(run).not.toContain("--user root");
    expect(run).not.toContain("/var/run/docker.sock");
    expect(run).not.toContain("--device=");
    // The ONE capability the base run carries: SYS_ADMIN, so the daemon can give each isolated agent turn its
    // own mount namespace over the container's OWN filesystem (the sandbox's agents/isolation.ts). Scoped to
    // this container; still no host reach. Every other capability stays overlay-gated.
    expect(run).toContain("--cap-add=SYS_ADMIN");
    expect(run).not.toContain("--cap-add=NET_ADMIN");
    // Both ports bind the host's internal ip (the tunnel reaches them; the public interface does not).
    expect(run).toContain("-p 10.0.0.5:5173:5173");
    expect(run).toContain("-p 10.0.0.5:8787:8787");
    expect(run).toContain("-v intentic-workspace-workspace:/work");
    expect(run).toContain("-v intentic-docker-workspace:/var/lib/docker");
    expect(run).toContain("--network intentic-workspace");
    expect(run).toContain("--add-host host.docker.internal:host-gateway");
    expect(run).toContain("-e SANDBOX_PORT=8787");
    expect(run).toContain("-e PREVIEW_PORT=5173");
    expect(run).toContain(`-e SANDBOX_NAME=${CONTAINER}`);
    expect(run).toContain(`-e SANDBOX_IMAGE=${IMAGE}`);
    expect(run).toContain("intentic.id=workspace");
    expect(run).toContain(IMAGE);
});

test("apply throws when the docker run fails", async () => {
    await expect(createWorkspaceProvider(fakeSsh({ runFails: true }).executor).apply(inputs, undefined, ctx())).rejects.toThrow(
        "failed to start workspace sandbox",
    );
});

// A composed overlay: content + the vpn fragment's runtime directives the executor turns into docker flags.
const DOCKERFILE =
    "FROM ghcr.io/intentic/sandbox:stable\nRUN apt-get install -y cowsay\n# intentic:runtime --device=/dev/net/tun\n# intentic:runtime --cap-add=NET_ADMIN\n";
const DOCKERFILE_HASH = createHash("sha256").update(DOCKERFILE).digest("hex");
const ENV_IMAGE = `intentic-sandbox-env:${DOCKERFILE_HASH.slice(0, 12)}`;

test("apply with an overlay dockerfile builds it (base64 → stdin) BEFORE recreating, and stamps the hash", async () => {
    const ssh = fakeSsh();
    await createWorkspaceProvider(ssh.executor).apply({ ...inputs, dockerfile: DOCKERFILE }, undefined, ctx());
    const buildIndex = ssh.commands.findIndex((c) => c.includes("docker build"));
    const runIndex = ssh.commands.findIndex((c) => c.includes("docker run"));
    expect(buildIndex).toBeGreaterThanOrEqual(0);
    expect(buildIndex).toBeLessThan(runIndex);
    // The build receives exactly the overlay content, targeting the digest-carrying tag.
    const encoded = /printf '%s' (\S+) \| base64 -d/.exec(ssh.commands[buildIndex] as string)?.[1];
    expect(Buffer.from(encoded as string, "base64").toString("utf8")).toBe(DOCKERFILE);
    expect(ssh.commands[buildIndex]).toContain(`-t ${ENV_IMAGE}`);
    // The container runs the built image with the FULL hash the daemon reads back as applied.
    const run = ssh.commands[runIndex] as string;
    expect(run).toContain(`-e SANDBOX_ENVIRONMENT_HASH=${DOCKERFILE_HASH}`);
    expect(run).toContain(`-e SANDBOX_IMAGE=${ENV_IMAGE}`);
    expect(run.endsWith(` ${ENV_IMAGE}`)).toBe(true);
    // The overlay's runtime directives become allowlisted docker flags.
    expect(run).toContain("--device=/dev/net/tun --cap-add=NET_ADMIN");
    // rm + run ride ONE exec so an in-sandbox self-apply isn't killed between them.
    expect(run).toContain(`docker rm -f ${CONTAINER}`);
});

test("apply splices --privileged from a docker-capability overlay (the only source of a privileged run)", async () => {
    const ssh = fakeSsh();
    const dockerfile = "FROM ghcr.io/intentic/sandbox:stable\n# intentic:runtime --privileged\n";
    await createWorkspaceProvider(ssh.executor).apply({ ...inputs, dockerfile }, undefined, ctx());
    expect(ssh.commands.find((c) => c.includes("docker run"))).toContain("--privileged");
});

test("apply rejects a runtime directive outside the allowlist before touching the host", async () => {
    const ssh = fakeSsh();
    await expect(
        createWorkspaceProvider(ssh.executor).apply({ ...inputs, dockerfile: `${DOCKERFILE}# intentic:runtime --pid=host\n` }, undefined, ctx()),
    ).rejects.toThrow("unsupported runtime directive");
    // Validation runs before the build: the host was never touched.
    expect(ssh.commands).toHaveLength(0);
});

test("apply throws when the overlay build fails, leaving the old container untouched", async () => {
    const ssh = fakeSsh({ buildFails: true });
    await expect(createWorkspaceProvider(ssh.executor).apply({ ...inputs, dockerfile: DOCKERFILE }, undefined, ctx())).rejects.toThrow(
        "failed to build the workspace overlay image",
    );
    expect(ssh.commands.some((c) => c.includes("docker rm") || c.includes("docker run"))).toBe(false);
});

test("diff drives recreate on overlay change: stock→overlay updates, matching env tag is a noop", () => {
    const provider = createWorkspaceProvider(fakeSsh().executor);
    const withOverlay = { ...inputs, dockerfile: DOCKERFILE };
    expect(provider.diff(withOverlay, { outputs: {}, detail: { image: IMAGE, tools: "" } }).action).toBe("update");
    expect(provider.diff(withOverlay, { outputs: {}, detail: { image: ENV_IMAGE, tools: "" } })).toEqual({ action: "noop" });
    // Dropping the overlay reverts to the stock image.
    expect(provider.diff(inputs, { outputs: {}, detail: { image: ENV_IMAGE, tools: "" } }).action).toBe("update");
});

test("apply sets ANTHROPIC_BASE_URL only when agentBaseUrl is provided", async () => {
    const without = fakeSsh();
    await createWorkspaceProvider(without.executor).apply(inputs, undefined, ctx());
    expect(without.commands.some((c) => c.includes("ANTHROPIC_BASE_URL"))).toBe(false);

    const withBase = fakeSsh();
    await createWorkspaceProvider(withBase.executor).apply({ ...inputs, agentBaseUrl: "http://gateway.internal:4000" }, undefined, ctx());
    expect(withBase.commands.some((c) => c.includes("docker run") && c.includes("-e ANTHROPIC_BASE_URL=http://gateway.internal:4000"))).toBe(true);
});
