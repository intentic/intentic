import type { SshExecutor, SshResult, SshSession, SshTarget } from "../core/ssh.js";
import { createHostProvider } from "./host.js";

// What iproute2 answers `route get` with: JSON from `ip -j`, else one line whose words around `src` vary with the route.
const ROUTE_JSON = '[{"dst":"1.1.1.1","gateway":"10.0.0.1","dev":"eth0","prefsrc":"10.0.0.5","flags":[],"uid":0,"cache":[]}]\n';
const ROUTE_VIA = "1.1.1.1 via 10.0.0.1 dev eth0 src 10.0.0.5 uid 0 \\    cache \n";
const ROUTE_ON_LINK = "1.1.1.1 dev eth0 src 10.0.0.5 uid 0 \\    cache \n";
const ROUTE_POLICY = "1.1.1.1 via 10.0.0.1 dev eth0 table 100 src 10.0.0.5 uid 0 \\    cache \n";

// A Docker-ready host: docker version succeeds, the route command yields the internal ip.
const dockerReadyWith =
    (route: string) =>
    (command: string): SshResult =>
        command.includes("docker") ? { stdout: "24.0.0", stderr: "", code: 0 } : { stdout: route, stderr: "", code: 0 };
const dockerReady = dockerReadyWith(ROUTE_JSON);

const sessionFrom = (respond: (command: string) => SshResult): SshSession => ({
    exec: async (command) => respond(command),
    dispose: async () => {},
});

const reachable = (respond: (command: string) => SshResult): SshExecutor => ({ connect: async () => sessionFrom(respond) });
const unreachable: SshExecutor = {
    connect: async () => {
        throw new Error("ECONNREFUSED");
    },
};

const ctx = (log: (message: string) => void = () => {}) => ({
    env: {},
    log,
    id: "host",
    output: () => {
        throw new Error("unused in host provider");
    },
});

const inputs = { address: "203.0.113.10", user: "deploy", sshKey: "key-material" };

test("read returns the host facts when reachable and Docker-ready", async () => {
    const provider = createHostProvider(reachable(dockerReady));
    expect(await provider.read(inputs, ctx())).toEqual({ outputs: { internalIp: "10.0.0.5", publicIp: "203.0.113.10" } });
});

test("read returns undefined and logs when the host is unreachable", async () => {
    const logs: string[] = [];
    const provider = createHostProvider(unreachable);
    expect(
        await provider.read(
            inputs,
            ctx((message) => logs.push(message)),
        ),
    ).toBeUndefined();
    expect(logs.some((message) => message.includes("not reachable"))).toBe(true);
});

test("the internal ip is the route's source address, in JSON or in any shape of the one-line answer", async () => {
    for (const route of [ROUTE_JSON, ROUTE_VIA, ROUTE_ON_LINK, ROUTE_POLICY]) {
        expect(await createHostProvider(reachable(dockerReadyWith(route))).read(inputs, ctx())).toEqual({ outputs: { internalIp: "10.0.0.5", publicIp: "203.0.113.10" } });
    }
});

test("an answer with no IPv4 source address fails loudly instead of becoming the internal ip", async () => {
    for (const route of ["1.1.1.1 via 10.0.0.1 dev eth0 uid 0\n", '[{"dst":"1.1.1.1","dev":"eth0"}]', "1.1.1.1 dev eth0 src fe80::1\n", ""]) {
        await expect(createHostProvider(reachable(dockerReadyWith(route))).read(inputs, ctx())).rejects.toThrow(/no IPv4 source address/);
    }
});

const noDocker = (command: string): SshResult =>
    command.includes("docker") ? { stdout: "", stderr: "docker: command not found", code: 127 } : { stdout: ROUTE_JSON, stderr: "", code: 0 };

test("read propagates (does not swallow) a missing Docker", async () => {
    const provider = createHostProvider(reachable(noDocker));
    await expect(provider.read(inputs, ctx())).rejects.toThrow(/not Docker-ready/);
});

test("apply gathers and returns the host facts", async () => {
    const provider = createHostProvider(reachable(dockerReady));
    expect(await provider.apply(inputs, undefined, ctx())).toEqual({ internalIp: "10.0.0.5", publicIp: "203.0.113.10" });
});

test("apply propagates a connection failure (the hard error for owned infra)", async () => {
    const provider = createHostProvider(unreachable);
    await expect(provider.apply(inputs, undefined, ctx())).rejects.toThrow(/ECONNREFUSED/);
});

test("diff is always noop for an owned host", () => {
    const provider = createHostProvider(reachable(dockerReady));
    expect(provider.diff({}, { outputs: {} })).toEqual({ action: "noop" });
});

test("malformed inputs are rejected", async () => {
    const provider = createHostProvider(reachable(dockerReady));
    await expect(provider.read({ user: "deploy", sshKey: "k" }, ctx())).rejects.toThrow(/host inputs malformed/);
    await expect(provider.read({ address: "a", user: "deploy", sshKey: "k", port: "22" }, ctx())).rejects.toThrow(/port/);
});

test("the SSH port defaults to 22 when absent", async () => {
    let captured: SshTarget | undefined;
    const executor: SshExecutor = {
        connect: async (target) => {
            captured = target;
            return sessionFrom(dockerReady);
        },
    };
    await createHostProvider(executor).read(inputs, ctx());
    expect(captured?.port).toBe(22);
});
