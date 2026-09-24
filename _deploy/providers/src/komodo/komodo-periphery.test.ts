import type { SshExecutor, SshSession } from "../core/ssh.js";
import { createKomodoPeripheryProvider } from "./komodo-periphery.js";

const fakeSsh = (): { executor: SshExecutor; commands: string[] } => {
    const commands: string[] = [];
    const session: SshSession = {
        exec: async (command) => {
            commands.push(command);
            return { stdout: "", stderr: "", code: 0 };
        },
        dispose: async () => {},
    };
    return { executor: { connect: async () => session }, commands };
};

const unreachable: SshExecutor = {
    connect: async () => {
        throw new Error("ECONNREFUSED");
    },
};

const ctx = {
    env: {},
    log: () => {},
    id: "worker-periphery",
    output: () => {
        throw new Error("unused");
    },
};

const inputs = {
    address: "203.0.113.20",
    user: "deploy",
    sshKey: "key",
    coreAddress: "https://deploy.example.com",
    serverName: "worker",
    image: "ghcr.io/moghtech/komodo-periphery:2.1.0@sha256:bbbb",
};

test("delete removes the periphery container on the worker host", async () => {
    const ssh = fakeSsh();
    await createKomodoPeripheryProvider(ssh.executor).delete?.(inputs, ctx);
    expect(ssh.commands).toEqual(["docker rm -f intentic-periphery-worker 2>/dev/null || true"]);
});

test("delete fails when the worker host is unreachable, so prune never counts the container as removed", async () => {
    await expect(createKomodoPeripheryProvider(unreachable).delete?.(inputs, ctx)).rejects.toThrow("ECONNREFUSED");
});
