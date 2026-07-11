import { expect, test } from "vitest";
import { readinessDiagnostics } from "./ssh-diagnostics.js";
import type { SshExecutor, SshResult, SshSession, SshTarget } from "./ssh.js";

const res = (stdout: string, code = 0): SshResult => ({ stdout, stderr: "", code });

const target = (address: string): SshTarget => ({ address, user: "root", privateKey: "key", port: 22 });

const FAILURE = { id: "host-git", url: "http://10.0.0.5:3000" };

const fakeSsh = (): { executor: SshExecutor; commands: string[] } => {
    const commands: string[] = [];
    const session: SshSession = {
        exec: async (command) => {
            commands.push(command);
            if (command.includes("--filter label=intentic.id=host-git")) {
                return res("intentic-forgejo\n");
            }
            if (command.includes("docker ps -a")) {
                return res("intentic-forgejo\tUp 2 minutes\tcodeberg.org/forgejo/forgejo:15");
            }
            if (command.includes("docker logs")) {
                return res("Starting new Web server: tcp:0.0.0.0:3000");
            }
            if (command.startsWith("ss -tlnp")) {
                return res('LISTEN 0 4096 *:3000 *:* users:(("forgejo",pid=42))');
            }
            if (command.startsWith("ip -4 -o addr")) {
                return res("1: lo inet 127.0.0.1/8\n2: eth0 inet 172.17.0.2/16");
            }
            if (command.startsWith("wget")) {
                return { stdout: "", stderr: "wget: download timed out", code: 1 };
            }
            return res("");
        },
        dispose: async () => {},
    };
    return { executor: { connect: async () => session }, commands };
};

test("readinessDiagnostics sweeps docker state, logs, listeners, addresses, and a probe attempt", async () => {
    const { executor, commands } = fakeSsh();
    const report = await readinessDiagnostics([target("10.0.0.5")], executor, FAILURE);
    expect(report).toContain('--- readiness diagnostics: root@10.0.0.5 (resource "host-git", url http://10.0.0.5:3000) ---');
    expect(report).toContain("intentic-forgejo\tUp 2 minutes");
    expect(report).toContain("$ docker logs --tail 50 intentic-forgejo");
    expect(report).toContain("Starting new Web server: tcp:0.0.0.0:3000");
    expect(report).toContain("*:3000");
    expect(report).toContain("172.17.0.2/16");
    expect(report).toContain("$ wget -S -T 5 -O /dev/null http://10.0.0.5:3000 2>&1");
    expect(report).toContain("wget: download timed out");
    expect(report).toContain("(exit 1)");
    expect(commands.some((command) => command.includes("--filter label=intentic.id=host-git"))).toBe(true);
});

test("readinessDiagnostics degrades an unreachable host to one line and still reports the others", async () => {
    const { executor } = fakeSsh();
    const both: SshExecutor = {
        connect: async (to) => {
            if (to.address === "10.0.0.9") {
                throw new Error("connect ECONNREFUSED");
            }
            return executor.connect(to);
        },
    };
    const report = await readinessDiagnostics([target("10.0.0.9"), target("10.0.0.5")], both, FAILURE);
    expect(report).toContain("host 10.0.0.9 unreachable over SSH: connect ECONNREFUSED");
    expect(report).toContain('--- readiness diagnostics: root@10.0.0.5 (resource "host-git", url http://10.0.0.5:3000) ---');
    expect(report).toContain("$ docker logs --tail 50 intentic-forgejo");
});

test("readinessDiagnostics never throws when every command fails", async () => {
    const session: SshSession = {
        exec: async () => {
            throw new Error("session channel closed");
        },
        dispose: async () => {
            throw new Error("already disposed");
        },
    };
    const report = await readinessDiagnostics([target("10.0.0.5")], { connect: async () => session }, FAILURE);
    expect(report).toContain("failed: session channel closed");
});
