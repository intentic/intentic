import { expect, test } from "vitest";
import type { SshExecutor, SshResult, SshSession } from "../core/ssh.js";
import type { CloudflareApi, IngressRule } from "./cloudflare-api.js";
import { createTunnelProvider } from "./tunnel.js";

const NOT_USED = async (): Promise<never> => {
    throw new Error("unused by the tunnel provider");
};
const api = (overrides: Partial<CloudflareApi>): CloudflareApi => ({
    getZone: NOT_USED,
    listZones: NOT_USED,
    findTunnel: NOT_USED,
    createTunnel: NOT_USED,
    getTunnelToken: NOT_USED,
    getTunnelStatus: NOT_USED,
    getTunnelIngress: NOT_USED,
    putTunnelIngress: NOT_USED,
    findDnsRecord: NOT_USED,
    createDnsRecord: NOT_USED,
    updateDnsRecord: NOT_USED,
    deleteTunnel: NOT_USED,
    deleteDnsRecord: NOT_USED,
    ...overrides,
});

const IMAGE = "cloudflare/cloudflared:2026.7.2@sha256:aaaa";

// A fake host: records commands and reports the connector container running once a matching `docker run`
// has executed (or from an initial name, to drive read without an apply). `docker inspect` reports the
// running image so the image-drift diff can be exercised.
const fakeSsh = (running?: string, image: string = IMAGE): { executor: SshExecutor; commands: string[] } => {
    const commands: string[] = [];
    let current = running;
    const session: SshSession = {
        exec: async (command): Promise<SshResult> => {
            commands.push(command);
            if (command.includes("docker inspect")) {
                return { stdout: current !== undefined ? image : "", stderr: "", code: 0 };
            }
            if (command.includes("docker ps")) {
                return { stdout: current ?? "", stderr: "", code: 0 };
            }
            if (command.includes("docker run")) {
                current = /--name (\S+)/.exec(command)?.[1];
                return { stdout: "container-id", stderr: "", code: 0 };
            }
            return { stdout: "", stderr: "", code: 0 };
        },
        dispose: async () => {},
    };
    return { executor: { connect: async () => session }, commands };
};

const ctx = (log: (message: string) => void = () => {}) => ({
    env: {},
    log,
    id: "host-tunnel",
    output: () => {
        throw new Error("unused in tunnel provider");
    },
});

const appRule: IngressRule = { hostname: "app.example.com", service: "http://127.0.0.1:3000" };
const catchAll: IngressRule = { service: "http_status:404" };
const inputs = {
    name: "intentic-host",
    accountId: "acct-1",
    apiToken: "token-xyz",
    address: "203.0.113.10",
    user: "deploy",
    sshKey: "key",
    ingress: [{ hostname: "app.example.com", port: 3000 }],
    image: IMAGE,
};

test("read returns undefined when the tunnel does not exist", async () => {
    const provider = createTunnelProvider(api({ findTunnel: async () => undefined }), fakeSsh().executor);
    expect(await provider.read(inputs, ctx())).toBeUndefined();
});

test("read returns the tunnel facts plus connector/ingress detail when it exists", async () => {
    const provider = createTunnelProvider(
        api({ findTunnel: async () => ({ id: "tunnel-abc" }), getTunnelIngress: async () => [appRule, catchAll] }),
        fakeSsh("intentic-tunnel-tunnel-abc").executor,
    );
    expect(await provider.read(inputs, ctx())).toEqual({
        outputs: { tunnelId: "tunnel-abc", cname: "tunnel-abc.cfargotunnel.com" },
        detail: { ingress: [appRule, catchAll], connectorRunning: true, image: IMAGE },
    });
});

test("diff is noop when the connector runs on the desired image and the ingress matches", () => {
    const provider = createTunnelProvider(api({}), fakeSsh().executor);
    const observed = { outputs: {}, detail: { ingress: [appRule, catchAll], connectorRunning: true, image: IMAGE } };
    expect(provider.diff(inputs, observed)).toEqual({ action: "noop" });
});

test("diff is update when the connector is not running", () => {
    const provider = createTunnelProvider(api({}), fakeSsh().executor);
    const observed = { outputs: {}, detail: { ingress: [appRule, catchAll], connectorRunning: false } };
    expect(provider.diff(inputs, observed).action).toBe("update");
});

test("diff is update when the connector runs on a different image", () => {
    const provider = createTunnelProvider(api({}), fakeSsh().executor);
    const observed = {
        outputs: {},
        detail: { ingress: [appRule, catchAll], connectorRunning: true, image: "cloudflare/cloudflared:old@sha256:bbbb" },
    };
    expect(provider.diff(inputs, observed).action).toBe("update");
});

test("diff is update when the ingress differs from desired", () => {
    const provider = createTunnelProvider(api({}), fakeSsh().executor);
    const observed = { outputs: {}, detail: { ingress: [catchAll], connectorRunning: true, image: IMAGE } };
    expect(provider.diff(inputs, observed).action).toBe("update");
});

