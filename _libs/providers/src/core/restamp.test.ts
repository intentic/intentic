import { describe, expect, it } from "vitest";
import { restampBacking } from "./backing-ssh.js";
import type { SshResult, SshSession } from "./ssh.js";

// A fake session capturing the single script restampBacking runs, with a settable exit code.
const fakeSession = (code = 0): { session: SshSession; commands: string[] } => {
    const commands: string[] = [];
    return {
        commands,
        session: {
            exec: async (command): Promise<SshResult> => {
                commands.push(command);
                return { stdout: "", stderr: code === 0 ? "" : "boom", code };
            },
            dispose: async () => {},
        },
    };
};

describe("restampBacking", () => {
    it("migrates the named volume, moves the state dir, and stops the old project keeping its data", async () => {
        const { session, commands } = fakeSession();
        await restampBacking(session, "postgres", "db", "db2", "postgres:17@sha256:aaa");
        const script = commands.join("\n");
        // Stops the OLD project without -v (data must survive the move).
        expect(script).toContain("docker compose -p intentic-postgres-db ");
        expect(script).not.toContain("down -v");
        // Migrates the volume old -> new (create + copy via the instance image + remove), since Docker has no rename.
        expect(script).toContain("docker volume create intentic-postgres-db2_data");
        expect(script).toContain("-v intentic-postgres-db_data:/from -v intentic-postgres-db2_data:/to postgres:17@sha256:aaa");
        expect(script).toContain("docker volume rm intentic-postgres-db_data");
        // Moves the host-side state dir under the new id.
        expect(script).toContain("mv /opt/intentic/postgres/db /opt/intentic/postgres/db2");
    });

    it("is idempotent: skips the whole migration when the new state dir already exists", async () => {
        const { session, commands } = fakeSession();
        await restampBacking(session, "valkey", "cache", "cache2", "valkey:8@sha256:bbb");
        expect(commands.join("\n")).toContain("if [ -d /opt/intentic/valkey/cache2 ]; then exit 0; fi");
    });

    it("throws with stderr when the host script fails", async () => {
        const { session } = fakeSession(1);
        await expect(restampBacking(session, "postgres", "db", "db2", "img")).rejects.toThrow(/failed to restamp postgres "db" → "db2".*boom/s);
    });
});
