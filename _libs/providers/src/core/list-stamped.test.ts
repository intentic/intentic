import type { ScanSource } from "@intentic/engine";
import { expect, test } from "vitest";
import { listStampedContainers } from "./list-stamped.js";
import type { SshExecutor, SshSession } from "./ssh.js";

const HOST_INPUTS = { address: "10.0.0.1", user: "root", sshKey: "key", port: 22, via: "direct" } as const;
const sources = (): ScanSource[] => [
    { id: "h1", type: "host", inputs: { ...HOST_INPUTS } },
    { id: "app", type: "outline", inputs: {} },
];

// A fake executor whose single exec answers the whole-scan stamped table; counts connects.
const tableExecutor = (stdout: string): { executor: SshExecutor; connects: () => number } => {
    let connects = 0;
    const session: SshSession = {
        exec: async () => ({ stdout, stderr: "", code: 0 }),
        dispose: async () => {},
    };
    return {
        executor: {
            connect: async () => {
                connects += 1;
                return session;
            },
        },
        connects: () => connects,
    };
};

test("one connect serves every kind of the scan, filtered per kind with protection", async () => {
    const { executor, connects } = tableExecutor("outline\to1\t\nkomodo\tdeploy\ttrue\noutline\to2\tfalse\n");
    const scan = sources();
    const outlines = await listStampedContainers(executor, "outline", scan, () => {});
    const komodos = await listStampedContainers(executor, "komodo", scan, () => {});
    const backups = await listStampedContainers(executor, "backup", scan, () => {});
    expect(outlines.map((entry) => entry.id)).toEqual(["o1", "o2"]);
    expect(komodos).toEqual([{ id: "deploy", inputs: scan[0]?.inputs, protected: true }]);
    expect(backups).toEqual([]);
    // The whole point: three providers' lists, ONE ssh connect.
    expect(connects()).toBe(1);
});

test("an unreachable host is dialed once, logged once, and reads as empty for every kind", async () => {
    let connects = 0;
    const logs: string[] = [];
    const executor: SshExecutor = {
        connect: async () => {
            connects += 1;
            throw new Error("dial tcp: connection refused");
        },
    };
    const scan = sources();
    expect(await listStampedContainers(executor, "outline", scan, (message) => logs.push(message))).toEqual([]);
    expect(await listStampedContainers(executor, "komodo", scan, (message) => logs.push(message))).toEqual([]);
    expect(connects).toBe(1);
    expect(logs).toHaveLength(1);
    expect(logs[0]).toContain(`host "h1" not reachable`);
});

test("duplicate stamps on one host collapse to one entry", async () => {
    const { executor } = tableExecutor("outline\to1\t\noutline\to1\t\n");
    const entries = await listStampedContainers(executor, "outline", sources(), () => {});
    expect(entries.map((entry) => entry.id)).toEqual(["o1"]);
});
