import type { ScanSource } from "@intentic/engine";
import { listHostStamps, listStampedContainers } from "./list-stamped.js";
import type { SshExecutor, SshSession } from "./ssh.js";

const HOST_INPUTS = { address: "10.0.0.1", user: "root", sshKey: "key", port: 22, via: "direct" } as const;
const sources = (): ScanSource[] => [
    { id: "h1", type: "host", inputs: { ...HOST_INPUTS } },
    { id: "app", type: "outline", inputs: {} },
];
const quiet = { log: () => {} };

// A fake executor whose single exec answers the whole-scan stamped table; counts connects.
const tableExecutor = (stdout: string, code = 0): { executor: SshExecutor; connects: () => number } => {
    let connects = 0;
    const session: SshSession = {
        exec: async () => ({ stdout, stderr: code === 0 ? "" : "Cannot connect to the Docker daemon", code }),
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
    const outlines = await listStampedContainers(executor, "outline", scan, quiet);
    const komodos = await listStampedContainers(executor, "komodo", scan, quiet);
    const backups = await listStampedContainers(executor, "backup", scan, quiet);
    expect(outlines.map((entry) => entry.id)).toEqual(["o1", "o2"]);
    expect(komodos).toEqual([{ id: "deploy", inputs: scan[0]!.inputs, protected: true }]);
    expect(backups).toEqual([]);
    // The whole point: three providers' lists, ONE ssh connect.
    expect(connects()).toBe(1);
});

test("each entry carries its owner stamp, absent on a container stamped before owners", async () => {
    const { executor } = tableExecutor("outline\tmine\t\taaa\noutline\ttheirs\t\tbbb\noutline\tlegacy\t\t\n");
    const entries = await listStampedContainers(executor, "outline", sources(), quiet);
    expect(entries.map((entry) => [entry.id, entry.owner])).toEqual([
        ["mine", "aaa"],
        ["theirs", "bbb"],
        ["legacy", undefined],
    ]);
});

test("an unreachable host is dialed once, logged once, reported as a skipped source, and reads as empty for every kind", async () => {
    let connects = 0;
    const logs: string[] = [];
    const skipped: string[] = [];
    const executor: SshExecutor = {
        connect: async () => {
            connects += 1;
            throw new Error("dial tcp: connection refused");
        },
    };
    const scan = sources();
    const ctx = { log: (message: string) => logs.push(message), skipped: (source: string, reason: string) => skipped.push(`${source}: ${reason}`) };
    expect(await listStampedContainers(executor, "outline", scan, ctx)).toEqual([]);
    expect(await listStampedContainers(executor, "komodo", scan, ctx)).toEqual([]);
    expect(connects).toBe(1);
    expect(logs).toHaveLength(1);
    expect(logs[0]).toContain(`host "h1" not reachable`);
    expect(skipped).toEqual(["h1: not reachable over SSH"]);
});

test("a failed docker listing is a skipped source, never an empty host", async () => {
    const { executor } = tableExecutor("", 1);
    const skipped: string[] = [];
    const entries = await listStampedContainers(executor, "outline", sources(), { log: () => {}, skipped: (source) => skipped.push(source) });
    expect(entries).toEqual([]);
    expect(skipped).toEqual(["h1"]);
});

test("the strict host listing throws on a failed docker listing, so a caller never mistakes it for a clean host", async () => {
    const target = { address: "10.0.0.1", user: "root", privateKey: "key", port: 22 };
    await expect(listHostStamps(tableExecutor("", 1).executor, target)).rejects.toThrow(/listing stamped containers failed/);
    expect(await listHostStamps(tableExecutor("outline\to1\ttrue\taaa\n").executor, target)).toEqual([
        { type: "outline", id: "o1", protected: true, owner: "aaa" },
    ]);
});

test("duplicate stamps on one host collapse to one entry", async () => {
    const { executor } = tableExecutor("outline\to1\t\noutline\to1\t\n");
    const entries = await listStampedContainers(executor, "outline", sources(), quiet);
    expect(entries.map((entry) => entry.id)).toEqual(["o1"]);
});