test("apply creates the tunnel, runs the connector with the token, and puts ingress with the catch-all", async () => {
    let created = false;
    let putIngress: readonly IngressRule[] | undefined;
    const ssh = fakeSsh();
    const provider = createTunnelProvider(
        api({
            findTunnel: async () => undefined,
            createTunnel: async () => {
                created = true;
                return { id: "tunnel-new" };
            },
            getTunnelToken: async () => "tok-123",
            getTunnelStatus: async () => "healthy",
            putTunnelIngress: async ({ ingress }) => {
                putIngress = ingress;
            },
        }),
        ssh.executor,
    );

    expect(await provider.apply(inputs, undefined, ctx())).toEqual({ tunnelId: "tunnel-new", cname: "tunnel-new.cfargotunnel.com" });
    expect(created).toBe(true);
    expect(ssh.commands.some((command) => command.includes("docker run") && command.includes("--token tok-123"))).toBe(true);
    expect(putIngress).toEqual([appRule, catchAll]);
});

test("apply reuses an existing tunnel rather than creating a new one", async () => {
    let created = false;
    const provider = createTunnelProvider(
        api({
            findTunnel: async () => ({ id: "tunnel-existing" }),
            createTunnel: async () => {
                created = true;
                return { id: "should-not-happen" };
            },
            getTunnelToken: async () => "tok",
            getTunnelStatus: async () => "healthy",
            putTunnelIngress: async () => {},
        }),
        fakeSsh().executor,
    );

    expect((await provider.apply(inputs, undefined, ctx())).tunnelId).toBe("tunnel-existing");
    expect(created).toBe(false);
});

test("apply on an ingress-only change puts the config without restarting the running connector", async () => {
    let putIngress: readonly IngressRule[] | undefined;
    const ssh = fakeSsh("intentic-tunnel-tunnel-abc");
    // getTunnelToken/getTunnelStatus stay NOT_USED: a running, image-current connector must be left alone —
    // the ingress PUT reaches it as a live config push, so a restart (and its 1033 outage window) is a bug.
    const provider = createTunnelProvider(
        api({
            findTunnel: async () => ({ id: "tunnel-abc" }),
            putTunnelIngress: async ({ ingress }) => {
                putIngress = ingress;
            },
        }),
        ssh.executor,
    );

    const observed = { outputs: {}, detail: { ingress: [catchAll], connectorRunning: true, image: IMAGE } };
    expect(await provider.apply(inputs, observed, ctx())).toEqual({ tunnelId: "tunnel-abc", cname: "tunnel-abc.cfargotunnel.com" });
    expect(putIngress).toEqual([appRule, catchAll]);
    expect(ssh.commands.some((command) => command.includes("docker run") || command.includes("docker rm"))).toBe(false);
});

test("apply restarts the connector when its image drifted and waits until the edge reports serving", { timeout: 10_000 }, async () => {
    const statuses = ["down", "healthy"];
    let polls = 0;
    const ssh = fakeSsh("intentic-tunnel-tunnel-abc");
    const provider = createTunnelProvider(
        api({
            findTunnel: async () => ({ id: "tunnel-abc" }),
            getTunnelToken: async () => "tok-123",
            getTunnelStatus: async () => statuses[Math.min(polls++, statuses.length - 1)] ?? "healthy",
            putTunnelIngress: async () => {},
        }),
        ssh.executor,
    );

    const observed = { outputs: {}, detail: { ingress: [appRule, catchAll], connectorRunning: true, image: "cloudflare/cloudflared:old@sha256:bbbb" } };
    await provider.apply(inputs, observed, ctx());
    expect(ssh.commands.some((command) => command.includes("docker run") && command.includes("--token tok-123"))).toBe(true);
    expect(polls).toBe(2);
});

test("apply restarts the connector when it is not running", async () => {
    const ssh = fakeSsh();
    const provider = createTunnelProvider(
        api({
            findTunnel: async () => ({ id: "tunnel-abc" }),
            getTunnelToken: async () => "tok-123",
            getTunnelStatus: async () => "healthy",
            putTunnelIngress: async () => {},
        }),
        ssh.executor,
    );

    const observed = { outputs: {}, detail: { ingress: [appRule, catchAll], connectorRunning: false } };
    await provider.apply(inputs, observed, ctx());
    expect(ssh.commands.some((command) => command.includes("docker run"))).toBe(true);
});

test("malformed inputs are rejected", async () => {
    const provider = createTunnelProvider(api({}), fakeSsh().executor);
    await expect(provider.read({ name: "n", accountId: "a", apiToken: "t", address: "x", user: "u", ingress: [] }, ctx())).rejects.toThrow(
        /tunnel inputs malformed/,
    );
    await expect(provider.read({ ...inputs, ingress: "nope" }, ctx())).rejects.toThrow(/ingress/);
});
