import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SETTLES, waitFor } from "@intentic/testing/bun";
import { fileCredentialGrants } from "./credential-grants.js";

// A person's release outlasts the process that heard it: what one daemon was told, the next one reads back.

const releasesFile = async (): Promise<string> => join(await mkdtemp(join(tmpdir(), "credential-releases-")), "credential-releases.json");

// Every write lands after the load, one after another; a fresh instance over the same file is how a restart reads it.
// Waited for by what the file holds, not slept for: five chained writes outlasted a fixed 50 ms on a loaded CI runner
// (verify-core in run 36705977800), and the restart then read a take-back that had not landed yet.
const holds = async (path: string, expected: unknown): Promise<void> => {
    await waitFor(async () => {
        expect(JSON.parse(await readFile(path, "utf8"))).toEqual(expected);
    }, SETTLES);
};

// Only for a write that must not happen, where there is nothing to wait for.
const settledWrites = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 50));

test("a release given before a restart is held after it, and one taken back stays taken back", async () => {
    const path = await releasesFile();
    const warned: unknown[] = [];
    const before = fileCredentialGrants(path, (error) => warned.push(error));
    await before.ready;
    // github first, so the file holds reddit-work alone once the last write lands and at no point before it.
    before.grant("conv-1", "github", { approvedBy: "bob@acme.dev", at: 20 });
    before.grant("conv-1", "reddit-work", { approvedBy: "ada@acme.dev", at: 10 });
    before.grant("conv-2", "linear", { approvedBy: "ada@acme.dev", at: 30 });
    expect(before.revoke("conv-1", "github")).toBe(true);
    before.forget("conv-2");
    await holds(path, { "conv-1": { "reddit-work": { approvedBy: "ada@acme.dev", at: 10 } } });

    const after = fileCredentialGrants(path, (error) => warned.push(error));
    await after.ready;
    expect(after.has("conv-1", "reddit-work")).toEqual({ approvedBy: "ada@acme.dev", at: 10 });
    expect(after.has("conv-1", "github")).toBeUndefined();
    expect(after.all()).toEqual([{ conversationId: "conv-1", subject: "reddit-work", grant: { approvedBy: "ada@acme.dev", at: 10 } }]);
    expect(warned).toEqual([]);
});

test("a release answered while the stored ones load is kept, and the stored ones still arrive", async () => {
    const path = await releasesFile();
    await writeFile(path, JSON.stringify({ "conv-1": { "reddit-work": { approvedBy: "ada@acme.dev", at: 10 } } }));
    const grants = fileCredentialGrants(path, () => undefined);
    grants.grant("conv-1", "github", { approvedBy: "bob@acme.dev", at: 20 });
    await grants.ready;
    expect(grants.all().map(({ subject }) => subject).toSorted()).toEqual(["github", "reddit-work"]);
    await holds(path, {
        "conv-1": { "reddit-work": { approvedBy: "ada@acme.dev", at: 10 }, github: { approvedBy: "bob@acme.dev", at: 20 } },
    });
});

test("a file that cannot be read is said, and never written over with nothing", async () => {
    const path = await releasesFile();
    await writeFile(path, "{ not json");
    const warned: unknown[] = [];
    const grants = fileCredentialGrants(path, (error) => warned.push(error));
    await grants.ready;
    grants.grant("conv-1", "github", { approvedBy: "bob@acme.dev", at: 20 });
    await settledWrites();
    expect(warned.length).toBeGreaterThan(0);
    expect(await readFile(path, "utf8")).toBe("{ not json");
});
