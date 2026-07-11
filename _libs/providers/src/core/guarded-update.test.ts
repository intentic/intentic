import { expect, test } from "vitest";
import { guardedUpdate } from "./guarded-update.js";
import type { SshResult, SshSession } from "./ssh.js";

// Records every command and lets specific ones be forced to a non-zero exit (e.g. a failed snapshot).
const fakeSession = (fail: (command: string) => boolean = () => false): { session: SshSession; commands: string[] } => {
    const commands: string[] = [];
    const session: SshSession = {
        exec: async (command): Promise<SshResult> => {
            commands.push(command);
            return { stdout: "", stderr: "boom", code: fail(command) ? 1 : 0 };
        },
        dispose: async () => {},
    };
    return { session, commands };
};

const base = (session: SshSession) => ({
    session,
    repo: "s3:s3.example.com/bucket",
    resticImage: "restic/restic:0.19.0@sha256:aaaa",
    volumes: ["intentic-forgejo-data"],
    tag: "intentic-preupdate-host-git",
    log: () => {},
});

test("happy path snapshots each volume then recreates, with no rollback or restore", async () => {
    const { session, commands } = fakeSession();
    let recreated = false;
    await guardedUpdate({
        ...base(session),
        recreate: async () => {
            recreated = true;
        },
        stop: async () => {},
        rollback: async () => {
            throw new Error("rollback should not run on success");
        },
    });
    expect(recreated).toBe(true);
    expect(commands.some((c) => c.includes("backup /v --tag intentic-preupdate-host-git") && c.includes("intentic-forgejo-data"))).toBe(true);
    expect(commands.some((c) => c.includes("restore"))).toBe(false);
});

test("a failed recreate stops, restores every volume from the snapshot, rolls back, and rethrows", async () => {
    const { session, commands } = fakeSession();
    const order: string[] = [];
    await expect(
        guardedUpdate({
            ...base(session),
            volumes: ["komodo_postgres-data", "komodo_keys"],
            recreate: async () => {
                order.push("recreate");
                throw new Error("new image unhealthy");
            },
            stop: async () => {
                order.push("stop");
            },
            rollback: async () => {
                order.push("rollback");
            },
        }),
    ).rejects.toThrow("new image unhealthy");
    // stop happens before the restores; rollback after.
    expect(order).toEqual(["recreate", "stop", "rollback"]);
    expect(commands.filter((c) => c.includes("restore latest --tag intentic-preupdate-host-git")).length).toBe(2);
});

test("aborts before recreate when the pre-update snapshot fails (no recovery point)", async () => {
    const { session } = fakeSession((command) => command.includes("backup /v"));
    let recreated = false;
    await expect(
        guardedUpdate({
            ...base(session),
            recreate: async () => {
                recreated = true;
            },
            stop: async () => {},
            rollback: async () => {},
        }),
    ).rejects.toThrow(/pre-update snapshot .* failed/);
    expect(recreated).toBe(false);
});
