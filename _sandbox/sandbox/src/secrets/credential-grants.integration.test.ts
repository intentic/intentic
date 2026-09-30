import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileCredentialGrants } from "./credential-grants.js";

// A person's release outlasts the process that heard it: what one daemon was told, the next one reads back.

const releasesFile = async (): Promise<string> => join(await mkdtemp(join(tmpdir(), "credential-releases-")), "credential-releases.json");

// Every write lands after the load; a fresh instance over the same file is how a restart reads it.
const settledWrites = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 50));

test("a release given before a restart is held after it, and one taken back stays taken back", async () => {
    const path = await releasesFile();
    const warned: unknown[] = [];
    const before = fileCredentialGrants(path, (error) => warned.push(error));
    await before.ready;
    before.grant("conv-1", "reddit-work", { approvedBy: "ada@acme.dev", at: 10 });
    before.grant("conv-1", "github", { approvedBy: "bob@acme.dev", at: 20 });
    before.grant("conv-2", "linear", { approvedBy: "ada@acme.dev", at: 30 });
    expect(before.revoke("conv-1", "github")).toBe(true);
    before.forget("conv-2");
    await settledWrites();

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
    await settledWrites();
    expect(grants.all().map(({ subject }) => subject).toSorted()).toEqual(["github", "reddit-work"]);
    expect(JSON.parse(await readFile(path, "utf8"))).toEqual({
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
